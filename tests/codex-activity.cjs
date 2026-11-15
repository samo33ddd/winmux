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
