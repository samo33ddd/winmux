'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const net = require('node:net');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-agent-controller-'));
const project = path.join(dataDir, 'project');
fs.mkdirSync(project, { recursive: true });
const pipeName = process.platform === 'win32'
  ? `\\\\.\\pipe\\winmux-agent-controller-${randomUUID()}`
  : path.join(dataDir, 'daemon.sock');

const pwsh = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
const windowsPowerShell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const shell = fs.existsSync(pwsh) ? pwsh : windowsPowerShell;
assert.ok(fs.existsSync(shell), 'a disposable PowerShell executable is required');
assert.ok(fs.existsSync(pwsh), 'the UI-selected OMP fixture requires pwsh.exe');

const fakeEnvironment = {
  profiles: [{
    id: 'powershell',
    label: 'PowerShell fixture',
    environment: 'windows',
    command: shell,
    args: ['-NoLogo', '-NoProfile', '-NoExit'],
    cwd: project,
  }],
  agents: [{
    id: 'omp',
    label: 'OMP fixture',
    environment: 'windows',
    profileId: 'powershell',
    available: true,
    command: pwsh,
    args: ['-NoProfile', '-Command', 'Start-Sleep -Seconds 120'],
  }],
  defaultCwd: project,
  platform: process.platform,
  capabilities: {
    terminalTabs: true,
    liveCwd: true,
    agentLaunch: true,
    agentStatus: true,
    sessionAgentHooks: true,
    nativeCodex: true,
    ompHooks: true,
    agentActivity: true,
    protocolVersion: 3,
  },
};

// Keep discovery entirely local and deterministic. startServer and its real
// PTY/IPC implementation stay unchanged; no WSL, agent command, or Codex
// daemon is started by this fixture.
const environmentModule = require('../electron/backend/environment.cjs');
environmentModule.discover = async () => structuredClone(fakeEnvironment);
const { startServer } = require('../electron/backend.cjs');
const { connect } = require('../electron/client.cjs');

let stampCounter = 0;
const nextStamp = () => (process.hrtime.bigint() + BigInt(++stampCounter)).toString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const processRows = [];
let daemon;
let client;
let releaseCodex;
let fakeCodexClient;
const pendingCodexConnection = new Promise(resolve => { releaseCodex = resolve; });

function codexFixture() {
  const client = {
    async listThreads() { return { data: [], nextCursor: null }; },
    async listLoaded() { return { data: [], nextCursor: null }; },
    onNotification() { return () => {}; },
    async close() {},
  };
  return {
    connect: () => pendingCodexConnection,
    client,
  };
}

function rootProcess(pane) {
  return {
    pid: pane.pid,
    ppid: 1,
    name: 'pwsh.exe',
    executable: shell,
    commandLine: `"${shell}" -NoLogo -NoProfile -NoExit`,
    createdAt: new Date(Date.now() - 5000).toISOString(),
  };
}

function agentProcess(pane, index, overrides = {}) {
  const createdAt = new Date(Date.now() - 5000).toISOString();
  return {
    pid: 800000 + (process.pid % 1000) * 10 + index,
    ppid: pane.pid,
    name: 'fixture.exe',
    executable: 'C:\\fixtures\\fixture.exe',
    commandLine: 'fixture',
    createdAt,
    ...overrides,
  };
}

function paneById(state, paneId) {
  for (const workspace of state.workspaces) {
    const pane = workspace.panes.find(item => item.id === paneId);
    if (pane) return pane;
  }
  return null;
}

async function statePane(paneId) {
  return paneById(await client.request('state'), paneId);
}

