'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { connect } = require('../electron/client.cjs');
const { createController, windowsProcessTable, findCodexDescendants, isCodexProcess } = require('../electron/codex-integration.cjs');

const scratch = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hermes', 'cache', 'scratch');
fs.mkdirSync(scratch, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(scratch, 'winmux-codex-controller-'));
const project = path.join(dataDir, 'project');
fs.mkdirSync(project, { recursive: true });
const pipeName = `\\\\.\\pipe\\winmux-codex-${randomUUID()}`;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName, WINMUX_NO_PROFILE: '1' };
let daemon, client, logs = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(action, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await action()) return; await sleep(80); }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
function fixtureCodex() {
  const threads = [
    { id: 'root-a', cwd: project, parentThreadId: null, sessionId: 'session-a', name: 'Alpha', status: { type: 'idle' } },
    { id: 'root-b', cwd: project, parentThreadId: null, sessionId: 'session-b', name: 'Beta', status: { type: 'active', activeFlags: [] } },
  ];
  const loaded = ['root-a', 'root-b'];
  let listener = null;
  return {
    threads,
    async connect() {},
    async listThreads() { return { data: threads, nextCursor: null }; },
    async listLoaded() { return { data: loaded, nextCursor: null }; },
    onNotification(next) { listener = next; return () => { listener = null; }; },
    notify(message) { listener?.(message); },
    async close() {},
  };
}
function processesFor(rootPid, codexPid) {
  return [
    { pid: rootPid, ppid: 1, name: 'pwsh.exe', executable: 'C:/pwsh.exe', commandLine: 'pwsh' },
    { pid: rootPid + 1, ppid: rootPid, name: 'cmd.exe', executable: 'C:/cmd.exe', commandLine: 'cmd' },
    { pid: codexPid, ppid: rootPid + 1, name: 'codex.exe', executable: 'C:/Users/krach/.codex/bin/codex.exe', commandLine: 'codex' },
  ];
}
async function main() {
  const table = await windowsProcessTable();
  const self = table.find(row => row.pid === process.pid);
  assert(self && self.ppid > 0 && self.name, 'CIM returned this isolated test process');
  assert.equal(isCodexProcess({ name: 'codex.exe', commandLine: 'codex app-server proxy' }), false);
  const fakeRoot = 900000 + (process.pid % 1000);
  assert.deepEqual(findCodexDescendants(fakeRoot, processesFor(fakeRoot, fakeRoot + 2)), [fakeRoot + 2]);

  const fixture = fixtureCodex();
  const panes = [];
  const controller = createController({
    intervalMs: 60000,
    connect: async () => fixture,
    listProcesses: async () => processesFor(fakeRoot, fakeRoot + 2),
    panes: () => panes,
    apply(id, identity) {
      const pane = panes.find(item => item.id === id);
      if (!pane) return;
      if (!identity) { delete pane.agentId; delete pane.agentThreadId; delete pane.agentBinding; pane.agentState = 'unknown'; return; }
      Object.assign(pane, identity);
      for (const key of ['agentThreadId', 'agentSessionId', 'agentBinding']) if (pane[key] === '') delete pane[key];
    },
  });
  panes.push({ id: 'manual', pid: fakeRoot, status: 'running', cwd: project, agentState: 'unknown' });
  await controller.refresh();
  assert.equal(panes[0].agentId, 'codex', 'a proven Codex process stays visible while its thread is ambiguous');
  assert.equal(panes[0].agentLabel, 'Codex');
  assert.equal(panes[0].agentState, 'unknown');
  assert.equal(panes[0].agentThreadId, undefined, 'ambiguity must not select a thread');
  assert.equal(panes[0].agentBinding, undefined);
  assert.equal(controller.status().connection, 'connected');
  assert.equal(controller.status().panes[0].action, 'ambiguous');
  const foreignHook = await controller.hook({ agentId: 'codex', event: 'Stop', sessionId: 'session-b', cwd: project });
  assert.equal(foreignHook.applied, false, 'R1-02 a foreign hook cannot resolve full root ambiguity');
  assert.equal(panes[0].agentThreadId, undefined);

  fixture.threads.splice(1, 1); fixture.threads[0].status = { type: 'idle' };
  await controller.refresh();
  assert.equal(panes[0].agentThreadId, 'root-a');
  assert.equal(panes[0].agentState, 'idle');
  fixture.notify({ method: 'turn/completed', params: { threadId: 'root-a', turn: { status: 'completed' } } });
  assert.equal(panes[0].agentState, 'completed');
  fixture.threads[0].status = { type: 'idle' };
  await controller.refresh();
  assert.equal(panes[0].agentState, 'completed', 'idle must not erase a real completion');
  fixture.threads[0].status = { type: 'active', activeFlags: ['waitingOnUserInput'] };
  await controller.refresh();
  assert.equal(panes[0].agentState, 'waiting');
  const explicit = await controller.bind('manual', 'root-a');
  assert.equal(explicit.ok, true);

  fixture.threads.push({ id: 'root-b', cwd: project, parentThreadId: null, sessionId: 'session-b', name: 'Beta', status: { type: 'idle' } });
  await controller.refresh();
  assert.equal(panes[0].agentId, 'codex');
  assert.equal(panes[0].agentThreadId, 'root-a', 'an explicit thread remains selected when the loaded list becomes ambiguous');
  assert.equal(panes[0].agentBinding, 'explicit');
  await assert.rejects(controller.bind('manual', 'missing').then(result => { if (!result.ok) throw Object.assign(new Error(result.code), result); }), error => error.code === 'STALE_THREAD');
  fixture.notify({ method: 'turn/completed', params: { threadId: 'root-a', turn: { status: 'completed' } } });
  assert.equal(panes[0].agentState, 'completed');
  const bound = await controller.bind('manual', 'root-b');
  assert.equal(bound.ok, true);
  assert.equal(bound.state, 'idle', 'R1-05 selecting idle B cannot inherit completed A');
  assert.equal(panes[0].agentState, 'idle');
  assert.equal(panes[0].agentThreadId, 'root-b');
  assert.equal(panes[0].agentBinding, 'explicit');
  const staleHook = await controller.hook({ agentId: 'codex', event: 'Stop', sessionId: 'session-a', cwd: project, paneId: 'manual' });
  assert.equal(staleHook.applied, false);
  const exactHook = await controller.hook({ agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-b', cwd: project, paneId: 'manual' });
  assert.equal(exactHook.applied, true);
  assert.equal(panes[0].agentState, 'running');
  fixture.threads.splice(0, fixture.threads.length, fixture.threads.find(item => item.id === 'root-b'));
  await controller.refresh();
  assert.equal(panes[0].agentThreadId, 'root-b');
  assert.equal(panes[0].agentBinding, 'explicit');
  fixture.threads[0].status = { type: 'idle' };
  fixture.notify({ method: 'turn/completed', params: { threadId: 'root-b', turn: { status: 'failed' } } });
  assert.equal(panes[0].agentState, 'failed');
  await controller.refresh();
  assert.equal(panes[0].agentState, 'failed', 'idle must preserve a real failed turn');
  fixture.threads[0].sessionId = 'session-b-replacement';
  await controller.refresh();
  assert.equal(panes[0].agentState, 'idle', 'R1-05 a replacement session cannot inherit the prior failure');
  assert.equal(panes[0].agentSessionId, 'session-b-replacement');
  fixture.threads.splice(0, fixture.threads.length);
  await controller.refresh();
  assert.equal(panes[0].agentId, 'codex', 'a missing loaded thread does not hide the running Codex process');
  assert.equal(panes[0].agentState, 'unknown');
  assert.equal(panes[0].agentThreadId, undefined, 'a stale explicit thread is cleared without guessing another');
  assert.equal(panes[0].agentBinding, undefined);
  assert.equal(controller.status().panes.find(item => item.paneId === 'manual').action, 'stale');
  let reads = 0;
  fixture.listLoaded = async () => { reads += 1; throw new Error('daemon unavailable'); };
  await controller.refresh();
  assert.equal(reads, 1);
  assert.equal(controller.status().connection, 'disconnected');
  assert.equal(panes[0].agentId, 'codex', 'disconnect keeps the process-proven agent');
  assert.equal(panes[0].agentLabel, 'Codex');
  assert.equal(panes[0].agentState, 'unknown');
  assert.equal(panes[0].agentThreadId, undefined, 'disconnect clears the unverified thread binding');
  assert.equal(panes[0].agentSessionId, undefined);
  assert.equal(panes[0].agentBinding, undefined);
  assert.equal(controller.status().panes.find(item => item.paneId === 'manual').action, 'unknown');
  await controller.stop();

  daemon = spawn(process.execPath, [path.join(__dirname, '..', 'electron', 'backend.cjs')], { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', data => { logs += data; }); daemon.stderr.on('data', data => { logs += data; });
  await eventually(async () => {
    if (daemon.exitCode !== null) throw new Error(logs);
    try { client = await connect({ dataDir, pipeName, connectTimeout: 300 }); return true; } catch { return false; }
  }, 'isolated daemon');
  const environment = await client.request('environment');
  assert.equal(environment.capabilities.nativeCodex, true);
  assert.equal(environment.capabilities.protocolVersion, 3);
  const status = await client.request('codex.status');
  assert.equal(status.connection, 'disconnected', 'an isolated daemon must not attach to the user Codex daemon');
  const workspace = await client.request('workspace.create', { cwd: project, profileId: 'powershell' });
  assert.equal(workspace.panes[0].agentId, undefined);
  console.log('PASS isolated controller preserves ambiguity, stale bindings, and completion.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await client?.request('daemon.shutdown'); } catch {}
  client?.close();
  if (daemon && daemon.exitCode === null) await Promise.race([once(daemon, 'exit'), sleep(5000)]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
