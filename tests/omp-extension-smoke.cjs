'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(options = {}) {
  const { createWinmuxOmpExtension } = await import('../electron/hooks/winmux-omp-extension.mjs');
  const handlers = new Map();
  const sent = [];
  const factory = createWinmuxOmpExtension({}, {
    send: async payload => {
      if (options.delayFirst && sent.length === 0) await delay(30);
      sent.push(payload);
    },
  });
  factory({ on(name, handler) { handlers.set(name, handler); } });
  async function emit(name, event = {}, ctx = context()) {
    const handler = handlers.get(name);
    assert.equal(typeof handler, 'function', `missing ${name} handler`);
    return handler(event, ctx);
  }
  return { emit, handlers, sent };
}

function context(overrides = {}) {
  return {
    agent: { kind: 'main', id: 'root', name: 'main', depth: 0 },
    mode: 'tui',
    hasUI: true,
    cwd: 'E:\\project',
    isIdle: () => true,
    sessionManager: { getSessionId: () => 'omp-session-1' },
    ...overrides,
  };
}

test('publishes only from the interactive root session', async () => {
  const { emit, sent } = await fixture();
  const root = context();
  const sub = context({ agent: { kind: 'sub', id: 'task-1', name: 'explore', depth: 1, parentId: 'root' } });
  await emit('session_start', {}, root);
  await emit('session_start', {}, sub);
  await emit('agent_start', {}, context({ hasUI: false }));
  await emit('agent_start', {}, context({ mode: 'rpc' }));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    agentId: 'omp',
    event: 'session_start',
    sessionId: 'omp-session-1',
    cwd: 'E:\\project',
    pid: process.pid,
    stamp: sent[0].stamp,
    state: 'idle',
  });
  assert.match(sent[0].stamp, /^\d{1,30}$/);
});

test('publishes bounded tool identity and phase for every ordinary tool event', async () => {
  const { emit, sent } = await fixture();
  await emit('agent_start');
  for (const [toolName, toolCallId] of [['read', 'read-1'], ['edit', 'edit-1'], ['bash', 'bash-1']]) {
    await emit('tool_execution_start', {
      type: 'tool_execution_start',
      toolName,
      toolCallId,
      args: { command: 'secret command', content: 'secret content' },
    });
    await emit('tool_execution_end', {
      type: 'tool_execution_end',
      toolName,
      toolCallId,
      result: 'secret result',
    });
  }
  assert.deepEqual(sent.slice(1).map(item => [item.event, item.toolName, item.toolId, item.phase, item.state]), [
    ['tool_execution_start', 'read', 'read-1', 'start', 'running'],
    ['tool_execution_end', 'read', 'read-1', 'end', 'running'],
    ['tool_execution_start', 'edit', 'edit-1', 'start', 'running'],
    ['tool_execution_end', 'edit', 'edit-1', 'end', 'running'],
    ['tool_execution_start', 'bash', 'bash-1', 'start', 'running'],
    ['tool_execution_end', 'bash', 'bash-1', 'end', 'running'],
  ]);
  assert.equal(JSON.stringify(sent).includes('secret'), false);
});

test('overlapping ask, approval, and tool waits return to running only after all resolve', async () => {
  const { emit, sent } = await fixture();
  await emit('agent_start');
  await emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolName: 'ask',
    toolCallId: 'ask-1',
    args: { question: 'secret' },
  });
  await emit('tool_approval_requested', {
    type: 'tool_approval_requested',
    toolName: 'bash',
    toolCallId: 'approval-1',
  });
  await emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolName: 'read',
    toolCallId: 'read-1',
    args: { path: 'secret' },
  });
  await emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolName: 'read',
    toolCallId: 'read-1',
    result: 'secret',
  });
  await emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolName: 'ask',
    toolCallId: 'ask-1',
    result: 'secret',
  });
  await emit('tool_approval_resolved', { toolCallId: 'approval-1' });
  assert.deepEqual(sent.map(item => item.state), [
    'running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'running',
  ]);
  assert.deepEqual(sent.filter(item => item.toolName).map(item => [item.toolName, item.toolId, item.phase]), [
    ['ask', 'ask-1', 'start'],
    ['read', 'read-1', 'start'],
    ['read', 'read-1', 'end'],
    ['ask', 'ask-1', 'end'],
  ]);
  assert.equal(JSON.stringify(sent).includes('secret'), false);
  assert.equal(JSON.stringify(sent).includes('approval-1'), false);
});