async function main() {
  const codex = codexFixture();
  fakeCodexClient = codex.client;
  daemon = await startServer({
    dataDir,
    pipeName,
    codex: {
      intervalMs: 60000,
      connect: codex.connect,
      listProcesses: async () => processRows.map(row => ({ ...row })),
    },
  });
  client = await connect({ dataDir, pipeName, connectTimeout: 2000 });

  const environment = await client.request('environment');
  assert.equal(environment.capabilities.agentActivity, true);
  assert.equal(environment.capabilities.ompHooks, true);
  assert.equal((await client.request('codex.status')).connection, 'disconnected');

  const workspace = await client.request('workspace.create', {
    name: 'Agent controller fixture',
    cwd: project,
    profileId: 'powershell',
  });
  const panes = [workspace.panes[0]];
  for (let index = 1; index < 4; index += 1) {
    panes.push(await client.request('pane.split', {
      paneId: panes[0].id,
      direction: index % 2 ? 'vertical' : 'horizontal',
    }));
  }
  assert.ok(panes.every(pane => pane.status === 'running' && pane.pid > 0));

  const localAppData = process.env.LOCALAPPDATA || path.join(project, 'AppData', 'Local');
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
  const omp = agentProcess(panes[0], 1, {
    name: 'omp.exe',
    executable: path.win32.join(localAppData, 'omp', 'omp.exe'),
    commandLine: 'omp',
  });
  const pi = agentProcess(panes[1], 2, {
    name: 'node.exe',
    executable: nodeExe,
    commandLine: `"${nodeExe}" "C:\\npm\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js"`,
  });
  const claude = agentProcess(panes[2], 3, {
    name: 'node.exe',
    executable: nodeExe,
    commandLine: `"${nodeExe}" "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"`,
  });
  const hermesClient = agentProcess(panes[3], 4, {
    name: 'hermes.exe',
    executable: path.win32.join(localAppData, 'hermes', 'bin', 'hermes.exe'),
    commandLine: 'hermes',
  });
  const hermesGateway = agentProcess(panes[3], 5, {
    pid: 900123,
    ppid: 1,
    name: 'hermes.exe',
    executable: path.win32.join(localAppData, 'hermes', 'bin', 'hermes.exe'),
    commandLine: 'hermes gateway',
  });
  processRows.push(
    ...panes.map(rootProcess),
    omp,
    pi,
    claude,
    hermesClient,
    hermesGateway,
  );

  const unknown = await client.request('agent.hook', {
    agentId: 'omp',
    event: 'not-a-lifecycle-event',
    sessionId: 'ignored',
    cwd: project,
    paneId: panes[0].id,
    pid: omp.pid,
    stamp: nextStamp(),
    state: 'running',
  });
  assert.deepEqual(unknown, { applied: false, reason: 'event' });

  // Frame-level protocol version: absent means v1; unsupported values reject.
  const rawHook = version => new Promise((resolve, reject) => {
    const token = fs.readFileSync(path.join(dataDir, 'ipc-token'), 'utf8').trim();
    const socket = net.createConnection(pipeName);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, index)));
    });
    socket.on('error', reject);
    const request = {
      id: `version-${JSON.stringify(version) ?? 'absent'}`,
      token,
      method: 'agent.hook',
      ...(version === undefined ? {} : { v: version }),
      params: { agentId: 'omp', event: 'agent_end', sessionId: 'version-probe', cwd: project, state: 'idle' },
    };
    socket.write(`${JSON.stringify(request)}\n`);
  });
  const rejected = await rawHook(2);
  assert.equal(rejected.error?.code, 'UNSUPPORTED_VERSION');
  const rejectedString = await rawHook('2');
  assert.equal(rejectedString.error?.code, 'UNSUPPORTED_VERSION');
  const explicitV1 = await rawHook(1);
  assert.equal(explicitV1.error, undefined, `v1 must be accepted: ${JSON.stringify(explicitV1)}`);
  const implicit = await rawHook(undefined);
  assert.equal(implicit.error, undefined, `absent v must default to v1: ${JSON.stringify(implicit)}`);

  for (const pane of panes) {
    const observed = await statePane(pane.id);
    assert.equal(observed.agentState, 'unknown');
    assert.equal(observed.agentActivity, undefined);
  }

  const ompStart = await client.request('agent.hook', {
    agentId: 'omp',
    event: 'agent_start',
    sessionId: 'omp-session',
    cwd: project,
    paneId: panes[0].id,
    pid: omp.pid,
    stamp: nextStamp(),
    state: 'running',
  });
  assert.equal(ompStart.applied, true);
  let observed = await statePane(panes[0].id);
  assert.equal(observed.agentId, 'omp');
  assert.equal(observed.agentLabel, 'OMP');
  assert.equal(observed.agentState, 'running');

  await client.request('agent.hook', {
    agentId: 'omp',
    event: 'tool_execution_start',
    sessionId: 'omp-session',
    cwd: project,
    paneId: panes[0].id,
    pid: omp.pid,
    stamp: nextStamp(),
    state: 'running',
    phase: 'start',
    toolName: 'Read',
    toolId: 'omp-read',
  });
  observed = await statePane(panes[0].id);
  assert.equal(observed.agentActivity, 'reading');

  await client.request('agent.hook', {
    agentId: 'omp',
    event: 'agent_end',
    sessionId: 'omp-session',
    cwd: project,
    paneId: panes[0].id,
    pid: omp.pid,
    stamp: nextStamp(),
    state: 'completed',
  });
  observed = await statePane(panes[0].id);
  assert.equal(observed.agentState, 'completed');
  assert.equal(observed.agentActivity, undefined, 'completed work must clear the caption');

  const piStartStamp = nextStamp();
  await client.request('agent.hook', {
    agentId: 'pi',
    event: 'tool_execution_start',
    sessionId: 'pi-session',
    cwd: project,
    paneId: panes[1].id,
    pid: pi.pid,
    stamp: piStartStamp,
    state: 'running',
    phase: 'start',
    toolName: 'bash',
    toolId: 'pi-command',
  });
  observed = await statePane(panes[1].id);
  assert.equal(observed.agentId, 'pi');
  assert.equal(observed.agentState, 'running');
  assert.equal(observed.agentActivity, 'command');

  await client.request('agent.hook', {
    agentId: 'claude',
    event: 'PreToolUse',
    sessionId: 'claude-session',
    cwd: project,
    paneId: panes[2].id,
    state: 'running',
    phase: 'start',
    toolName: 'Edit',
    toolId: 'claude-edit',
  });
  observed = await statePane(panes[2].id);
  assert.equal(observed.agentId, 'claude');
  assert.equal(observed.agentState, 'running');
  assert.equal(observed.agentActivity, 'editing');

  const observer = await client.request('agent.hook', {
    agentId: 'hermes',
    event: 'agent_start',
    sessionId: 'hermes-session',
    cwd: 'E:\\shared-gateway',
    paneId: 'stale-inherited-pane',
    pid: hermesGateway.pid,
    stamp: nextStamp(),
    state: 'running',
  });
  assert.deepEqual(observer, { applied: false, reason: 'binding-required' });
  observed = await statePane(panes[3].id);
  assert.equal(observed.agentState, 'unknown', 'a shared gateway cannot claim a pane before binding');

  let sessions = await client.request('agent.sessions');
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].sessionId, 'hermes-session');
  assert.equal(sessions.panes.find(item => item.paneId === panes[3].id).sessionId, null);

  const bound = await client.request('agent.bind', {
    paneId: panes[3].id,
    sessionId: 'hermes-session',
  });
  assert.equal(bound.applied, true);
  assert.equal(bound.sessionId, 'hermes-session');

  await client.request('agent.hook', {
    agentId: 'hermes',
    event: 'tool_execution_start',
    sessionId: 'hermes-session',
    cwd: 'E:\\shared-gateway',
    paneId: 'stale-inherited-pane',
    pid: hermesGateway.pid,
    stamp: nextStamp(),
    state: 'running',
    phase: 'start',
    toolName: 'Read',
    toolId: 'hermes-read',
  });
  observed = await statePane(panes[3].id);
  assert.equal(observed.agentId, 'hermes');
  assert.equal(observed.agentSessionId, 'hermes-session');
  assert.equal(observed.agentActivity, 'reading');
  sessions = await client.request('agent.sessions');
  assert.equal(sessions.panes.find(item => item.paneId === panes[3].id).sessionId, 'hermes-session');

  const foreignPid = await client.request('agent.hook', {
    agentId: 'pi',
    event: 'agent_start',
    sessionId: 'pi-session',
    cwd: project,
    paneId: panes[1].id,
    pid: pi.pid + 1,
    stamp: nextStamp(),
    state: 'running',
  });
  assert.deepEqual(foreignPid, { applied: false, reason: 'unmapped' });

  pi.createdAt = new Date().toISOString();
  const newGeneration = await client.request('agent.hook', {
    agentId: 'pi',
    event: 'agent_start',
    sessionId: 'pi-session',
    cwd: project,
    paneId: panes[1].id,
    pid: pi.pid + 1,
    stamp: nextStamp(),
    state: 'running',
  });
  assert.deepEqual(newGeneration, { applied: false, reason: 'unmapped' });
  observed = await statePane(panes[1].id);
  assert.equal(observed.agentState, 'unknown');

  const lateStart = await client.request('agent.hook', {
    agentId: 'pi',
    event: 'agent_start',
    sessionId: 'pi-session',
    cwd: project,
    paneId: panes[1].id,
    pid: pi.pid,
    stamp: nextStamp(),
    state: 'running',
  });
  assert.deepEqual(lateStart, { applied: false, reason: 'stale-session' });
  const resumed = await client.request('agent.hook', {
    agentId: 'pi',
    event: 'session_start',
    sessionId: 'pi-session',
    cwd: project,
    paneId: panes[1].id,
    pid: pi.pid,
    stamp: nextStamp(),
    state: 'idle',
  });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.state, 'idle');

  await assert.rejects(client.request('agent.hook', {
    agentId: 'pi',
    event: 'tool_execution_start',
    sessionId: 'pi-session',
    cwd: project,
    paneId: panes[1].id,
    pid: pi.pid,
    stamp: piStartStamp,
    state: 'running',
    phase: 'middle',
    toolName: 'Read',
    toolId: 'pi-stale',
  }), { code: 'INVALID_ARGUMENT' });

  const selectedWorkspace = await client.request('workspace.create', {
    name: 'UI-selected generic OMP',
    cwd: project,
    profileId: 'powershell',
    agentId: 'omp',
    agentHooks: false,
  });
  const selectedPane = selectedWorkspace.panes[0];
  assert.equal(selectedPane.agentId, 'omp');
  assert.equal(selectedPane.status, 'running');
  assert.equal(selectedPane.agentState, 'starting');
  const selectedOmp = agentProcess(selectedPane, 6, {
    name: 'omp.exe',
    executable: path.win32.join(localAppData, 'omp', 'omp.exe'),
    commandLine: 'omp',
  });
  processRows.push(rootProcess(selectedPane), selectedOmp);

  const selectedSession = await client.request('agent.hook', {
    agentId: 'omp',
    event: 'session_start',
    sessionId: 'selected-omp-session',
    cwd: project,
    paneId: selectedPane.id,
    pid: selectedOmp.pid,
    stamp: nextStamp(),
    state: 'idle',
  });
  assert.equal(selectedSession.applied, true);
  observed = await statePane(selectedPane.id);
  assert.equal(observed.agentPid, selectedOmp.pid);
  assert.equal(observed.agentSessionId, 'selected-omp-session');
  assert.equal(observed.agentState, 'idle');

  const selectedStart = await client.request('agent.hook', {
    agentId: 'omp',
    event: 'agent_start',
    sessionId: 'selected-omp-session',
    cwd: project,
    paneId: selectedPane.id,
    pid: selectedOmp.pid,
    stamp: nextStamp(),
    state: 'running',
  });
  assert.equal(selectedStart.applied, true);
  observed = await statePane(selectedPane.id);
  assert.equal(observed.agentState, 'running');

  const selectedTool = await client.request('agent.hook', {
    agentId: 'omp',
    event: 'tool_execution_start',
    sessionId: 'selected-omp-session',
    cwd: project,
    paneId: selectedPane.id,
    pid: selectedOmp.pid,
    stamp: nextStamp(),
    state: 'running',
    phase: 'start',
    toolName: 'Read',
    toolId: 'selected-omp-read',
  });
  assert.equal(selectedTool.applied, true);
  observed = await statePane(selectedPane.id);
  assert.equal(observed.agentActivity, 'reading');
  await client.request('pane.close', { paneId: selectedPane.id });
  const current = await client.request('state');
  assert.equal(current.workspaces.some(item => item.id === selectedWorkspace.id), false);
  assert.equal(current.workspaces.find(item => item.id === workspace.id).panes.length, 4);

  const visibleState = JSON.stringify(await client.request('state'));
  assert.doesNotMatch(visibleState, /secret|Authorization|sk-/i);
  assert.equal(
    (await client.request('codex.status')).reason,
    'starting',
    'generic agent routing must not wait for the optional Codex connection',
  );
  console.log('PASS isolated agent controller: routing, unknown states, Hermes binding, stale generations, phase validation.');
}

async function run() {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(error.stack || error);
    exitCode = 1;
  } finally {
    client?.close();
    releaseCodex?.(fakeCodexClient);
    try {
      await Promise.race([
        daemon?.close(),
        delay(5000),
      ]);
    } catch {}
    await delay(500);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
  process.exit(exitCode);
}

run();
