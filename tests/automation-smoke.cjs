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
    const table = await windowsProcessTable();
    const markers = overrides();
    const rows = [];
    for (const row of table) {
      const match = /automation-agent\.cjs"?\s+(codex|claude|omp|pi|hermes)\b/.exec(row.commandLine || '');
      if (!match) { rows.push(row); continue; }
      rows.push({ ...row, executable: identity[match[1]], createdAt: markers[match[1]] || row.createdAt });
    }
    return rows;
  }
  discovery.discover = async () => {
    const environment = await realDiscover();
    environment.profiles = environment.profiles.filter(profile => profile.environment === 'windows');
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
const delivery = (event, state) => {
  if (agentId === 'codex' || agentId === 'claude') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(event)],
      input: JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd }) };
  }
  const helper = path.join(dataDir, 'hooks', agentId === 'omp' ? 'winmux-omp-hook.cjs' : 'winmux-agent-event.cjs');
  return { file: process.env.WINMUX_AGENT_NODE || process.execPath, args: [helper, '--data-dir', dataDir, '--pipe', process.env.WINMUX_PIPE_NAME],
    input: JSON.stringify({ agentId, event, sessionId, cwd, pid: plan.gateway ? plan.gateway.pid || process.pid : process.pid, stamp: process.hrtime.bigint().toString(), state }) };
};
const deliver = (event, state) => {
  const command = delivery(event, state);
  const result = spawnSync(command.file, command.args, { input: command.input, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) fs.writeFileSync(path.join(dir, 'delivery-error-' + name + '.json'), JSON.stringify({ event, state, status: result.status, stderr: result.stderr }));
};
process.stdout.write('AUTOMATION_AGENT_READY ' + name + '\r\n');
for (const step of plan.steps || []) {
  if (step.waitMs) wait(step.waitMs);
  if (step.marker) process.stdout.write(step.marker + '\r\n');
  if (step.event) deliver(step.event, step.state || 'running');
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
    const tasksBefore = (await state()).tasks.length;
    await assert.rejects(startRun(options, spec({ agentId: 'pi', prompt: '@notes.md summarize' })), { code: 'INVALID_AUTOMATION_PROMPT' });
    assert.equal((await state()).tasks.length, tasksBefore, 'a rejected prompt creates no task');
    await assert.rejects(startRun(options, spec({ profileId: 'wsl:Fixture' })), { code: 'UNSUPPORTED_ENVIRONMENT' });
    assert.equal((await state()).tasks.length, tasksBefore, 'a WSL profile creates no task');
    await assert.rejects(startRun(options, spec({ mode: 'attach' })), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(getRun(options, randomUUID()), { code: 'RUN_NOT_FOUND' });
    console.log('PASS repeat, conflict, WSL and Pi rejection');

    // --- the prompt survives shell metacharacters as one argument -----------
    const nasty = 'Keep "quotes" and `backticks` and $(touch should-not-exist) and --help and models\nsecond line — Ж漢';
    const nastySpec = spec({ agentId: 'pi', prompt: nasty });
    writePlan(nastySpec.runId, { sessionId: 'nasty', steps: [{ event: 'agent_start', state: 'running' }, { marker: 'MARKER_NASTY' }, { waitMs: 200, event: 'agent_end', state: 'completed' }] });
    await startRun(options, nastySpec);
    await waitForRun(options, nastySpec.runId, { timeoutMs: 180000 });
    assert.deepEqual((await captureFor(nastySpec.runId)).args, ['--', nasty], 'the prompt is one literal argument');
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
    console.log('PASS oversized command line is a retained failed run');

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

    // --- the exit race: a late Stop inside the window wins -------------------
    const raceSpec = spec({ agentId: 'claude' });
    writePlan(raceSpec.runId, { sessionId: 'race', steps: [
      { waitMs: 150, event: 'UserPromptSubmit', state: 'running' },
      { marker: 'MARKER_RACE' },
      { exit: 0, late: { delayMs: 4000, event: 'Stop', state: 'completed' } },
    ] });
    await startRun(options, raceSpec);
    await eventually(() => acceptedOrTerminal(raceSpec.runId), 'race acceptance');
    const acceptedRevision = (await getRun(options, raceSpec.runId)).run.revision;
    // While the shell exit is private the public view stays non-terminal.
    let pendingView = null;
    await eventually(async () => {
      if (!privateExit(raceSpec.runId)) return (await getRun(options, raceSpec.runId)).run.status === 'completed';
      pendingView = (await getRun(options, raceSpec.runId)).run;
      return true;
    }, 'private exit observation');
    if (pendingView) {
      assert.ok(['starting', 'running', 'waiting'].includes(pendingView.status), `a pending exit is not public: ${pendingView.status}`);
      assert.equal(pendingView.finishedAt, null, 'a pending shell exit publishes no finish time');
      assert.equal(pendingView.revision, acceptedRevision, 'a pending shell exit does not move the revision');
    }
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
    const expiredRun = await waitForRun(options, silentExit.runId, { timeoutMs: 120000 });
    assert.equal(expiredRun.reason, 'failed');
    assert.equal(expiredRun.run.code, 'AGENT_EXITED');
    console.log('PASS unresolved exit publishes after the drain window');

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
      { waitMs: 150, event: 'agent_start', state: 'running' },
      { waitMs: 250, marker: 'MARKER_GATEWAY' },
      { waitMs: 1500, event: 'agent_end', state: 'completed' },
    ] });
    // The gateway lives in its own non-task workspace, so it carries no task
    // context of its own and stands in for a shared Hermes gateway process.
    const gatewayWorkspace = await client.request('workspace.create', { name: 'Gateway', cwd: project, agentId: 'hermes' });
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
    await startRun(options, restartSpec);
    await eventually(() => acceptedOrTerminal(restartSpec.runId), 'restart acceptance');
    const capturesBefore = fs.readdirSync(automation).filter(name => name.startsWith('capture-')).length;
    await stop();
    await launch();
    const restarted = await getRun(options, restartSpec.runId);
    assert.equal(restarted.run.status, 'interrupted');
    assert.equal(restarted.run.code, 'DAEMON_RESTARTED');
    assert.equal(fs.readdirSync(automation).filter(name => name.startsWith('capture-')).length, capturesBefore, 'a restart never replays the prompt');
    console.log('PASS restart normalization without prompt replay');

    // --- CLI surface -------------------------------------------------------
    const cliSpec = spec({ agentId: 'pi' });
    writePlan(cliSpec.runId, { sessionId: 'cli', steps: [{ event: 'agent_start', state: 'running' }, { marker: 'MARKER_CLI' }, { waitMs: 200, event: 'agent_end', state: 'completed' }] });
    const cli = (...args) => spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(cli('run', '--spec', '-', '--no-wait').status, 1, 'an empty spec is rejected');
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
    const unknown = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-'], { input: JSON.stringify({ ...spec(), secret: 'LEAK-ME' }), encoding: 'utf8', windowsHide: true });
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr.includes('LEAK-ME'), false);
    assert.equal(unknown.stderr.includes('Describe the fixture entrypoint'), false);
    const invalidUtf8 = spawnSync(nodeExe, [path.join(root, 'cli.cjs'), '--data-dir', dataDir, '--pipe', pipeName, 'run', '--spec', '-'], { input: Buffer.from([0xff, 0xfe, 0x00]), encoding: 'utf8', windowsHide: true });
    assert.equal(invalidUtf8.status, 1);
    assert.equal(cli('run', '--spec', '-', '--no-wait', '--timeout', '10').status, 1, '--no-wait rejects an explicit timeout');
    console.log('PASS CLI run, run-status, run-wait and bounded spec errors');

    await stop();
    assert.equal(/Unhandled|ERR_ASSERTION/.test(logs), false, 'the fixture daemon logs no unhandled failure');
    console.log('PASS automation smoke');
  }
  main().catch(error => {
    console.error(error);
    try { console.error(`automation dir: ${fs.readdirSync(automation).join(', ')}`); } catch {}
    process.exitCode = 1;
  }).finally(async () => {
    await stop().catch(() => {});
    // Attached fixture processes can still hold files briefly; the isolated
    // directory is disposable and cleanup must not mask the real result.
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch (error) { console.error(`cleanup: ${error.message}`); }
  });
}
