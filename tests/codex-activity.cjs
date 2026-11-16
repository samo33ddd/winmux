'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createController, connectReadonly, windowsProcessTable } = require('../electron/codex-integration.cjs');

const cwd = 'E:\\projects\\winmux';
const root = { id: 'thread-1', cwd, parentThreadId: null, sessionId: 'session-1', status: { type: 'active', activeFlags: [] } };
function processes() {
  return [
    { pid: 100, ppid: 1, name: 'pwsh.exe', executable: 'C:\\pwsh.exe', commandLine: 'pwsh', createdAt: '2026-11-15T17:00:00.000Z' },
    { pid: 200, ppid: 100, name: 'codex.exe', executable: 'C:\\codex.exe', commandLine: 'codex', createdAt: '2026-11-15T17:00:01.000Z' },
  ];
}
function harness(panes, list = processes) {
  const emitter = new EventEmitter();
  const client = {
    async listThreads() { return { data: [root], nextCursor: null }; },
    async listLoaded() { return { data: [root.id], nextCursor: null }; },
    onNotification(listener) { emitter.on('notification', listener); return () => emitter.off('notification', listener); },
    async close() {},
    emit(message) { emitter.emit('notification', message); },
  };
  const controller = createController({
    intervalMs: 60000,
    connect: async () => client,
    listProcesses: list,
    panes: () => panes,
    apply(id, identity) {
      const pane = panes.find(item => item.id === id);
      if (!pane) return;
      if (!identity) { delete pane.agentId; delete pane.agentActivity; pane.agentState = 'unknown'; return; }
      Object.assign(pane, identity);
      if (identity.agentActivity == null) delete pane.agentActivity;
      for (const key of ['agentThreadId', 'agentSessionId', 'agentBinding']) if (pane[key] === '') delete pane[key];
    },
  });
  return { controller, emit: client.emit };
}
function pane(overrides = {}) {
  return { id: 'pane', pid: 100, status: 'running', cwd, agentState: 'unknown', ...overrides };
}
function item(type, id, turnId = 'turn-1', extra = {}) {
  return { method: 'item/started', params: { threadId: root.id, turnId, item: { id, type, ...extra } } };
}

