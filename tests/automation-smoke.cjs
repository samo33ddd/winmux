'use strict';
// Real isolated daemon + ConPTY + Git worktrees. Fixture executables replace the
// installed agents; lifecycle evidence travels through the real generated session
// hook commands and the installed project helpers. No provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { connect } = require('../electron/client.cjs');
const { startRun, getRun, waitForRun } = require('../electron/automation-client.cjs');
const { installSkills } = require('../electron/skills-install.cjs');
const { windowsProcessTable } = require('../electron/codex-integration.cjs');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const AGENT_IDS = ['codex', 'claude', 'omp', 'pi', 'hermes'];

if (process.argv.includes('--fixture-daemon')) {
  const fixtureDir = process.env.WINMUX_FIXTURE_DIR;
  const localAppData = path.join(fixtureDir, 'localappdata');
  // omp is identified by its exact native install path, so the catalog root is
  // supplied by the fixture rather than the contributor's real profile.
  process.env.LOCALAPPDATA = localAppData;
  const pty = require('node-pty');
  const realSpawn = pty.spawn;
  pty.spawn = (...args) => {
    const marker = path.join(fixtureDir, 'fail-next-spawn');
    if (fs.existsSync(marker)) {
      fs.unlinkSync(marker);
      throw new Error('Fixture PTY spawn failure');
    }
    return realSpawn(...args);
  };
  if (process.env.WINMUX_FIXTURE_INSPECT_TRACE === '1') {
    const taskGit = require('../electron/backend/task-git.cjs');
    const createService = taskGit.createTaskGitService;
    taskGit.createTaskGitService = (...args) => {
      const service = createService(...args);
      const traced = { ...service };
      for (const method of ['inspectRepository', 'listBranches', 'listWorktrees']) {
        const original = service[method];
        traced[method] = (...params) => {
          fs.appendFileSync(path.join(fixtureDir, `${method}.trace`), '1');
          return original(...params);
        };
      }
      return traced;
    };
  }
  // Hold only the requested terminal fence, so lifecycle RPCs can run while
  // a real screen read is in flight. All other terminal writes stay unchanged.
  const { Terminal } = require('@xterm/headless');
  const realWrite = Terminal.prototype.write;
  Terminal.prototype.write = function(data, callback) {
    const control = path.join(fixtureDir, 'hold-fence.json');
    if (data === '' && fs.existsSync(control)) {
      const request = JSON.parse(fs.readFileSync(control, 'utf8'));
      const buffer = this.buffer.active;
      const text = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || '').join('\n');
      if (text.includes(request.marker)) {
        fs.unlinkSync(control);
        fs.writeFileSync(request.ready, '1');
        const terminal = this;
        const timer = setInterval(() => {
          if (!fs.existsSync(request.release)) return;
          clearInterval(timer);
          realWrite.call(terminal, data, callback);
        }, 20);
        timer.unref();
        return;
      }
    }
    return realWrite.call(this, data, callback);
  };
  const discovery = require('../electron/backend/environment.cjs');
  const realDiscover = discovery.discover;
  const nodeExe = process.env.WINMUX_FIXTURE_NODE;
  const script = path.join(fixtureDir, 'automation-agent.cjs');
  const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
  // A PowerShell wrapper, not node.exe directly: every adapter's final argv is
  // positional, and OMP prefixes a `launch` subcommand that node would otherwise
  // read as its script path.
  const wrapperFor = id => {
    const file = path.join(fixtureDir, `agent-${id}.ps1`);
    fs.writeFileSync(file, `& ${psQuote(nodeExe)} ${psQuote(script)} ${psQuote(id)} @args\r\n`);
    return file;
  };
  // Paths that classify as each supported agent without any installed binary.
  const identity = {
    codex: path.join(fixtureDir, 'ident', 'codex.exe'),
    claude: path.join(fixtureDir, 'ident', 'claude.exe'),
    omp: path.join(localAppData, 'omp', 'omp.exe'),
    pi: path.join(fixtureDir, 'ident', 'pi.exe'),
    hermes: path.join(fixtureDir, 'ident', 'AppData', 'Local', 'hermes', 'bin', 'hermes.exe'),
  };
  const overrides = () => {
    try { return JSON.parse(fs.readFileSync(path.join(fixtureDir, 'identity.json'), 'utf8')); } catch { return {}; }
  };
  // Injected process rows: the real fixture agent process is reported under the
  // identity of the adapter it stands in for, so the tree walk classifies exactly
  // one agent per pane without any installed binary.
  async function listProcesses() {
    if (fs.existsSync(path.join(fixtureDir, 'fail-process-scan'))) {
      fs.writeFileSync(path.join(fixtureDir, 'failed-process-scan-observed'), '1');
      throw new Error('Fixture process scan failure');
    }
    const omittedPidFile = path.join(fixtureDir, 'omit-process-pid');
    const omittedPid = fs.existsSync(omittedPidFile) ? Number(fs.readFileSync(omittedPidFile, 'utf8')) : null;
    const table = await windowsProcessTable();
    const markers = overrides();
    const rows = [];
    let omitted = false;
    for (const row of table) {
      if (row.pid === omittedPid) { omitted = true; continue; }
      const match = /automation-agent\.cjs"?\s+(codex|claude|omp|pi|hermes)\b/.exec(row.commandLine || '');
      if (!match) { rows.push(row); continue; }
      rows.push({ ...row, executable: identity[match[1]], createdAt: markers[match[1]] || row.createdAt,
        processIdentity: markers[match[1]] && row.processIdentity ? (BigInt(row.processIdentity) + 1n).toString() : row.processIdentity });
    }
    if (omitted) fs.writeFileSync(path.join(fixtureDir, 'omitted-process-observed'), String(omittedPid));
    return rows;
  }
  discovery.discover = async () => {
    const environment = await realDiscover();
    environment.profiles = environment.profiles.filter(profile => profile.environment === 'windows');
    if (process.env.WINMUX_FIXTURE_LEGACY_PS === '1') {
      const powershell = environment.profiles.find(profile => profile.id === 'powershell');
      powershell.command = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    }
    environment.profiles.push({ id: 'wsl:Fixture', label: 'Fixture', environment: 'wsl', command: 'wsl.exe', args: ['--distribution', 'Fixture'], distro: 'Fixture', running: false });
    environment.agents = AGENT_IDS.map(id => ({
      id, label: id, environment: 'windows', profileId: 'powershell', available: true,
      command: wrapperFor(id), args: [],
      ...(['codex', 'claude'].includes(id) ? { hookAdapter: id } : {}),
    }));
    environment.agents.push({ id: 'wsl:Fixture:codex', label: 'Codex', environment: 'wsl', profileId: 'wsl:Fixture', distro: 'Fixture', available: null, command: null, hookAdapter: 'codex' });
    return environment;
  };
  require('../electron/backend.cjs').startServer({ codex: { listProcesses, intervalMs: 1500 } }).then(daemon => {
    daemon.server.once('close', () => setTimeout(() => process.exit(0), 150).unref());
    console.log('FIXTURE_DAEMON_READY');
  }).catch(error => { console.error(error); process.exit(1); });
} else {
  // A plain directory: the project-hook installer rejects a junctioned root, so a
  // relocated profile directory must not be used for this fixture.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-automation-'));
  const dataDir = path.join(base, 'data');
  const fixtureDir = path.join(base, 'fixture');
  const project = path.join(base, 'project');
  const automation = path.join(dataDir, 'automation');
  for (const dir of [dataDir, fixtureDir, project, automation, path.join(fixtureDir, 'ident')]) fs.mkdirSync(dir, { recursive: true });
  const nodeExe = (() => {
    const found = spawnSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/)
      .map(value => value.trim()).filter(value => /\.exe$/i.test(value) && fs.existsSync(value));
    assert.ok(found.length, 'A native node.exe is required for the fixture agents');
    return found[0];
  })();
  fs.writeFileSync(path.join(project, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', project, 'init', '-b', 'main'], { windowsHide: true });
  execFileSync('git', ['-C', project, 'add', '.'], { windowsHide: true });
  execFileSync('git', ['-C', project, '-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-m', 'init'], { windowsHide: true });

  fs.writeFileSync(path.join(fixtureDir, 'automation-agent.cjs'), String.raw`
'use strict';
// Fixture agent: records its own argv, prints a marker and emits lifecycle
// evidence through the real generated hook command or the installed helper.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dataDir = process.env.WINMUX_DATA_DIR, taskId = process.env.WINMUX_TASK_ID || '';
// The wrapper supplies the adapter id, so the remaining vector is exactly what
// the launcher produced for that adapter.
const agentId = process.argv[2], args = process.argv.slice(3);
const creation = ['omp', 'pi', 'hermes'].includes(agentId)
  ? spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process -Id ' + process.pid + ').StartTime.ToUniversalTime().Ticks.ToString()'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  : null;
const processIdentity = creation?.stdout.trim();
if (creation && (creation.status !== 0 || !/^\d{1,20}$/.test(processIdentity))) process.exit(2);
const dir = path.join(dataDir, 'automation');
fs.mkdirSync(dir, { recursive: true });
const name = taskId || 'unbound';
fs.writeFileSync(path.join(dir, 'capture-' + name + '.json'), JSON.stringify({
  agentId, args, taskId, paneId: process.env.WINMUX_PANE_ID, launchId: process.env.WINMUX_AGENT_LAUNCH_ID || '',
  cwd: process.cwd(), pid: process.pid, electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === undefined ? null : 'set',
}));
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let plan = null;
for (let attempt = 0; attempt < 200 && !plan; attempt++) {
  try { plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan-' + name + '.json'), 'utf8')); } catch { wait(100); }
}
plan ||= { steps: [] };
const cwd = plan.gateway ? plan.gateway.cwd : process.cwd();
const sessionId = plan.gateway ? plan.gateway.sessionId : plan.sessionId;
const encodedCommand = event => {
  if (agentId === 'claude') {
    const index = args.indexOf('--settings');
    const command = JSON.parse(args[index + 1]).hooks[event][0].hooks[0].command;
    return command.slice(command.indexOf('-EncodedCommand ') + '-EncodedCommand '.length).trim();
  }
  // Codex passes each hook layer as two arguments: '-c' and 'hooks.X=[...]'.
  const arg = args.find(value => value.startsWith('hooks.' + event + '='));
  const command = JSON.parse(/commandWindows=("(?:[^"\\]|\\.)*")/.exec(arg)[1]);
  return command.slice(command.indexOf('-EncodedCommand ') + '-EncodedCommand '.length).trim();
};
// Build the exact delivery command so a detached stopper can replay it later.
const delivery = (event, state, foreignIdentity = false) => {
  if (agentId === 'codex' || agentId === 'claude') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(event)],
      input: JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd }) };
  }
  const helper = path.join(dataDir, 'hooks', agentId === 'omp' ? 'winmux-omp-hook.cjs' : 'winmux-agent-event.cjs');
  return { file: process.env.WINMUX_AGENT_NODE || process.execPath, args: [helper, '--data-dir', dataDir, '--pipe', process.env.WINMUX_PIPE_NAME],
    input: JSON.stringify({ agentId, event, sessionId, cwd, pid: plan.gateway ? plan.gateway.pid || process.pid : process.pid, stamp: process.hrtime.bigint().toString(), state,
      processIdentity: foreignIdentity ? (BigInt(processIdentity) + 1n).toString() : processIdentity }) };
};
const deliver = (event, state, command = delivery(event, state)) => {
  const result = spawnSync(command.file, command.args, { input: command.input, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) fs.writeFileSync(path.join(dir, 'delivery-error-' + name + '.json'), JSON.stringify({ event, state, status: result.status, stderr: result.stderr }));
};
const prepared = new Map();
process.stdout.write('AUTOMATION_AGENT_READY ' + name + '\r\n');
for (const step of plan.steps || []) {
  if (step.waitMs) wait(step.waitMs);
  if (step.waitForFile) {
    const deadline = Date.now() + 45000;
    while (!fs.existsSync(path.join(dir, step.waitForFile)) && Date.now() < deadline) wait(50);
    if (!fs.existsSync(path.join(dir, step.waitForFile))) process.exit(1);
  }
  if (step.marker) process.stdout.write(step.marker + '\r\n');
  if (step.exitEvidence) process.stdout.write('\x1b]1337;WinmuxAgent;' + process.env.WINMUX_AGENT_LAUNCH_ID + ';completed;0\x07');
  if (step.prepareEvents) {
    for (const item of step.prepareEvents) prepared.set(item.event, delivery(item.event, item.state, item.foreignIdentity));
  }
  if (step.preparedEvent) {
    const command = prepared.get(step.preparedEvent);
    if (!command) process.exit(1);
    deliver(step.preparedEvent, step.state, command);
  }
  if (step.event) deliver(step.event, step.state || 'running');
  if (step.signalFile) fs.writeFileSync(path.join(dir, step.signalFile), '1');
  if (step.exit !== undefined) {
    if (step.late) {
      const file = path.join(dir, 'stop-' + name + '.json');
      fs.writeFileSync(file, JSON.stringify({ delayMs: step.late.delayMs, command: delivery(step.late.event, step.late.state) }));
      spawn(process.execPath, [path.join(__dirname, 'automation-stopper.cjs'), file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    process.exit(step.exit);
  }
}
setInterval(() => { if (fs.existsSync(path.join(dir, 'release-' + name))) process.exit(0); }, 100);
`);
  fs.writeFileSync(path.join(fixtureDir, 'automation-stopper.cjs'), String.raw`
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const stop = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stop.delayMs);
spawnSync(stop.command.file, stop.command.args, { input: stop.command.input, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
`);
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\winmux-automation-${randomUUID()}` : path.join(dataDir, 'ipc.sock');
  const options = { dataDir, pipeName };
  // The Hermes project plugin installs into a profile directory. Own it here so
  // the fixture never depends on a developer machine having Hermes configured.
  const hermesHome = path.join(fixtureDir, 'hermes-home');
  fs.mkdirSync(hermesHome, { recursive: true });
  const daemonEnv = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName, WINMUX_FIXTURE_DIR: fixtureDir,
    WINMUX_FIXTURE_NODE: nodeExe, WINMUX_NO_PROFILE: '1', HERMES_HOME: hermesHome };
  for (const key of ['WINMUX_PANE_ID', 'WINMUX_AGENT_LAUNCH_ID', 'WINMUX_TASK_ID', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER']) delete daemonEnv[key];
  let daemon, client, logs = '';
  async function eventually(action, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await action(); if (value) return value; await sleep(100); }
    throw new Error(`Timed out: ${label}\n${logs.slice(-4000)}`);
  }
  async function launch() {
    daemon = spawn(nodeExe, [__filename, '--fixture-daemon'], { cwd: root, env: daemonEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout.on('data', data => { logs += data; });
    daemon.stderr.on('data', data => { logs += data; });
    await eventually(async () => {
      if (daemon.exitCode !== null) throw new Error(`Daemon exited ${daemon.exitCode}: ${logs}`);
      try { client = await connect({ ...options, connectTimeout: 300 }); return true; } catch { return false; }
    }, 'daemon startup', 60000);
  }
  async function stop() {
    const running = daemon && daemon.exitCode === null ? daemon : null;
    try { if (client && running) await client.request('daemon.shutdown'); } catch {}
    client?.close(); client = null;
    if (!running) { daemon = null; return; }
    // A graceful shutdown disposes the panes; a kill is only the fallback.
    const deadline = Date.now() + 8000;
    while (running.exitCode === null && Date.now() < deadline) await sleep(100);
    if (running.exitCode === null) { try { running.kill(); } catch {} }
    await sleep(200);
    daemon = null;
  }
  const writePlan = (name, value) => fs.writeFileSync(path.join(automation, `plan-${name}.json`), JSON.stringify(value));
  const spec = (overrides = {}) => ({ runId: randomUUID(), projectDirectory: project, name: 'Automation run', profileId: 'powershell',
    agentId: 'codex', baseBranch: 'main', prompt: 'Describe the fixture entrypoint. Do not modify files or call tools.', ...overrides });
  const state = () => client.request('state');
  // The daemon resolves the repository to its real path, which can differ from
  // the requested directory, so the retained worktree is read from the run itself.
  const worktreeCount = cwd => {
    const parent = path.dirname(cwd);
    return fs.existsSync(parent) ? fs.readdirSync(parent).filter(name => name === path.basename(cwd)).length : 0;
  };
  const capture = name => { try { return JSON.parse(fs.readFileSync(path.join(automation, `capture-${name}.json`), 'utf8')); } catch { return null; } };
  const captureFor = name => eventually(() => capture(name), `capture ${name}`);
  const paneOf = async paneId => (await state()).workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneId);
  // Signal only after the real CLI has received its first run metadata reply.
  // The wrapper observes the transport and does not change requests or responses.
  const waitObserver = path.join(fixtureDir, 'observe-wait.cjs');
  fs.writeFileSync(waitObserver, `
const fs = require('node:fs');
const client = require(${JSON.stringify(path.join(root, 'electron', 'client.cjs'))});
const connect = client.connect;
client.connect = async (...args) => {
  const connection = await connect(...args);
  const request = connection.request.bind(connection);
  connection.request = async (method, ...params) => {
    const result = await request(method, ...params);
    if (method === 'task.run.get') fs.writeFileSync(process.env.WINMUX_FIXTURE_WAIT_READY, '1');
    return result;
  };
  return connection;
};
`);
  const observedWaiters = new Set();
  function observedCliWait(runId, afterRevision) {
    const readyFile = path.join(automation, `wait-ready-${randomUUID()}`);
    const child = spawn(nodeExe, ['--require', waitObserver, path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName,
      'run-wait', runId, '--after', String(afterRevision), '--timeout', '120000'], {
      env: { ...daemonEnv, WINMUX_FIXTURE_WAIT_READY: readyFile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    observedWaiters.add(child);
    const closed = once(child, 'close').then(([code, signal]) => {
      observedWaiters.delete(child);
      return { code, signal, stdout, stderr };
    });
    return { child, closed, readyFile };
  }
  // The private run record is read from the isolated daemon's own state file:
  // it must stay invisible in every public surface.
  const privateExit = runId => {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
      return saved.state.tasks.find(task => task.id === runId)?.automation?.exit || null;
    } catch { return null; }
  };
  const taskPanes = async runId => {
    const snapshot = await state();
    const task = snapshot.tasks.find(item => item.id === runId);
    return snapshot.workspaces.find(item => item.id === task?.workspaceId)?.panes.map(pane => pane.id) || [];
  };
  // A run that has not accepted or ended yet, for measuring a private state.
  const acceptedOrTerminal = async runId => {
    const current = (await getRun(options, runId)).run;
    return current.acceptedAt !== null || ['completed', 'failed', 'interrupted'].includes(current.status);
  };

  async function main() {
    await launch();
    assert.equal((await client.request('environment')).capabilities.automationRuns, true);

    // --- one run per new task, for every adapter -----------------------------
    for (const agentId of AGENT_IDS) {
      const runSpec = spec({ agentId });
      const submit = ['codex', 'claude'].includes(agentId) ? 'UserPromptSubmit' : 'agent_start';
      writePlan(runSpec.runId, { sessionId: `session-${agentId}`, steps: [
        { waitMs: 150, event: submit, state: 'running' },
        { marker: `MARKER_${agentId}` },
        { waitMs: 250, event: agentId === 'codex' || agentId === 'claude' ? 'Stop' : 'agent_end', state: 'completed' },
      ] });
      const started = await startRun(options, runSpec);
      assert.equal(started.runId, runSpec.runId);
      assert.equal(started.agentId, agentId);
      assert.ok(started.workspaceId && started.paneId, `${agentId}: a started run reports its workspace and pane: ${JSON.stringify(started)}`);
      const captured = await captureFor(runSpec.runId);
      assert.equal(captured.taskId, runSpec.runId, `${agentId}: the task context reaches the pane`);
      assert.equal(captured.electronRunAsNode, null, `${agentId}: the pane shell never inherits Electron Node mode`);
      const ending = agentId === 'hermes' ? [`--query=${runSpec.prompt}`] : ['--', runSpec.prompt];
      assert.deepEqual(captured.args.slice(-ending.length), ending, `${agentId}: the initial prompt is one literal argument`);
      if (agentId === 'omp') assert.equal(captured.args[0], 'launch', 'OMP launches its interactive subcommand');
      if (agentId === 'hermes') assert.equal(captured.args[0], 'chat', 'Hermes launches its chat subcommand');
      if (agentId !== 'hermes') assert.equal(captured.args.filter(value => value === runSpec.prompt).length, 1, `${agentId}: the prompt appears once`);
      if (['claude', 'omp'].includes(agentId)) {
        // The task-delivery instruction keeps its own argument and does not consume the prompt.
        assert.ok(captured.args.join('\n').includes(runSpec.runId), `${agentId}: the launch carries the task instruction`);
      }
      const result = await waitForRun(options, runSpec.runId, { timeoutMs: 180000 });
      assert.equal(result.reason, 'completed', `${agentId}: ${JSON.stringify(result.run)}\n${logs.slice(-3000)}`);
      assert.ok(result.run.finishedAt, `${agentId}: a terminal run has a finish timestamp`);
      assert.ok(result.screen, `${agentId}: a completed run returns a bounded terminal view`);
      assert.match(result.screen.text, /MARKER_/, `${agentId}: the marker is visible in the terminal view`);
      assert.ok(result.run.revision >= 3, `${agentId}: acceptance and completion each advance the revision`);
      assert.equal(worktreeCount(result.run.cwd), 1, `${agentId}: exactly one worktree`);
      assert.equal(path.basename(result.run.cwd), runSpec.runId, `${agentId}: the worktree is named by the run`);
      assert.deepEqual(await taskPanes(runSpec.runId), [started.paneId], `${agentId}: exactly one agent pane`);
      const snapshot = await state();
      for (const task of snapshot.tasks) {
        assert.equal(Object.hasOwn(task, 'automation'), false, 'public state must not expose the automation record');
        assert.equal(JSON.stringify(task).includes('Describe the fixture entrypoint'), false, 'public state must not expose the prompt');
      }
      console.log(`PASS ${agentId}: start, one worktree, confirmed completion, bounded screen`);
    }

    // --- idempotent repeat, conflict and pre-mutation rejections ------------
    const repeatSpec = spec({ agentId: 'pi' });
    writePlan(repeatSpec.runId, { sessionId: 'repeat', steps: [{ event: 'agent_start', state: 'running' }, { marker: 'MARKER_REPEAT' }, { waitMs: 200, event: 'agent_end', state: 'completed' }] });
    const [first, second] = await Promise.all([startRun(options, repeatSpec), startRun(options, repeatSpec)]);
    assert.equal(first.runId, second.runId);
    await waitForRun(options, repeatSpec.runId, { timeoutMs: 180000 });
    assert.equal(worktreeCount((await getRun(options, repeatSpec.runId)).run.cwd), 1, 'a concurrent repeat creates one worktree');
    assert.ok(capture(repeatSpec.runId), 'the repeated start launched once');
    await assert.rejects(startRun(options, { ...repeatSpec, prompt: 'A different request.' }), { code: 'RUN_CONFLICT' });
    const beforeRejection = await state();
    const piRejection = spec({ agentId: 'pi', prompt: '@notes.md summarize' });
    const wslRejection = spec({ profileId: 'wsl:Fixture' });
    for (const [request, code] of [[piRejection, 'INVALID_AUTOMATION_PROMPT'], [wslRejection, 'UNSUPPORTED_ENVIRONMENT']]) {
      const target = path.join(path.dirname(project), `${path.basename(project)}.winmux-worktrees`, request.runId);
      assert.equal(fs.existsSync(target), false);
      await assert.rejects(startRun(options, request), { code });
      const afterRejection = await state();
      assert.deepEqual(afterRejection.projects, beforeRejection.projects, `${code}: projects remain unchanged`);
      assert.deepEqual(afterRejection.tasks, beforeRejection.tasks, `${code}: tasks remain unchanged`);
      assert.equal(fs.existsSync(target), false, `${code}: no target worktree`);
      assert.equal(capture(request.runId), null, `${code}: no agent was launched`);
    }
    await assert.rejects(startRun(options, spec({ mode: 'attach' })), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(getRun(options, randomUUID()), { code: 'RUN_NOT_FOUND' });
    console.log('PASS repeat, conflict, WSL and Pi rejection');

    // --- the prompt survives shell metacharacters as one argument -----------
    const nasty = 'Keep "quotes" and `backticks` and $(touch should-not-exist) and --help and models\nsecond line — Ж漢';
    for (const agentId of AGENT_IDS) {
      const nastySpec = spec({ agentId, prompt: nasty });
      const sessionHook = ['codex', 'claude'].includes(agentId);
      writePlan(nastySpec.runId, { sessionId: `nasty-${agentId}`, steps: [
        { waitMs: 150, event: sessionHook ? 'UserPromptSubmit' : 'agent_start', state: 'running' },
        { marker: 'MARKER_NASTY' },
        { waitMs: 200, event: sessionHook ? 'Stop' : 'agent_end', state: 'completed' },
      ] });
      const nastyRun = await startRun(options, nastySpec);
      const nastyResult = await waitForRun(options, nastySpec.runId, { timeoutMs: 180000 });
      assert.equal(nastyResult.reason, 'completed', `${agentId}: ${JSON.stringify(nastyResult.run)}`);
      const args = (await captureFor(nastySpec.runId)).args;
      assert.deepEqual(args.slice(agentId === 'hermes' ? -1 : -2), agentId === 'hermes' ? [`--query=${nasty}`] : ['--', nasty], `${agentId}: the prompt is one literal argument`);
      assert.equal(fs.existsSync(path.join(nastyRun.cwd, 'should-not-exist')), false, `${agentId}: no shell side effect in the worktree`);
    }
    assert.equal(fs.existsSync(path.join(project, 'should-not-exist')), false, 'the prompt never became shell source');
    assert.equal(fs.existsSync(path.join(automation, 'should-not-exist')), false);
    console.log('PASS prompt quoting and no shell side effect');

    // --- a command line that cannot fit is a retained failed run -----------
    const huge = spec({ agentId: 'codex', prompt: 'x'.repeat(16000) });
    const hugeRun = await startRun(options, huge);
    assert.equal(hugeRun.status, 'failed');
    assert.equal(hugeRun.code, 'AGENT_LAUNCH_TOO_LARGE');
    assert.equal(hugeRun.workspaceId, null);
    assert.ok((await state()).tasks.some(task => task.id === huge.runId), 'the failed run retains its task');
    assert.equal(worktreeCount(hugeRun.cwd), 1, 'the worktree is retained');
    assert.equal(capture(huge.runId), null, 'the oversized prompt never launched');
    const archivedHuge = await client.request('task.archive', { taskId: huge.runId });
    assert.equal(archivedHuge.archived, true);
    const countAfterArchive = worktreeCount(hugeRun.cwd);
    const hugeRepeat = await startRun(options, huge);
    assert.deepEqual(hugeRepeat, hugeRun, 'archiving retains the idempotent failed run');
    const archivedTasks = (await state()).tasks.filter(task => task.id === huge.runId);
    assert.equal(archivedTasks.length, 1);
    assert.equal(archivedTasks[0].archived, true);
    assert.equal(worktreeCount(hugeRun.cwd), countAfterArchive, 'repeating an archived run creates no worktree');
    assert.equal(capture(huge.runId), null, 'repeating an archived run launches no agent');
    console.log('PASS oversized command line remains an idempotent archived failed run');

    // A failed PTY launch is not a user-closed pane: retain its failure code.
    const failedSpawn = spec({ agentId: 'codex' });
    fs.writeFileSync(path.join(fixtureDir, 'fail-next-spawn'), '1');
    const failedSpawnRun = await startRun(options, failedSpawn);
    assert.equal(failedSpawnRun.status, 'failed');
    assert.equal(failedSpawnRun.code, 'SPAWN_FAILED');
    assert.equal(failedSpawnRun.workspaceId, null);
    assert.equal(failedSpawnRun.paneId, null);
    assert.equal(worktreeCount(failedSpawnRun.cwd), 1);
    assert.equal(capture(failedSpawn.runId), null);
    console.log('PASS PTY spawn failure retains its failed run');

    // --- waiting, unchanged revision, responsive metadata, abort -----------
    const waitSpec = spec({ agentId: 'omp' });
    writePlan(waitSpec.runId, { sessionId: 'waiting', steps: [
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitMs: 150, event: 'tool_approval_requested', state: 'waiting' },
      { marker: 'MARKER_WAITING' },
    ] });
    await startRun(options, waitSpec);
    const waiting = await waitForRun(options, waitSpec.runId, { timeoutMs: 120000 });
    assert.equal(waiting.reason, 'waiting');
    assert.equal(waiting.run.code, 'AGENT_WAITING');
    // The wait returns as soon as the event arrives, so the fixture marker that
    // follows it may still be in flight; the screen is a point-in-time view.
    const waitingScreen = await eventually(async () => {
      const view = await getRun(options, waitSpec.runId, { includeScreen: true });
      return String(view.screen?.text || '').includes('MARKER_WAITING') ? view : false;
    }, 'waiting marker on screen');
    assert.equal(waitingScreen.run.status, 'waiting');
    const unchanged = await waitForRun(options, waitSpec.runId, { afterRevision: waiting.run.revision, timeoutMs: 1500 });
    assert.equal(unchanged.reason, 'timeout');
    assert.equal(unchanged.run.status, 'waiting');
    const pendingWait = waitForRun(options, waitSpec.runId, { afterRevision: waiting.run.revision, timeoutMs: 30000 });
    const startedAt = Date.now();
    const metadata = await getRun(options, waitSpec.runId);
    await state();
    assert.equal(metadata.run.status, 'waiting');
    assert.ok(Date.now() - startedAt < 5000, 'metadata reads do not queue behind an automation wait');
    const controller = new AbortController();
    const aborted = waitForRun(options, waitSpec.runId, { afterRevision: waiting.run.revision, signal: controller.signal, timeoutMs: 30000 });
    controller.abort();
    await assert.rejects(aborted, { code: 'ABORT_ERR' });
    assert.equal((await getRun(options, waitSpec.runId)).run.status, 'waiting', 'aborting a wait never changes the run');
    assert.equal((await paneOf(waiting.run.paneId)).status, 'running', 'aborting a wait never stops the agent');
    fs.writeFileSync(path.join(automation, `release-${waitSpec.runId}`), '1');
    const resumed = await waitForRun(options, waitSpec.runId, { afterRevision: waiting.run.revision, timeoutMs: 60000 });
    assert.ok(['completed', 'failed', 'interrupted', 'waiting'].includes(resumed.reason));
    await pendingWait.catch(() => {});
    console.log('PASS waiting, unchanged revision, responsive metadata and abort');

    // A screen is a point-in-time viewport: completion does not fence output
    // that the still-running agent has not written yet.
    const screenSpec = spec({ agentId: 'claude' });
    const finalMarker = `LATE_${screenSpec.runId}`;
    writePlan(screenSpec.runId, { sessionId: 'viewport', steps: [
      { event: 'UserPromptSubmit', state: 'running' },
      { waitForFile: `draw-${screenSpec.runId}` },
      { marker: '\u001b[?1049h\u001b[2J\u001b[HUNICODE Ж é' },
      { waitForFile: `stop-${screenSpec.runId}` },
      { event: 'Stop', state: 'completed' },
      { waitForFile: `finish-${screenSpec.runId}` },
      { marker: finalMarker },
    ] });
    const screenRun = await startRun(options, screenSpec);
    await captureFor(screenSpec.runId);
    await client.request('pane.resize', { paneId: screenRun.paneId, cols: 50, rows: 8 });
    fs.writeFileSync(path.join(automation, `draw-${screenSpec.runId}`), '1');
    await eventually(async () => {
      const view = await getRun(options, screenSpec.runId, { includeScreen: true });
      return view.screen?.text.includes('UNICODE Ж é');
    }, 'alternate screen rendered');
    fs.writeFileSync(path.join(automation, `stop-${screenSpec.runId}`), '1');
    const firstScreen = await waitForRun(options, screenSpec.runId, { timeoutMs: 120000 });
    assert.equal(firstScreen.reason, 'completed');
    assert.ok(firstScreen.screen);
    assert.equal(firstScreen.screen.cols, 50);
    assert.equal(firstScreen.screen.rows, 8);
    assert.match(firstScreen.screen.text, /UNICODE Ж é/);
    assert.doesNotMatch(firstScreen.screen.text, /AUTOMATION_AGENT_READY/, 'the alternate screen hides primary-screen output');
    assert.equal(firstScreen.screen.text.includes(finalMarker), false, 'the barrier keeps the later marker out of the initial view');
    assert.ok(firstScreen.screen.text.split('\n').length <= firstScreen.screen.rows, 'screen contains at most the reported rows');
    assert.ok(firstScreen.screen.text.split('\n').every(line => line.length <= firstScreen.screen.cols), 'screen lines fit the reported columns');
    fs.writeFileSync(path.join(automation, `finish-${screenSpec.runId}`), '1');
    const laterScreen = await eventually(async () => {
      const view = await getRun(options, screenSpec.runId, { includeScreen: true });
      return view.screen?.text.includes(finalMarker) ? view : false;
    }, 'delayed terminal marker');
    assert.equal(laterScreen.run.status, 'completed');
    assert.equal(laterScreen.run.revision, firstScreen.run.revision, 'later output does not change lifecycle revision');
    fs.writeFileSync(path.join(automation, `release-${screenSpec.runId}`), '1');
    console.log('PASS alternate-screen Unicode viewport and delayed output');

    // Polling clients must not occupy the daemon mutation queue. The second
    // client submits an actual launch-scoped Claude event while the wait is pending.
    const responsiveSpec = spec({ agentId: 'claude' });
    writePlan(responsiveSpec.runId, { sessionId: 'responsive', steps: [
      { event: 'UserPromptSubmit', state: 'running' },
      { waitForFile: `complete-${responsiveSpec.runId}` },
      { event: 'Stop', state: 'completed' },
    ] });
    const responsiveRun = await startRun(options, responsiveSpec);
    const responsiveCapture = await captureFor(responsiveSpec.runId);
    await eventually(async () => (await getRun(options, responsiveSpec.runId)).run.status === 'running', 'responsive run acceptance');
    const responsiveWait = observedCliWait(responsiveSpec.runId, 0);
    await eventually(() => fs.existsSync(responsiveWait.readyFile), 'CLI metadata polling');
    const statusClient = await connect(options);
    try {
      const response = await statusClient.request('agent.status', { paneId: responsiveRun.paneId, launchId: responsiveCapture.launchId,
        state: 'running', event: 'UserPromptSubmit', sessionId: 'responsive' });
      assert.equal(response.state, 'running');
      assert.equal(responsiveWait.child.exitCode, null, 'agent.status responds while the automation wait is pending');
    } finally { statusClient.close(); }
    fs.writeFileSync(path.join(automation, `complete-${responsiveSpec.runId}`), '1');
    const responsiveResult = await responsiveWait.closed;
    assert.equal(responsiveResult.code, 0, responsiveResult.stderr);
    assert.equal(JSON.parse(responsiveResult.stdout).reason, 'completed');
    console.log('PASS concurrent wait and launch-scoped agent.status');

    // The run may finish while xterm is fencing a screen read. The returned
    // metadata must be read after that fence, not captured before the await.
    const fenceSpec = spec({ agentId: 'claude' });
    const fenceMarker = `FENCE_SYNC_${fenceSpec.runId}`;
    writePlan(fenceSpec.runId, { sessionId: 'fence-race', steps: [
      { event: 'UserPromptSubmit', state: 'running' },
      { marker: fenceMarker },
      { waitForFile: `release-${fenceSpec.runId}` },
    ] });
    const fenceRun = await startRun(options, fenceSpec);
    const fenceCapture = await captureFor(fenceSpec.runId);
    await eventually(async () => {
      const view = await getRun(options, fenceSpec.runId, { includeScreen: true });
      return view.run.status === 'running' && view.screen?.text.includes(fenceMarker);
    }, 'fence race preparation');
    const fenceReady = path.join(fixtureDir, 'fence-ready');
    const fenceRelease = path.join(fixtureDir, 'fence-release');
    fs.writeFileSync(path.join(fixtureDir, 'hold-fence.json'), JSON.stringify({ marker: fenceMarker, ready: fenceReady, release: fenceRelease }));
    const inFlightScreen = getRun(options, fenceSpec.runId, { includeScreen: true });
    await eventually(() => fs.existsSync(fenceReady), 'screen fence held');
    await client.request('agent.status', { paneId: fenceRun.paneId, launchId: fenceCapture.launchId,
      state: 'completed', event: 'Stop', sessionId: 'fence-race' });
    fs.writeFileSync(fenceRelease, '1');
    const fenced = await inFlightScreen;
    assert.equal(fenced.run.status, 'completed', 'the screen response includes the status published while its fence was pending');
    assert.match(fenced.screen.text, /FENCE_SYNC_/);
    fs.writeFileSync(path.join(automation, `release-${fenceSpec.runId}`), '1');
    console.log('PASS screen capture returns the latest run status');

    // A pane closed during a held fence loses its original runtime, even if the
    // fence itself eventually reports a timeout rather than a close event.
    const closeFenceSpec = spec({ agentId: 'claude' });
    const closeFenceMarker = `FENCE_CLOSE_${closeFenceSpec.runId}`;
    writePlan(closeFenceSpec.runId, { sessionId: 'fence-close', steps: [
      { event: 'UserPromptSubmit', state: 'running' },
      { marker: closeFenceMarker },
      { waitForFile: `release-${closeFenceSpec.runId}` },
    ] });
    const closeFenceRun = await startRun(options, closeFenceSpec);
    await eventually(async () => {
      const view = await getRun(options, closeFenceSpec.runId, { includeScreen: true });
      return view.run.status === 'running' && view.screen?.text.includes(closeFenceMarker);
    }, 'close-during-fence preparation');
    const closeFenceReady = path.join(fixtureDir, 'close-fence-ready');
    fs.writeFileSync(path.join(fixtureDir, 'hold-fence.json'), JSON.stringify({
      marker: closeFenceMarker, ready: closeFenceReady, release: path.join(fixtureDir, 'never-release-closed-fence'),
    }));
    const closedScreen = getRun(options, closeFenceSpec.runId, { includeScreen: true });
    await eventually(() => fs.existsSync(closeFenceReady), 'closing screen fence held');
    await client.request('pane.close', { paneId: closeFenceRun.paneId });
    const closedView = await closedScreen;
    assert.equal(closedView.run.code, 'PANE_CLOSED');
    assert.equal(closedView.screen, null);
    assert.equal(closedView.screenError, 'RUN_OUTPUT_UNAVAILABLE');
    console.log('PASS closing a pane during capture reports unavailable output');

    // --- the exit race: a late Stop inside the window wins -------------------
    const raceSpec = spec({ agentId: 'claude' });
    writePlan(raceSpec.runId, { sessionId: 'race', steps: [
      { waitMs: 150, event: 'UserPromptSubmit', state: 'running' },
      { marker: 'MARKER_RACE' },
      { exit: 0, late: { delayMs: 6000, event: 'Stop', state: 'completed' } },
    ] });
    await startRun(options, raceSpec);
    await eventually(() => acceptedOrTerminal(raceSpec.runId), 'race acceptance');
    const acceptedRevision = (await getRun(options, raceSpec.runId)).run.revision;
    // While the shell exit is private the public view stays non-terminal.
    await eventually(() => privateExit(raceSpec.runId), 'private exit observation');
    const pendingView = (await getRun(options, raceSpec.runId)).run;
    assert.ok(['starting', 'running', 'waiting'].includes(pendingView.status), `a pending exit is not public: ${pendingView.status}`);
    assert.equal(pendingView.finishedAt, null, 'a pending shell exit publishes no finish time');
    assert.equal(pendingView.revision, acceptedRevision, 'a pending shell exit does not move the revision');
    const raceWait = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName,
      'run-wait', raceSpec.runId, '--timeout', '120000'], { encoding: 'utf8', windowsHide: true, timeout: 140000 });
    assert.equal(raceWait.status, 0, raceWait.stderr || raceWait.stdout);
    assert.equal(JSON.parse(raceWait.stdout).reason, 'completed');
    const settled = await waitForRun(options, raceSpec.runId, { timeoutMs: 120000 });
    assert.equal(settled.reason, 'completed', `a late Stop inside the drain window completes the run: ${JSON.stringify(settled.run)}`);
    console.log('PASS exit race resolves from in-window evidence');

    // --- an exit with no evidence publishes one bounded outcome -------------
    const silentExit = spec({ agentId: 'codex' });
    writePlan(silentExit.runId, { sessionId: 'silent-exit', steps: [
      { waitMs: 150, event: 'UserPromptSubmit', state: 'running' },
      { marker: 'MARKER_SILENT' },
      { exit: 3 },
    ] });
    await startRun(options, silentExit);
    await eventually(() => acceptedOrTerminal(silentExit.runId), 'silent acceptance');
    const silentRevision = (await getRun(options, silentExit.runId)).run.revision;
    const observed = await eventually(() => privateExit(silentExit.runId), 'silent exit observation', 45000);
    assert.ok(observed.observedAt > 0);
    const provisional = (await getRun(options, silentExit.runId)).run;
    assert.ok(['starting', 'running'].includes(provisional.status), `a private exit is not public: ${provisional.status}`);
    assert.equal(provisional.revision, silentRevision, 'a pending shell exit does not move the revision');
    const silentWait = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName,
      'run-wait', silentExit.runId, '--timeout', '120000'], { encoding: 'utf8', windowsHide: true, timeout: 140000 });
    assert.equal(silentWait.status, 3, silentWait.stderr || silentWait.stdout);
    assert.equal(JSON.parse(silentWait.stdout).run.code, 'AGENT_EXITED');
    const expiredRun = await waitForRun(options, silentExit.runId, { timeoutMs: 120000 });
    assert.equal(expiredRun.reason, 'failed');
    assert.equal(expiredRun.run.code, 'AGENT_EXITED');
    console.log('PASS unresolved exit publishes after the drain window');

    // A failed process-table read is not proof that the agent exited. A
    // successful scan that briefly omits the process retains its identity and
    // does not invent a shell exit.
    const scanSpec = spec({ agentId: 'omp' });
    writePlan(scanSpec.runId, { sessionId: 'scan-recovery', steps: [
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitForFile: `finish-${scanSpec.runId}` },
      { event: 'agent_end', state: 'completed' },
    ] });
    const scanRun = await startRun(options, scanSpec);
    const scanCapture = await captureFor(scanSpec.runId);
    await eventually(async () => (await getRun(options, scanSpec.runId)).run.status === 'running', 'scan recovery acceptance');
    await eventually(async () => (await paneOf(scanRun.paneId))?.agentPid === scanCapture.pid, 'tracked scan identity');
    const failScan = path.join(fixtureDir, 'fail-process-scan');
    fs.writeFileSync(failScan, '1');
    await eventually(() => fs.existsSync(path.join(fixtureDir, 'failed-process-scan-observed')), 'failed process scan');
    fs.rmSync(failScan);
    // Force the daemon's private state to disk after the failed scan.
    await client.request('settings.update', { fontSize: 14 });
    assert.equal(privateExit(scanSpec.runId), null, 'a failed scan does not start an exit drain');
    assert.equal((await getRun(options, scanSpec.runId)).run.status, 'running');
    const omitPid = path.join(fixtureDir, 'omit-process-pid');
    const omittedObserved = path.join(fixtureDir, 'omitted-process-observed');
    fs.writeFileSync(omitPid, String(scanCapture.pid));
    await eventually(() => fs.existsSync(omittedObserved) && fs.readFileSync(omittedObserved, 'utf8') === String(scanCapture.pid), 'process omitted from snapshot', 45000);
    await client.request('settings.update', { fontSize: 14 });
    assert.equal(privateExit(scanSpec.runId), null, 'an omitted process does not start an exit drain');
    fs.rmSync(omitPid);
    assert.equal((await getRun(options, scanSpec.runId)).run.status, 'running');
    fs.writeFileSync(path.join(automation, `finish-${scanSpec.runId}`), '1');
    assert.equal((await waitForRun(options, scanSpec.runId, { timeoutMs: 120000 })).reason, 'completed');
    console.log('PASS failed and transient process scans preserve a live run');

    // A fast extension can disappear before its first lifecycle report is
    // processed; its retained generation must still accept queued start/end.
    const earlyExit = spec({ agentId: 'pi' });
    writePlan(earlyExit.runId, { sessionId: 'early-exit', steps: [
      { prepareEvents: [{ event: 'agent_start', state: 'running' }, { event: 'agent_end', state: 'completed' }], signalFile: `prepared-${earlyExit.runId}` },
      { waitForFile: `start-${earlyExit.runId}` },
      { preparedEvent: 'agent_start', state: 'running' },
      { preparedEvent: 'agent_end', state: 'completed' },
    ] });
    const earlyRun = await startRun(options, earlyExit);
    const earlyCapture = await captureFor(earlyExit.runId);
    await eventually(() => fs.existsSync(path.join(automation, `prepared-${earlyExit.runId}`)), 'queued extension commands prepared');
    await eventually(async () => (await paneOf(earlyRun.paneId))?.agentPid === earlyCapture.pid, 'early agent identity');
    fs.writeFileSync(omitPid, String(earlyCapture.pid));
    await eventually(() => fs.existsSync(omittedObserved) && fs.readFileSync(omittedObserved, 'utf8') === String(earlyCapture.pid), 'pre-acceptance disappearance', 45000);
    await client.request('settings.update', { fontSize: 14 });
    assert.equal(privateExit(earlyExit.runId), null);
    fs.writeFileSync(path.join(automation, `start-${earlyExit.runId}`), '1');
    const earlyResult = await waitForRun(options, earlyExit.runId, { timeoutMs: 120000 });
    assert.equal(earlyResult.reason, 'completed');
    fs.rmSync(omitPid);
    console.log('PASS queued extension start and end survive pre-acceptance disappearance');

    // A successor can reuse the PID and session before an omitted snapshot.
    // Its event must not complete the old run even when its stamp predates it.
    const reusedPid = spec({ agentId: 'pi' });
    writePlan(reusedPid.runId, { sessionId: 'reused-pid', steps: [
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitForFile: `prepare-${reusedPid.runId}` },
      { prepareEvents: [{ event: 'agent_end', state: 'completed', foreignIdentity: true }], signalFile: `prepared-${reusedPid.runId}` },
      { waitForFile: `future-${reusedPid.runId}` },
      { preparedEvent: 'agent_end', state: 'completed', signalFile: `future-delivered-${reusedPid.runId}` },
      { waitForFile: `successor-${reusedPid.runId}` },
      { event: 'agent_end', state: 'completed', signalFile: `successor-delivered-${reusedPid.runId}` },
    ] });
    const reusedRun = await startRun(options, reusedPid);
    const reusedCapture = await captureFor(reusedPid.runId);
    await eventually(async () => (await getRun(options, reusedPid.runId)).run.status === 'running', 'reused PID acceptance');
    await eventually(async () => (await paneOf(reusedRun.paneId))?.agentPid === reusedCapture.pid, 'reused PID tracked identity');
    fs.writeFileSync(path.join(automation, `prepare-${reusedPid.runId}`), '1');
    await eventually(() => fs.existsSync(path.join(automation, `prepared-${reusedPid.runId}`)), 'successor event prepared before omission');
    const reusedBeforeOmission = (await getRun(options, reusedPid.runId)).run;
    fs.writeFileSync(omitPid, String(reusedCapture.pid));
    await eventually(() => fs.existsSync(omittedObserved) && fs.readFileSync(omittedObserved, 'utf8') === String(reusedCapture.pid), 'reused PID omitted from snapshot', 45000);
    fs.writeFileSync(path.join(automation, `future-${reusedPid.runId}`), '1');
    await eventually(() => fs.existsSync(path.join(automation, `future-delivered-${reusedPid.runId}`)), 'unverifiable omitted event delivered');
    assert.equal(fs.existsSync(path.join(automation, `delivery-error-${reusedPid.runId}.json`)), false);
    const afterFutureEvent = (await getRun(options, reusedPid.runId)).run;
    assert.equal(afterFutureEvent.status, 'running', 'a successor event predating the omission cannot finish the original generation');
    assert.equal(afterFutureEvent.revision, reusedBeforeOmission.revision);
    assert.equal(afterFutureEvent.finishedAt, null);
    fs.writeFileSync(path.join(fixtureDir, 'identity.json'), JSON.stringify({ pi: new Date(Date.now() + 5000).toISOString() }));
    fs.rmSync(omitPid);
    fs.writeFileSync(path.join(automation, `successor-${reusedPid.runId}`), '1');
    await eventually(() => fs.existsSync(path.join(automation, `successor-delivered-${reusedPid.runId}`)), 'reused PID successor event delivered');
    assert.equal(fs.existsSync(path.join(automation, `delivery-error-${reusedPid.runId}.json`)), false);
    const reusedResult = await waitForRun(options, reusedPid.runId, { timeoutMs: 120000 });
    assert.equal(reusedResult.reason, 'interrupted', 'a successor event cannot complete the old run');
    assert.equal(reusedResult.run.code, 'AGENT_REPLACED');
    fs.rmSync(path.join(fixtureDir, 'identity.json'), { force: true });
    console.log('PASS omitted PID reuse cannot complete the old generation');

    // A real nonzero shell exit after an omitted snapshot starts the drain
    // with its actual code, not a fabricated earlier exit observation.
    const refinedExit = spec({ agentId: 'omp' });
    writePlan(refinedExit.runId, { sessionId: 'refined-exit', steps: [
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitForFile: `exit-${refinedExit.runId}` },
      { exit: 7 },
    ] });
    const refinedRun = await startRun(options, refinedExit);
    const refinedCapture = await captureFor(refinedExit.runId);
    await eventually(async () => (await getRun(options, refinedExit.runId)).run.status === 'running', 'refined exit acceptance');
    await eventually(async () => (await paneOf(refinedRun.paneId))?.agentPid === refinedCapture.pid, 'refined exit identity');
    fs.writeFileSync(omitPid, String(refinedCapture.pid));
    await eventually(() => fs.existsSync(omittedObserved) && fs.readFileSync(omittedObserved, 'utf8') === String(refinedCapture.pid), 'omitted exit identity', 45000);
    await client.request('settings.update', { fontSize: 14 });
    assert.equal(privateExit(refinedExit.runId), null);
    fs.writeFileSync(path.join(automation, `exit-${refinedExit.runId}`), '1');
    const confirmedExit = await eventually(() => {
      const exit = privateExit(refinedExit.runId);
      return exit?.code === 'AGENT_EXITED' ? exit : false;
    }, 'confirmed nonzero exit', 45000);
    assert.ok(confirmedExit.observedAt > 0);
    fs.rmSync(omitPid);
    const refinedResult = await waitForRun(options, refinedExit.runId, { timeoutMs: 120000 });
    assert.equal(refinedResult.reason, 'failed');
    assert.equal(refinedResult.run.code, 'AGENT_EXITED');
    console.log('PASS real nonzero exit is retained after process disappearance');

    // --- a proven replacement is an interruption ----------------------------
    const replaceSpec = spec({ agentId: 'pi' });
    writePlan(replaceSpec.runId, { sessionId: 'replace', steps: [{ waitMs: 150, event: 'agent_start', state: 'running' }, { marker: 'MARKER_REPLACE' }] });
    await startRun(options, replaceSpec);
    await eventually(() => acceptedOrTerminal(replaceSpec.runId), 'replacement acceptance');
    fs.writeFileSync(path.join(fixtureDir, 'identity.json'), JSON.stringify({ pi: new Date(Date.now() + 5000).toISOString() }));
    await eventually(async () => (await getRun(options, replaceSpec.runId)).run.status === 'interrupted', 'replacement interruption', 45000);
    assert.equal((await getRun(options, replaceSpec.runId)).run.code, 'AGENT_REPLACED');
    fs.rmSync(path.join(fixtureDir, 'identity.json'), { force: true });
    console.log('PASS proven replacement interrupts the run');

    // A replacement during a private exit drain interrupts immediately, not
    // after the 10-second drain expires. The fixture emits the shell's exit
    // marker while it is still alive so its process identity can be replaced.
    const replaceDuringDrain = spec({ agentId: 'pi' });
    writePlan(replaceDuringDrain.runId, { sessionId: 'replace-drain', steps: [
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitMs: 150, exitEvidence: true },
    ] });
    await startRun(options, replaceDuringDrain);
    const drainExit = await eventually(() => privateExit(replaceDuringDrain.runId), 'replacement drain observation', 45000);
    fs.writeFileSync(path.join(fixtureDir, 'identity.json'), JSON.stringify({ pi: new Date(Date.now() + 5000).toISOString() }));
    const interrupted = await eventually(async () => {
      const run = (await getRun(options, replaceDuringDrain.runId)).run;
      return run.status === 'interrupted' ? run : false;
    }, 'replacement during drain', 8000);
    assert.equal(interrupted.code, 'AGENT_REPLACED');
    assert.ok(interrupted.finishedAt - drainExit.observedAt < 10000, 'replacement must not wait for the drain deadline');
    fs.rmSync(path.join(fixtureDir, 'identity.json'), { force: true });
    console.log('PASS replacement during drain interrupts immediately');

    // --- a disposed pane is PANE_CLOSED ------------------------------------
    const disposedSpec = spec({ agentId: 'omp' });
    writePlan(disposedSpec.runId, { sessionId: 'disposed', steps: [{ event: 'agent_start', state: 'running' }] });
    const disposedView = await startRun(options, disposedSpec);
    await eventually(() => acceptedOrTerminal(disposedSpec.runId), 'disposal acceptance');
    await client.request('pane.close', { paneId: disposedView.paneId });
    const disposed = await getRun(options, disposedSpec.runId, { includeScreen: true });
    assert.equal(disposed.run.status, 'interrupted');
    assert.equal(disposed.run.code, 'PANE_CLOSED');
    assert.equal(disposed.screen, null);
    assert.equal(disposed.screenError, 'RUN_OUTPUT_UNAVAILABLE', 'a disposed run never returns a replacement shell');
    console.log('PASS pane disposal interrupts and drops the output');

    // A verified Hermes observer cannot put another agent's run into a
    // binding wait merely by reporting that run's working directory.
    const crossAgent = spec({ agentId: 'codex' });
    writePlan(crossAgent.runId, { sessionId: 'cross-agent', steps: [] });
    const crossRun = await startRun(options, crossAgent);
    const foreignSession = `foreign-${crossAgent.runId.slice(0, 8)}`;
    writePlan('unbound', { gateway: { cwd: crossRun.cwd, sessionId: foreignSession }, steps: [
      { waitMs: 400, event: 'session_start', state: 'idle' },
      { waitMs: 150, event: 'agent_start', state: 'running' },
    ] });
    const foreignGateway = await client.request('workspace.create', { name: 'Foreign gateway', cwd: project, agentId: 'hermes' });
    await eventually(async () => (await client.request('agent.sessions')).sessions.some(session => session.sessionId === foreignSession && session.state === 'running'), 'foreign gateway start', 45000);
    const unaffected = (await getRun(options, crossAgent.runId)).run;
    assert.equal(unaffected.status, 'starting');
    assert.equal(unaffected.code, 'AWAITING_LIFECYCLE');
    await client.request('workspace.close', { workspaceId: foreignGateway.id });
    await client.request('workspace.close', { workspaceId: crossRun.workspaceId });
    console.log('PASS Hermes binding requests do not affect other agents');

    // --- Hermes: an unbound shared gateway needs an explicit binding --------
    const gatewaySpec = spec({ agentId: 'hermes' });
    writePlan(gatewaySpec.runId, { steps: [{ marker: 'MARKER_HERMES_RUN' }] });
    const gatewayRun = await startRun(options, gatewaySpec);
    const worktree = gatewayRun.cwd;
    const gatewaySession = `gateway-${gatewaySpec.runId.slice(0, 8)}`;
    // A verified gateway in another pane describes the run's worktree; the run's
    // own pane stays silent, so its outcome can only come from a bound observer.
    writePlan('unbound', { gateway: { cwd: worktree, sessionId: gatewaySession }, steps: [
      { waitMs: 400, event: 'session_start', state: 'idle' },
      { waitForFile: 'continue-gateway' },
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitMs: 250, marker: 'MARKER_GATEWAY' },
      { waitMs: 1500, event: 'agent_end', state: 'completed' },
    ] });
    // The gateway lives in its own non-task workspace, so it carries no task
    // context of its own and stands in for a shared Hermes gateway process.
    const gatewayWorkspace = await client.request('workspace.create', { name: 'Gateway', cwd: project, agentId: 'hermes' });
    await eventually(async () => (await client.request('agent.sessions')).sessions.some(session => session.sessionId === gatewaySession), 'gateway session boundary', 45000);
    assert.equal((await getRun(options, gatewaySpec.runId)).run.status, 'starting', 'a session boundary alone does not request binding');
    fs.writeFileSync(path.join(automation, 'continue-gateway'), '1');
    await eventually(async () => (await getRun(options, gatewaySpec.runId)).run.status === 'waiting', 'binding required', 45000);
    assert.equal((await getRun(options, gatewaySpec.runId)).run.code, 'BINDING_REQUIRED');
    // A completed first turn before binding is not a completed run.
    await eventually(async () => fs.existsSync(path.join(automation, 'capture-unbound.json')), 'gateway capture');
    assert.notEqual((await getRun(options, gatewaySpec.runId)).run.status, 'completed');
    // Binding without a retained first start never invents completion.
    writePlan('unbound', { gateway: { cwd: worktree, sessionId: `${gatewaySession}-nostart` }, steps: [
      { waitMs: 400, event: 'session_start', state: 'idle' },
      { waitMs: 200, event: 'agent_end', state: 'completed' },
    ] });
    await client.request('workspace.close', { workspaceId: gatewayWorkspace.id });
    const secondGateway = await client.request('workspace.create', { name: 'Gateway 2', cwd: project, agentId: 'hermes' });
    await assert.rejects(client.request('agent.bind', { paneId: gatewayRun.paneId, sessionId: `${gatewaySession}-nostart` }),
      { code: 'INVALID_BINDING', message: 'Select a new Hermes session for this task directory' });
    await client.request('workspace.close', { workspaceId: secondGateway.id });
    // The correct binding replays the retained first turn and completes the run.
    writePlan('unbound', { gateway: { cwd: worktree, sessionId: gatewaySession }, steps: [
      { waitMs: 400, event: 'session_start', state: 'idle' },
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitMs: 250, event: 'agent_end', state: 'completed' },
    ] });
    const thirdGateway = await client.request('workspace.create', { name: 'Gateway 3', cwd: project, agentId: 'hermes' });
    await eventually(async () => {
      try { await client.request('agent.bind', { paneId: gatewayRun.paneId, sessionId: gatewaySession }); return true; } catch { return false; }
    }, 'hermes binding', 45000);
    await client.request('workspace.close', { workspaceId: thirdGateway.id });
    const bound = await waitForRun(options, gatewaySpec.runId, { timeoutMs: 30000 });
    assert.equal(bound.reason, 'completed', `a bound observer replays the retained first turn: ${JSON.stringify(bound.run)}`);
    console.log('PASS shared gateway requires an explicit binding and replays evidence');

    // --- restart normalization ---------------------------------------------
    const restartSpec = spec({ agentId: 'pi' });
    writePlan(restartSpec.runId, { sessionId: 'restart', steps: [{ waitMs: 150, event: 'agent_start', state: 'running' }, { marker: 'MARKER_RESTART' }] });
    const beforeRestart = await startRun(options, restartSpec);
    await eventually(() => acceptedOrTerminal(restartSpec.runId), 'restart acceptance');
    const capturesBefore = fs.readdirSync(automation).filter(name => name.startsWith('capture-')).length;
    await stop();
    await launch();
    const restarted = await getRun(options, restartSpec.runId, { includeScreen: true });
    assert.equal(restarted.run.status, 'interrupted');
    assert.equal(restarted.run.code, 'DAEMON_RESTARTED');
    assert.equal(restarted.run.paneId, beforeRestart.paneId);
    assert.ok(await paneOf(beforeRestart.paneId), 'the saved pane ID was restored as a fresh shell');
    assert.equal(restarted.screen, null);
    assert.equal(restarted.screenError, 'RUN_OUTPUT_UNAVAILABLE', 'the restored shell is not the original run output');
    assert.equal(fs.readdirSync(automation).filter(name => name.startsWith('capture-')).length, capturesBefore, 'a restart never replays the prompt');
    console.log('PASS restart normalization without prompt replay');

    // --- CLI surface -------------------------------------------------------
    const cliSpec = spec({ agentId: 'pi' });
    writePlan(cliSpec.runId, { sessionId: 'cli', steps: [{ event: 'agent_start', state: 'running' }, { marker: 'MARKER_CLI' }, { waitMs: 200, event: 'agent_end', state: 'completed' }] });
    const cli = (...args) => spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, ...args], { encoding: 'utf8', windowsHide: true });
    const listed = cli('list');
    assert.equal(listed.status, 0, listed.stderr);
    const listing = JSON.parse(listed.stdout);
    assert.ok(listing.projects.length > 0 && listing.tasks.length > 0);
    for (const entry of [...listing.projects, ...listing.tasks]) {
      assert.equal(Object.hasOwn(entry, 'automation'), false, 'CLI list never exposes private automation records');
      assert.equal(Object.hasOwn(entry, 'requestHash'), false, 'CLI list never exposes private request hashes');
    }
    assert.equal(cli('run', '--spec', '-', '--no-wait').status, 1, 'an empty spec is rejected');
    const noWaitSpec = spec({ agentId: 'pi' });
    writePlan(noWaitSpec.runId, { sessionId: 'cli-no-wait', steps: [] });
    const noWait = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-', '--no-wait'], {
      input: JSON.stringify(noWaitSpec), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(noWait.status, 0, noWait.stderr || noWait.stdout);
    const noWaitResult = JSON.parse(noWait.stdout);
    assert.deepEqual(noWaitResult, { reason: 'started', run: (await getRun(options, noWaitSpec.runId)).run, screen: null, screenError: null });
    assert.equal(noWaitResult.run.runId, noWaitSpec.runId);
    const piped = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-', '--timeout', '180000'], { input: JSON.stringify(cliSpec), encoding: 'utf8', windowsHide: true });
    assert.equal(piped.status, 0, piped.stderr || piped.stdout);
    const pipedResult = JSON.parse(piped.stdout);
    assert.equal(pipedResult.reason, 'completed');
    assert.match(pipedResult.screen.text, /MARKER_CLI/);
    const status = cli('run-status', cliSpec.runId);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).reason, 'status');
    assert.equal(cli('run-wait', cliSpec.runId, '--after', '99').status, 0);
    const waitingCli = spec({ agentId: 'omp' });
    writePlan(waitingCli.runId, { sessionId: 'cli-wait', steps: [{ waitMs: 150, event: 'agent_start', state: 'running' }, { waitMs: 150, event: 'tool_approval_requested', state: 'waiting' }, { marker: 'MARKER_CLI_WAIT' }] });
    const waitingRun = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-', '--timeout', '60000'], { input: JSON.stringify(waitingCli), encoding: 'utf8', windowsHide: true });
    assert.equal(waitingRun.status, 2, waitingRun.stderr);
    assert.equal(JSON.parse(waitingRun.stdout).reason, 'waiting');
    const timedOut = cli('run-wait', waitingCli.runId, '--after', String(JSON.parse(waitingRun.stdout).run.revision), '--timeout', '1200');
    assert.equal(timedOut.status, 4, timedOut.stderr);
    assert.equal(JSON.parse(timedOut.stdout).reason, 'timeout');
    const stillRunning = await paneOf((await getRun(options, waitingCli.runId)).run.paneId);
    assert.equal(stillRunning.status, 'running', 'a CLI timeout never stops the agent');
    const waitingCapture = await captureFor(waitingCli.runId);
    const capturePath = path.join(automation, `capture-${waitingCli.runId}.json`);
    const captureBytes = fs.readFileSync(capturePath);
    const cancelledCli = observedCliWait(waitingCli.runId, JSON.parse(waitingRun.stdout).run.revision);
    await eventually(() => fs.existsSync(cancelledCli.readyFile), 'waiting CLI metadata polling');
    assert.equal(cancelledCli.child.exitCode, null, 'the CLI is waiting for a newer revision');
    assert.equal(cancelledCli.child.kill(), true);
    await cancelledCli.closed;
    assert.doesNotThrow(() => process.kill(waitingCapture.pid, 0), 'stopping the waiting CLI leaves the agent process alive');
    assert.deepEqual(fs.readFileSync(capturePath), captureBytes, 'stopping the CLI does not launch or resubmit the prompt');
    assert.equal((await getRun(options, waitingCli.runId)).run.status, 'waiting');
    const unknown = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-'], { input: JSON.stringify({ ...spec(), secret: 'LEAK-ME' }), encoding: 'utf8', windowsHide: true });
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr.includes('LEAK-ME'), false);
    assert.equal(unknown.stderr.includes('Describe the fixture entrypoint'), false);
    const sentinel = 'INPUT-MUST-NOT-BE-ECHOED';
    const missingName = spec({ prompt: sentinel });
    delete missingName.name;
    for (const [label, input] of [
      ['malformed JSON', `{"prompt":"${sentinel}"`],
      ['missing required field', JSON.stringify(missingName)],
      ['oversized stdin', JSON.stringify({ ...spec(), prompt: sentinel.repeat(3000) })],
    ]) {
      const rejected = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-'], {
        input, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(rejected.status, 1, `${label}: ${rejected.stderr}`);
      assert.equal(rejected.stdout.includes(sentinel), false, `${label}: stdout must not echo input`);
      assert.equal(rejected.stderr.includes(sentinel), false, `${label}: stderr must not echo input`);
    }
    const invalidUtf8 = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-'], { input: Buffer.from([0xff, 0xfe, 0x00]), encoding: 'utf8', windowsHide: true });
    assert.equal(invalidUtf8.status, 1);
    assert.equal(cli('run', '--spec', '-', '--no-wait', '--timeout', '10').status, 1, '--no-wait rejects an explicit timeout');
    console.log('PASS CLI run, run-status, run-wait and bounded spec errors');

    // Install the actual skills and exercise their copied runtime against this
    // isolated daemon from an unrelated cwd with conflicting inherited values.
    const skillProject = path.join(base, 'installed-client');
    const unrelated = path.join(base, 'unrelated');
    fs.mkdirSync(skillProject); fs.mkdirSync(unrelated);
    const skillWorkspace = await client.request('workspace.create', { name: 'Installed client', cwd: skillProject, profileId: 'powershell' });
    await installSkills(client, { workspaceId: skillWorkspace.id, agent: 'codex' }, { dataDir, appRoot: root });
    const installedWrapper = path.join(skillProject, '.agents', 'skills', 'winmux-terminal', 'scripts', 'winmux-client.cjs');
    const conflictingEnv = { ...process.env, WINMUX_DATA_DIR: path.join(unrelated, 'wrong-data'), WINMUX_PIPE_NAME: 'wrong-pipe',
      WINMUX_PANE_ID: 'wrong-pane', WINMUX_AGENT_LAUNCH_ID: 'wrong-launch', WINMUX_TASK_ID: 'wrong-task',
      WINMUX_AGENT_NODE: 'wrong-node', WINMUX_AGENT_HELPER: 'wrong-helper' };
    const installed = (args, input) => spawnSync(nodeExe, [installedWrapper, '--pipe', pipeName, ...args], {
      cwd: unrelated, env: conflictingEnv, input, encoding: 'utf8', windowsHide: true, timeout: 180000,
    });
    const installedSpec = spec({ agentId: 'pi' });
    writePlan(installedSpec.runId, { sessionId: 'installed-wrapper', steps: [
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { marker: 'MARKER_INSTALLED' },
      { waitMs: 200, event: 'agent_end', state: 'completed' },
    ] });
    const installedRun = installed(['run', '--spec', '-', '--timeout', '120000'], JSON.stringify(installedSpec));
    assert.equal(installedRun.status, 0, installedRun.stderr || installedRun.stdout);
    assert.equal(JSON.parse(installedRun.stdout).reason, 'completed');
    const installedStatus = installed(['run-status', installedSpec.runId]);
    assert.equal(installedStatus.status, 0, installedStatus.stderr);
    assert.equal(JSON.parse(installedStatus.stdout).run.runId, installedSpec.runId);
    const installedWait = installed(['run-wait', installedSpec.runId, '--after', '99']);
    assert.equal(installedWait.status, 0, installedWait.stderr);
    assert.equal(JSON.parse(installedWait.stdout).reason, 'completed');
    const installedWaitingSpec = spec({ agentId: 'omp' });
    writePlan(installedWaitingSpec.runId, { sessionId: 'installed-waiting', steps: [
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitMs: 150, event: 'tool_approval_requested', state: 'waiting' },
      { marker: 'MARKER_INSTALLED_WAIT' },
    ] });
    const specFile = path.join(unrelated, 'installed-spec.json');
    fs.writeFileSync(specFile, JSON.stringify(installedWaitingSpec), 'utf8');
    const installedWaiting = installed(['run', '--spec', specFile, '--timeout', '120000']);
    assert.equal(installedWaiting.status, 2, installedWaiting.stderr || installedWaiting.stdout);
    const installedWaitingResult = JSON.parse(installedWaiting.stdout);
    assert.equal(installedWaitingResult.reason, 'waiting');
    assert.equal(installedWaitingResult.run.runId, installedWaitingSpec.runId);
    const installedTimeout = installed(['run-wait', installedWaitingSpec.runId, '--after', String(installedWaitingResult.run.revision), '--timeout', '1200']);
    assert.equal(installedTimeout.status, 4, installedTimeout.stderr || installedTimeout.stdout);
    assert.equal(JSON.parse(installedTimeout.stdout).reason, 'timeout');
    assert.doesNotThrow(() => process.kill(capture(installedWaitingSpec.runId).pid, 0), 'installed wrapper timeout leaves the fixture agent alive');
    await client.request('workspace.close', { workspaceId: skillWorkspace.id });
    console.log('PASS installed wrapper starts, reads and waits for a real isolated run');

    await stop();
    assert.equal(/Unhandled|ERR_ASSERTION/.test(logs), false, 'the fixture daemon logs no unhandled failure');
    console.log('PASS automation smoke');
  }
  main().catch(error => {
    console.error(error);
    try { console.error(`automation dir: ${fs.readdirSync(automation).join(', ')}`); } catch {}
    process.exitCode = 1;
  }).finally(async () => {
    for (const waiter of observedWaiters) { try { waiter.kill(); } catch {} }
    await stop().catch(() => {});
    // Windows Git marks its disposable object files read-only. Clear that
    // attribute only inside this fixture's object store, never follow links,
    // then remove the isolated tree after its daemon and panes have stopped.
    const makeWritable = target => {
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) for (const name of fs.readdirSync(target)) makeWritable(path.join(target, name));
      else if (info.isFile()) fs.chmodSync(target, 0o666);
    };
    try {
      const objects = path.join(project, '.git', 'objects');
      if (fs.existsSync(objects)) makeWritable(objects);
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) { console.error(`cleanup: ${error.message}`); process.exitCode = 1; }
  });
}
