'use strict';

// Exercise admission against isolated real daemons and disposable Git repos.
// The fixture daemon traces repository inspection; it never contacts a provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { connect } = require('../electron/client.cjs');
const { startRun } = require('../electron/automation-client.cjs');
const automation = require('../electron/backend/task-automation.cjs');

const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('automation admission checks limits before full project inspection', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-admission-'));
  const daemons = [];
  const makeWritable = target => {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) for (const name of fs.readdirSync(target)) makeWritable(path.join(target, name));
    else if (info.isFile()) fs.chmodSync(target, 0o666);
  };
  t.after(async () => {
    for (const daemon of daemons) {
      try { await daemon.client.request('daemon.shutdown'); } catch {}
      daemon.client.close();
      if (daemon.child.exitCode === null) {
        let timer;
        await Promise.race([daemon.exited, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]);
        clearTimeout(timer);
        if (daemon.child.exitCode === null) { daemon.child.kill(); await daemon.exited; }
      }
    }
    for (const name of ['existing', 'new', 'conflict']) {
      const objects = path.join(base, name, '.git', 'objects');
      if (fs.existsSync(objects)) makeWritable(objects);
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  });
  function repository(name, files = {}) {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(dir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    }
    for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-m', 'init']]) {
      execFileSync('git', ['-C', dir, ...args], { windowsHide: true, stdio: 'ignore' });
    }
    return dir;
  }
  const existing = repository('existing');
  const other = repository('new');
  const linked = path.join(base, 'linked-existing');
  execFileSync('git', ['-C', existing, 'worktree', 'add', '-b', 'fixture-linked', linked, 'main'], { windowsHide: true, stdio: 'ignore' });
  const conflict = repository('conflict', {
    '.pi/extensions/winmux-status.ts': '// foreign Pi extension\n',
    '.omp/extensions/winmux-status.ts': '// foreign OMP extension\n',
  });
  const project = { id: 'existing-project', name: 'existing', root: existing,
    commonDir: fs.realpathSync(path.join(existing, '.git')), profileId: 'powershell', primaryBranch: 'main' };
  const spec = (directory, runId = randomUUID(), prompt = 'Inspect this fixture.') => ({
    runId, projectDirectory: directory, name: 'Admission fixture', profileId: 'powershell', agentId: 'codex', baseBranch: 'main', prompt,
  });
  const state = (projects, tasks) => ({ version: 3, state: {
    workspaces: [], projects, tasks, notifications: [], settings: { fontSize: 14, theme: 'dark' },
  } });
  async function startFixture(name, saved, extraEnv = {}) {
    const dataDir = path.join(base, `data-${name}`), fixtureDir = path.join(base, `fixture-${name}`);
    fs.mkdirSync(dataDir); fs.mkdirSync(fixtureDir);
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(saved));
    // Ordinary launches use a real harmless child that records its own start;
    // automation failures under test never reach this executable.
    fs.writeFileSync(path.join(fixtureDir, 'automation-agent.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(process.env.WINMUX_DATA_DIR, 'automation');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'capture-' + process.env.WINMUX_TASK_ID + '.json'), JSON.stringify({ pid: process.pid }));
`);
    const hermesHome = path.join(fixtureDir, 'hermes-home'); fs.mkdirSync(hermesHome);
    const pipeName = `\\\\.\\pipe\\winmux-admission-${randomUUID()}`;
    const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName, WINMUX_FIXTURE_DIR: fixtureDir,
      WINMUX_FIXTURE_NODE: process.execPath, WINMUX_FIXTURE_INSPECT_TRACE: '1', WINMUX_NO_PROFILE: '1', HERMES_HOME: hermesHome, ...extraEnv };
    for (const key of ['WINMUX_PANE_ID', 'WINMUX_AGENT_LAUNCH_ID', 'WINMUX_TASK_ID', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    const child = spawn(process.execPath, [path.join(root, 'tests', 'automation-smoke.cjs'), '--fixture-daemon'], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const deadline = Date.now() + 60000;
    let client;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Fixture daemon exited: ${logs}`);
      try { client = await connect({ dataDir, pipeName, connectTimeout: 300 }); break; } catch { await delay(100); }
    }
    if (!client) { child.kill(); await exited; throw new Error(`Fixture daemon did not start: ${logs}`); }
    const daemon = { child, client, exited, dataDir, fixtureDir, pipeName };
    daemons.push(daemon);
    return daemon;
  }
  const count = (daemon, method) => {
    const file = path.join(daemon.fixtureDir, `${method}.trace`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
  };
  const projects = [project, ...Array.from({ length: 1023 }, (_, index) => ({
    ...project, id: `filler-project-${index}`, name: `filler-${index}`,
    root: path.join(base, `missing-${index}`), commonDir: path.join(base, `missing-${index}`, '.git'),
  }))];
  const projectLimit = await startFixture('projects', state(projects, []));
  const projectConnection = { dataDir: projectLimit.dataDir, pipeName: projectLimit.pipeName };
  const rejected = spec(other);
  await assert.rejects(startRun(projectConnection, rejected), { code: 'LIMIT_REACHED' });
  let snapshot = await projectLimit.client.request('state');
  assert.equal(snapshot.projects.length, 1024);
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(fs.existsSync(path.join(base, 'new.winmux-worktrees', rejected.runId)), false);
  assert.equal(count(projectLimit, 'inspectRepository'), 1, 'resolve Git identity once to decide whether the project exists');
  assert.equal(count(projectLimit, 'listBranches'), 0, 'a new project at the limit never reaches full project inspection');
  assert.equal(count(projectLimit, 'listWorktrees'), 0);

  const admitted = spec(linked, randomUUID(), 'x'.repeat(16000));
  const retained = await startRun(projectConnection, admitted);
  assert.equal(retained.status, 'failed');
  assert.equal(retained.code, 'AGENT_LAUNCH_TOO_LARGE');
  snapshot = await projectLimit.client.request('state');
  assert.equal(snapshot.projects.length, 1024, 'a linked worktree of an existing project remains admissible at the project limit');
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(count(projectLimit, 'inspectRepository'), 2, 'reuse the preflight Git identity during full inspection');
  assert.equal(count(projectLimit, 'listBranches'), 1);
  assert.equal(count(projectLimit, 'listWorktrees'), 1);

  const ordinaryId = randomUUID(), completedSpec = spec(existing);
  const completed = automation.createRecord(automation.requestHash(completedSpec), 1000);
  automation.applyEvidence(completed, { channel: 'session', event: 'UserPromptSubmit', state: 'running', sessionId: 's', at: 2000 }, {});
  automation.applyEvidence(completed, { channel: 'session', event: 'Stop', state: 'completed', sessionId: 's', at: 3000 }, {});
  const tasks = Array.from({ length: 4096 }, (_, index) => ({
    id: index === 0 ? ordinaryId : index === 1 ? completedSpec.runId : `filler-task-${index}`,
    name: 'Existing task', projectId: project.id, cwd: path.join(base, `task-${index}`), branch: `fixture-${index}`,
    base: 'main', agentId: 'codex', managed: false, archived: true, phase: 'ready',
    ...(index === 1 ? { automation: completed } : {}),
  }));
  const taskLimit = await startFixture('tasks', state([project], tasks));
  const taskConnection = { dataDir: taskLimit.dataDir, pipeName: taskLimit.pipeName };
  assert.equal((await startRun(taskConnection, completedSpec)).status, 'completed', 'an idempotent repeat remains available at the task limit');
  await assert.rejects(startRun(taskConnection, spec(existing, ordinaryId)), { code: 'RUN_CONFLICT' });
  await assert.rejects(startRun(taskConnection, spec(existing)), { code: 'LIMIT_REACHED' });
  assert.equal(count(taskLimit, 'inspectRepository'), 0, 'task limit and ID collisions are checked before Git inspection');
  snapshot = await taskLimit.client.request('state');
  assert.equal(snapshot.tasks.length, 4096);
  assert.equal(snapshot.projects.length, 1);

  const oldShell = await startFixture('legacy-shell', state([], []), { WINMUX_FIXTURE_LEGACY_PS: '1' });
  const oldConnection = { dataDir: oldShell.dataDir, pipeName: oldShell.pipeName };
  const oldRun = { ...spec(existing), agentId: 'pi' };
  await assert.rejects(startRun(oldConnection, oldRun), { code: 'AGENT_HOOKS_UNSUPPORTED' });
  snapshot = await oldShell.client.request('state');
  assert.deepEqual(snapshot.projects, []);
  assert.deepEqual(snapshot.tasks, []);
  assert.equal(fs.existsSync(path.join(base, 'existing.winmux-worktrees', oldRun.runId)), false);

  const hookDaemon = await startFixture('hook-conflict', state([], []));
  const hookConnection = { dataDir: hookDaemon.dataDir, pipeName: hookDaemon.pipeName };
  const pluginDir = path.join(hookDaemon.fixtureDir, 'hermes-home', 'plugins', 'winmux-status');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), 'name: another-plugin\n');
  for (const agentId of ['pi', 'omp', 'hermes']) {
    const request = { ...spec(conflict), agentId };
    const failed = await startRun(hookConnection, request);
    assert.equal(failed.status, 'failed', `${agentId}: hook conflict must not launch untracked automation`);
    assert.equal(failed.code, 'CONFIG_CONFLICT');
    assert.equal(failed.workspaceId, null);
    assert.equal(fs.existsSync(path.join(base, 'conflict.winmux-worktrees', request.runId)), true);
    assert.equal(fs.existsSync(path.join(hookDaemon.dataDir, 'automation', `capture-${request.runId}.json`)), false);
  }
  // Ordinary task launches retain their existing warn-and-continue behavior.
  const workspace = await hookDaemon.client.request('task.create', { projectDirectory: conflict, name: 'Ordinary task',
    profileId: 'powershell', agentId: 'pi', baseBranch: 'main', mode: 'new', agentHooks: true });
  snapshot = await hookDaemon.client.request('state');
  const task = snapshot.tasks.find(item => item.workspaceId === workspace.id);
  assert.ok(task);
  const captured = path.join(hookDaemon.dataDir, 'automation', `capture-${task.id}.json`);
  const captureDeadline = Date.now() + 30000;
  while (!fs.existsSync(captured) && Date.now() < captureDeadline) await delay(100);
  assert.equal(fs.existsSync(captured), true, 'ordinary launch proceeds despite the hook conflict');
  await hookDaemon.client.request('workspace.close', { workspaceId: workspace.id });
});