test('native item and turn notifications become current activity without copying content', async () => {
  const panes = [pane()];
  const { controller, emit } = harness(panes);
  await controller.refresh();
  assert.equal(panes[0].agentBinding, 'auto');
  emit(item('commandExecution', 'cmd', 'turn-1', { command: 'secret command', output: 'secret output' }));
  emit({ method: 'item/started', params: { threadId: root.id, turnId: 'turn-1', item: { id: 'read', type: 'mcpToolCall', tool: 'read_file', arguments: { path: 'secret.txt' } } } });
  assert.equal(panes[0].agentActivity, 'reading');
  assert.equal(JSON.stringify(panes[0]).includes('secret'), false);
  emit({ method: 'item/completed', params: { threadId: root.id, turnId: 'turn-1', item: { id: 'cmd', type: 'commandExecution' } } });
  assert.equal(panes[0].agentActivity, 'reading', 'a late tool completion cannot erase the newer action');
  emit({ method: 'item/completed', params: { threadId: root.id, turnId: 'turn-1', item: { id: 'read', type: 'mcpToolCall', tool: 'read_file' } } });
  assert.equal(panes[0].agentActivity, 'thinking');
  emit({ method: 'turn/completed', params: { threadId: root.id, turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(panes[0].agentState, 'completed');
  assert.equal(panes[0].agentActivity, undefined);
  emit(item('fileChange', 'late', 'turn-1'));
  assert.equal(panes[0].agentActivity, undefined, 'an event from a closed turn cannot revive activity');
  await controller.stop();
});

test('only an exact mapped root accepts activity and a session change clears it', async () => {
  const selected = pane();
  const crowded = [selected, pane({ id: 'other', pid: 300 })];
  const ambiguous = harness(crowded, async () => processes().concat([
    { pid: 300, ppid: 1, name: 'pwsh.exe', executable: 'C:\\pwsh.exe', commandLine: 'pwsh' },
    { pid: 400, ppid: 300, name: 'codex.exe', executable: 'C:\\codex.exe', commandLine: 'codex' },
  ]));
  await ambiguous.controller.refresh();
  ambiguous.emit(item('webSearch', 'search'));
  assert.equal(selected.agentActivity, undefined);
  assert.equal(selected.agentThreadId, undefined);
  await ambiguous.controller.stop();

  const panes = [pane({ agentBinding: 'explicit', agentThreadId: root.id, agentSessionId: 'session-1', agentState: 'running' })];
  const mapped = harness(panes);
  await mapped.controller.refresh();
  mapped.emit({ method: 'turn/started', params: { threadId: root.id, turn: { id: 'turn-2' } } });
  mapped.emit(item('fileChange', 'edit', 'turn-2'));
  assert.equal(panes[0].agentActivity, 'editing');
  panes[0].agentSessionId = 'replacement';
  mapped.emit(item('commandExecution', 'next', 'turn-3'));
  assert.equal(panes[0].agentActivity, 'editing', 'an unmapped replacement session cannot inherit activity');
  await mapped.controller.refresh();
  assert.equal(panes[0].agentActivity, undefined);
  await mapped.controller.stop();
});

test('Codex activity stays hidden unless the pane is running and disconnect clears it', async () => {
  const panes = [pane()];
  let fail = false;
  const { controller, emit } = harness(panes, async () => { if (fail) throw new Error('scan failed'); return processes(); });
  await controller.refresh();
  emit(item('imageView', 'image'));
  assert.equal(panes[0].agentActivity, 'reading');
  emit({ method: 'thread/status/changed', params: { threadId: root.id, status: { type: 'idle' } } });
  assert.equal(panes[0].agentState, 'idle');
  assert.equal(panes[0].agentActivity, undefined);
  emit({ method: 'thread/status/changed', params: { threadId: root.id, status: { type: 'active', activeFlags: [] } } });
  assert.equal(panes[0].agentActivity, 'reading');
  fail = true;
  await controller.refresh();
  assert.equal(panes[0].agentState, 'unknown');
  assert.equal(panes[0].agentActivity, undefined);
  await controller.stop();
});

test('a primary non-Codex root keeps a nested Codex process from binding the pane', async () => {
  const panes = [pane()];
  const { controller } = harness(panes, async () => [
    { pid: 100, ppid: 1, name: 'pwsh.exe', executable: 'C:\\pwsh.exe', commandLine: 'pwsh' },
    { pid: 150, ppid: 100, name: 'omp.exe', executable: 'C:\\omp.exe', commandLine: 'omp' },
    { pid: 200, ppid: 150, name: 'codex.exe', executable: 'C:\\codex.exe', commandLine: 'codex' },
  ]);
  await controller.refresh();
  assert.equal(panes[0].agentId, undefined);
  assert.equal(controller.status().panes.length, 0);
  await controller.stop();
});

test('an exact hook updates the shared tracker and a non-running state clears it', async () => {
  const panes = [pane()];
  const { controller } = harness(panes);
  await controller.refresh();
  const started = await controller.hook({ agentId: 'codex', event: 'PreToolUse', sessionId: 'session-1', paneId: 'pane', phase: 'start', toolId: 'hook-tool', toolName: 'grep' });
  assert.equal(started.applied, true);
  assert.equal(panes[0].agentActivity, 'searching');
  const stopped = await controller.hook({ agentId: 'codex', event: 'Stop', sessionId: 'session-1', paneId: 'pane' });
  assert.equal(stopped.applied, true);
  assert.equal(panes[0].agentState, 'completed');
  assert.equal(panes[0].agentActivity, undefined);
  await controller.stop();
});

test('a terminal failure clears hook tool activity even while hook state owns the pane', async () => {
  const panes = [pane()];
  const { controller, emit } = harness(panes);
  await controller.refresh();
  const prompt = await controller.hook({
    agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-1', paneId: 'pane',
  });
  assert.equal(prompt.applied, true);
  const read = await controller.hook({
    agentId: 'codex', event: 'PreToolUse', sessionId: 'session-1', paneId: 'pane',
    phase: 'start', toolName: 'Read', toolId: 'read-1',
  });
  assert.equal(read.applied, true);
  assert.equal(panes[0].agentActivity, 'reading');

  emit({ method: 'turn/started', params: { threadId: root.id, turn: { id: 'turn-1' } } });
  assert.equal(panes[0].agentActivity, 'reading', 'native turn start cannot replace hook-owned activity');
  emit({ method: 'turn/completed', params: { threadId: root.id, turn: { id: 'turn-1', status: 'failed' } } });
  assert.equal(panes[0].agentState, 'failed');
  assert.equal(panes[0].agentActivity, undefined);

  const next = await controller.hook({
    agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-1', paneId: 'pane',
  });
  assert.equal(next.applied, true);
  assert.equal(panes[0].agentState, 'running');
  assert.equal(panes[0].agentActivity, 'thinking', 'a new turn cannot inherit the completed Read action');
  await controller.stop();
});

test('read-only forwarding and the shared process snapshot add no control calls', async () => {
  const seen = [];
  const daemon = new EventEmitter();
  daemon.dispose = () => {};
  const unsubscribe = connectReadonly({ daemon }).onNotification(message => seen.push(message.method));
  daemon.emit('notification', { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'one', type: 'reasoning' } } });
  daemon.emit('notification', { method: 'turn/start', params: {} });
  daemon.emit('notification', { method: 'item/commandExecution/requestApproval', params: {} });
  assert.deepEqual(seen, ['item/started']);
  unsubscribe();
  daemon.emit('notification', { method: 'turn/completed', params: {} });
  assert.deepEqual(seen, ['item/started']);

  const table = await windowsProcessTable();
  const self = table.find(row => row.pid === process.pid);
  assert.equal(typeof self?.createdAt, 'string');
  assert.equal(Number.isNaN(Date.parse(self.createdAt)), false);
  assert.equal(new Date(self.createdAt).toISOString(), self.createdAt);
});

test('production daemon bridge forwards lifecycle activity and removes its raw listener', async () => {
  const panes = [pane()];
  const daemon = new EventEmitter();
  let createCalls = 0, connectCalls = 0, refreshCalls = 0, disposeCalls = 0;
  daemon.connect = async () => { connectCalls += 1; };
  daemon.readState = () => ({ available: true, loadedThreadIds: [root.id] });
  daemon.refresh = async () => {
    refreshCalls += 1;
    return { threads: [root], loadedThreadIds: [root.id], complete: true, nextCursor: null };
  };
  daemon.dispose = () => { disposeCalls += 1; };
  const controller = createController({
    intervalMs: 60000,
    createDaemon: () => { createCalls += 1; return daemon; },
    listProcesses: async () => processes(),
    panes: () => panes,
    apply(id, identity) {
      const target = panes.find(entry => entry.id === id);
      if (!target) return;
      if (!identity) { delete target.agentId; delete target.agentActivity; target.agentState = 'unknown'; return; }
      Object.assign(target, identity);
      if (identity.agentActivity == null) delete target.agentActivity;
      for (const key of ['agentThreadId', 'agentSessionId', 'agentBinding']) if (target[key] === '') delete target[key];
    },
  });
  await controller.refresh();
  assert.equal(createCalls, 1);
  assert.equal(connectCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(daemon.listenerCount('notification'), 1);
  assert.equal(panes[0].agentBinding, 'auto');

  const emit = message => daemon.emit('notification', message);
  emit({ method: 'turn/started', params: { threadId: root.id, turn: { id: 'turn-1' } } });
  emit(item('mcpToolCall', 'read', 'turn-1', { tool: 'read_file', arguments: { path: 'secret.txt' } }));
  assert.equal(panes[0].agentActivity, 'reading');
  emit({ method: 'item/completed', params: { threadId: root.id, turnId: 'turn-1', item: { id: 'read', type: 'mcpToolCall', tool: 'read_file' } } });
  assert.equal(panes[0].agentActivity, 'thinking');
  emit(item('commandExecution', 'command', 'turn-1', { command: 'secret command' }));
  assert.equal(panes[0].agentActivity, 'command');
  emit({ method: 'item/completed', params: { threadId: root.id, turnId: 'turn-1', item: { id: 'command', type: 'commandExecution' } } });
  assert.equal(panes[0].agentActivity, 'thinking');
  emit(item('fileChange', 'edit', 'turn-1', { changes: ['secret.txt'] }));
  assert.equal(panes[0].agentActivity, 'editing');

  emit({ method: 'item/started', params: { threadId: 'foreign-root', turnId: 'foreign-turn', item: { id: 'foreign', type: 'webSearch' } } });
  emit({ method: 'item/commandExecution/requestApproval', params: { threadId: root.id, turnId: 'turn-1' } });
  assert.equal(panes[0].agentActivity, 'editing', 'foreign roots and approval requests cannot replace activity');
  assert.equal(JSON.stringify(panes[0]).includes('secret'), false);

  emit({ method: 'turn/completed', params: { threadId: root.id, turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(panes[0].agentState, 'completed');
  assert.equal(panes[0].agentActivity, undefined);
  emit(item('fileChange', 'late', 'turn-1'));
  assert.equal(panes[0].agentActivity, undefined, 'closed turns cannot revive the caption');

  await controller.stop();
  assert.equal(daemon.listenerCount('notification'), 0);
  assert.equal(disposeCalls, 1);
});

test('production daemon bridge removes raw listeners when connection setup fails', async () => {
  const daemon = new EventEmitter();
  let connectCalls = 0, disposeCalls = 0;
  daemon.connect = async () => {
    connectCalls += 1;
    assert.equal(daemon.listenerCount('notification'), 1);
    throw new Error('fixture connection failed');
  };
  daemon.readState = () => ({ available: false, loadedThreadIds: [] });
  daemon.refresh = async () => ({ threads: [], loadedThreadIds: [], complete: true, nextCursor: null });
  daemon.dispose = () => { disposeCalls += 1; };
  const controller = createController({
    intervalMs: 60000,
    createDaemon: () => daemon,
    listProcesses: async () => processes(),
    panes: () => [pane()],
  });
  await controller.refresh();
  assert.equal(connectCalls, 1);
  assert.equal(controller.status().reason, 'unavailable');
  assert.equal(daemon.listenerCount('notification'), 0);
  assert.equal(disposeCalls, 1);
  await controller.stop();
});

test('shared process observation stays available while the optional Codex connection is pending', async () => {
  let release, snapshots = 0, finished = false;
  const connection = new Promise(resolve => { release = resolve; });
  const controller = createController({
    panes: () => [{ id: 'omp-pane', pid: 100, status: 'running', cwd: 'E:/project' }],
    connect: () => connection,
    listProcesses: async () => [{ pid: 100, ppid: 1, name: 'pwsh.exe' }],
    onProcesses: () => { snapshots += 1; },
  });
  const pending = controller.refresh().then(() => { finished = true; });
  await controller.refreshProcesses();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots, 1, 'concurrent consumers share one process snapshot');
  assert.equal(finished, false, 'the optional Codex connection is still pending');
  await controller.refreshProcesses();
  assert.equal(snapshots, 2, 'other agents can refresh without waiting for Codex');
  release({ listThreads: async () => ({ data: [] }), listLoaded: async () => ({ data: [] }), onNotification: () => () => {}, close: async () => {} });
  await pending;
  await controller.stop();
});