test('nested lifecycle callbacks cannot clear root waits', async () => {
  const { emit, sent } = await fixture();
  const sub = context({ agent: { kind: 'sub', id: 'task-1', name: 'explore', depth: 1, parentId: 'root' } });
  await emit('agent_start');
  await emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolName: 'ask',
    toolCallId: 'ask-root',
    args: {},
  });
  await emit('tool_approval_requested', {
    type: 'tool_approval_requested',
    toolName: 'bash',
    toolCallId: 'approval-root',
  });
  await emit('session_start', { type: 'session_start' }, sub);
  await emit('agent_end', {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'stop' }],
  }, sub);
  await emit('session_shutdown', { type: 'session_shutdown' }, sub);
  await emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolName: 'ask',
    toolCallId: 'ask-root',
    result: {},
  });
  await emit('tool_approval_resolved', {
    type: 'tool_approval_resolved',
    toolName: 'bash',
    toolCallId: 'approval-root',
  });
  assert.deepEqual(sent.map(item => item.state), [
    'running', 'waiting', 'waiting', 'waiting', 'running',
  ]);
});

test('agent_end maps continuation, async work, failure, abort, and completion', async () => {
  const { emit, sent } = await fixture();
  await emit('agent_start');
  await emit('agent_end', { type: 'agent_end', messages: [], willContinue: true });
  await emit('agent_end', { type: 'agent_end', messages: [], willContinue: true, awaitingAsyncWork: true });
  await emit('agent_end', {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'error' }],
  });
  await emit('agent_end', {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'aborted' }],
  });
  await emit('agent_end', {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'stop' }],
  });
  assert.deepEqual(sent.map(item => item.state), ['running', 'running', 'running', 'failed', 'idle', 'completed']);
});

test('original-event stamps remain ordered through an async delivery queue', async () => {
  const { emit, sent } = await fixture({ delayFirst: true });
  const started = emit('agent_start');
  const ended = emit('agent_end', {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'stop' }],
  });
  await Promise.all([started, ended]);
  assert.deepEqual(sent.map(item => item.event), ['agent_start', 'agent_end']);
  assert.ok(BigInt(sent[1].stamp) > BigInt(sent[0].stamp));
  assert.ok(sent.every(item => /^\d{1,30}$/.test(item.stamp)));
});

test('agent_end clears pending waits and shutdown reports idle', async () => {
  const { emit, sent } = await fixture();
  await emit('agent_start');
  await emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolName: 'ask',
    toolCallId: 'ask-1',
    args: {},
  });
  await emit('agent_end', {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'stop' }],
  });
  await emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolName: 'ask',
    toolCallId: 'ask-1',
    result: {},
  });
  await emit('session_shutdown');
  assert.deepEqual(sent.map(item => item.state), ['running', 'waiting', 'completed', 'running', 'idle']);
});

test('an early-exit helper cannot surface an unhandled child stdin error', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-omp-early-exit-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const helper = path.join(temp, 'helper.cjs');
  fs.writeFileSync(helper, 'process.exit(0);\n');
  const { createWinmuxOmpExtension } = await import('../electron/hooks/winmux-omp-extension.mjs');
  const handlers = new Map();
  const factory = createWinmuxOmpExtension({
    dataDir: temp,
    helperPath: helper,
    nodePath: process.execPath,
  });
  factory({ on(name, handler) { handlers.set(name, handler); } });
  const handler = handlers.get('agent_start');
  const result = await handler({ type: 'agent_start' }, context());
  assert.equal(typeof result, 'boolean');
});
