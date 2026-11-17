'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  planBindings, matchHook, agentStateFor, normalizeCwd, isCodexProcess, createController,
} = require('../electron/codex-integration.cjs');
const version = require('../package.json').version;

const cwd = 'E:/projects/winmux';
const other = 'E:/projects/hd-helper';
function pane(overrides) {
  return { id: 'pane', pid: 18464, status: 'running', cwd, agentState: 'unknown', codexPid: 40000, codexCount: 1, ...overrides };
}
function thread(overrides) {
  return { id: 'thread-1', cwd, parentThreadId: null, sessionId: 'session-1', status: { type: 'idle' }, ...overrides };
}

test('two loaded roots for one cwd stay unbound', () => {
  const plans = planBindings({
    panes: [pane()],
    threads: [thread(), thread({ id: 'thread-2', sessionId: 'session-2' })],
    loadedIds: ['thread-1', 'thread-2'],
  });
  assert.equal(plans[0].action, 'ambiguous');
  assert.deepEqual(plans[0].candidates.sort(), ['thread-1', 'thread-2']);
});

test('two Codex processes in one pane are never bound to the only loaded thread', () => {
  const plans = planBindings({
    panes: [pane({ codexCount: 2, codexPid: 40000 })],
    threads: [thread()],
    loadedIds: ['thread-1'],
  });
  assert.equal(plans[0].action, 'ambiguous');
  assert.equal(plans[0].thread, undefined);
});

test('one descendant and one loaded root binds automatically', () => {
  const plans = planBindings({ panes: [pane()], threads: [thread(), thread({ id: 'child', parentThreadId: 'thread-1' })], loadedIds: ['thread-1', 'child'] });
  assert.equal(plans[0].action, 'auto');
  assert.equal(plans[0].thread.id, 'thread-1');
});

test('a released selector launch can map a later manual Codex process', () => {
  const locked = planBindings({ panes: [pane({ agentLaunchLocked: true })], threads: [thread()], loadedIds: ['thread-1'] });
  assert.equal(locked[0].action, 'skip', 'an active selector launch owns the pane');
  const released = planBindings({ panes: [pane({ agentLaunchLocked: false, agentState: 'completed' })], threads: [thread()], loadedIds: ['thread-1'] });
  assert.equal(released[0].action, 'auto', 'return to the shell releases the pane for native mapping');
  assert.equal(released[0].thread.id, 'thread-1');
});

test('an explicit binding rejects a stale thread and keeps a current one', () => {
  const explicit = pane({ agentBinding: 'explicit', agentThreadId: 'gone', agentState: 'completed' });
  const stale = planBindings({ panes: [explicit], threads: [thread()], loadedIds: ['thread-1'] });
  assert.equal(stale[0].action, 'stale');
  assert.equal(stale[0].state, 'unknown', 'a stale explicit thread cannot retain a verified state');
  const current = planBindings({ panes: [pane({ agentBinding: 'explicit', agentThreadId: 'thread-1', agentSessionId: 'session-1', agentState: 'completed' })], threads: [thread({ status: { type: 'idle' } })], loadedIds: ['thread-1'] });
  assert.equal(current[0].action, 'keep');
  assert.equal(current[0].state, 'completed');
});

test('idle preserves a real completion until the thread becomes active again', () => {
  assert.equal(agentStateFor('completed', { type: 'idle' }), 'completed');
  assert.equal(agentStateFor('failed', { type: 'idle' }), 'failed');
  assert.equal(agentStateFor('unknown', { type: 'idle' }), 'idle');
  assert.equal(agentStateFor('completed', { type: 'active', activeFlags: [] }), 'running');
  assert.equal(agentStateFor('running', { type: 'systemError' }), 'failed');
  assert.equal(agentStateFor('completed', { type: 'notLoaded' }), 'completed');
});

test('a hook cannot bind one pane to one session while another same-cwd root is loaded', () => {
  const panes = [pane()];
  const threads = [thread(), thread({ id: 'thread-2', sessionId: 'session-2' })];
  const plans = planBindings({ panes, threads, loadedIds: ['thread-1', 'thread-2'] });
  assert.equal(plans[0].action, 'ambiguous');
  const foreign = matchHook({ agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-2', cwd, panes, threads, loadedIds: ['thread-1', 'thread-2'] });
  assert.equal(foreign.action, 'ignore');
  assert.equal(foreign.reason, 'unmapped');
  const crowded = matchHook({ agentId: 'codex', event: 'Stop', sessionId: 'session-1', cwd, panes: [pane({ codexCount: 2 })], threads: [thread()], loadedIds: ['thread-1'] });
  assert.equal(crowded.action, 'ignore');
});

test('completion stays with its original identity while an automatic replacement resets', () => {
  const selected = pane({ agentBinding: 'explicit', agentThreadId: 'thread-1', agentSessionId: 'session-1', agentState: 'completed' });
  const plans = planBindings({ panes: [selected], threads: [thread({ status: { type: 'idle' } }), thread({ id: 'thread-2', sessionId: 'session-2', status: { type: 'idle' } })], loadedIds: ['thread-1', 'thread-2'] });
  assert.equal(plans[0].action, 'keep');
  assert.equal(plans[0].thread.id, 'thread-1');
  assert.equal(plans[0].state, 'completed');
  const automatic = planBindings({ panes: [pane({ agentThreadId: 'old', agentSessionId: 'old-session', agentState: 'failed' })], threads: [thread({ status: { type: 'idle' } })], loadedIds: ['thread-1'] });
  assert.equal(automatic[0].action, 'auto');
  assert.equal(automatic[0].state, 'idle');
});

test('hooks apply only to an exact binding or one verified mapping', () => {
  const panes = [pane(), pane({ id: 'other', pid: 26684, codexPid: 41000 })];
  const threads = [thread(), thread({ id: 'thread-2', sessionId: 'session-2' })];
  const ambiguous = matchHook({ agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-1', cwd, panes, threads, loadedIds: ['thread-1', 'thread-2'] });
  assert.equal(ambiguous.action, 'ignore');
  const exact = matchHook({ agentId: 'codex', event: 'Stop', sessionId: 'session-1', paneId: 'pane', panes: [pane({ agentThreadId: 'thread-1', agentSessionId: 'session-1', agentBinding: 'explicit' })], threads, loadedIds: ['thread-1'] });
  assert.deepEqual(exact, { action: 'apply', paneId: 'pane', state: 'completed' });
  const stale = matchHook({ agentId: 'codex', event: 'Stop', sessionId: 'session-1', paneId: 'pane', panes: [pane({ agentThreadId: 'gone' })], threads, loadedIds: ['thread-1'] });
  assert.equal(stale.reason, 'stale');
  const unique = matchHook({ agentId: 'codex', event: 'PermissionRequest', sessionId: 'session-1', cwd, panes: [pane()], threads: [thread()], loadedIds: ['thread-1'] });
  assert.equal(unique.action, 'apply');
  assert.equal(unique.state, 'waiting');
  const unrelated = matchHook({ agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-9', cwd: other, panes, threads, loadedIds: ['thread-1', 'thread-2'] });
  assert.equal(unrelated.action, 'ignore');
});

test('cwd comparison ignores slash and case differences', () => {
  assert.equal(normalizeCwd('E:/Projects/Winmux/'), normalizeCwd('e:\\projects\\winmux'));
  assert.equal(isCodexProcess({ name: 'codex.exe', commandLine: 'codex app-server proxy' }), false);
  assert.equal(version, require('../package.json').version);
});

test('R1-02 hooks retain full pane ambiguity and reject mismatched sessions', () => {
  const loadedIds = ['thread-1'];
  const threads = [thread()];
  const input = { agentId: 'codex', event: 'Stop', sessionId: 'session-1', cwd, threads, loadedIds };
  for (const paneId of [undefined, 'pane']) {
    const panes = [pane(), pane({ id: 'crowded', codexCount: 2 })];
    assert.equal(matchHook({ ...input, paneId, panes }).action, 'ignore');
    assert.equal(matchHook({ ...input, paneId, panes: [pane(), pane({ id: 'locked', agentLaunchLocked: true })] }).action, 'ignore');
    assert.equal(matchHook({ ...input, paneId, panes: [pane({ codexCount: 2 })] }).action, 'ignore');
    assert.equal(matchHook({ ...input, paneId, panes: [pane()], sessionId: 'foreign-session' }).action, 'ignore');
  }
  const explicit = pane({ agentThreadId: 'thread-1', agentSessionId: 'session-1', agentBinding: 'explicit' });
  const ambiguousThreads = [...threads, thread({ id: 'thread-2', sessionId: 'session-2' })];
  assert.equal(matchHook({ ...input, panes: [explicit], threads: ambiguousThreads, loadedIds: ['thread-1', 'thread-2'] }).action, 'apply');
  assert.equal(matchHook({ ...input, panes: [explicit], sessionId: 'session-2', threads: ambiguousThreads, loadedIds: ['thread-1', 'thread-2'] }).action, 'ignore');
  assert.equal(matchHook({ ...input, paneId: 'pane', panes: [pane({ agentThreadId: 'thread-1', agentSessionId: 'old-session', agentBinding: 'explicit' })] }).action, 'ignore');
});

test('R1-05 terminal states survive only the same thread and session identity', () => {
  for (const previousState of ['completed', 'failed']) {
    const previous = pane({ agentThreadId: 'thread-1', agentSessionId: 'session-1', agentState: previousState });
    assert.equal(agentStateFor(previous, { type: 'idle' }, { threadId: 'thread-1', sessionId: 'session-1' }), previousState);
    assert.equal(agentStateFor(previous, { type: 'idle' }, { threadId: 'thread-2', sessionId: 'session-1' }), 'idle');
    assert.equal(agentStateFor(previous, { type: 'idle' }, { threadId: 'thread-1', sessionId: 'session-2' }), 'idle');
    assert.equal(agentStateFor(previous, { type: 'notLoaded' }, { threadId: 'thread-2', sessionId: 'session-2' }), 'unknown');
    const automatic = planBindings({ panes: [previous], threads: [thread({ sessionId: 'session-2' })], loadedIds: ['thread-1'] });
    assert.equal(automatic[0].state, 'idle');
  }
});

for (const method of ['listThreads', 'listLoaded']) {
  for (const failure of ['incomplete', 'cyclic']) {
    test(`R1-03 injected ${method} ${failure} enumeration fails closed`, async t => {
      let pages = 0;
      let closed = 0;
      const selected = pane({ agentId: 'codex', agentState: 'running', agentThreadId: 'thread-1', agentSessionId: 'session-1' });
      const client = {
        async listThreads() { return { data: [thread()], nextCursor: null }; },
        async listLoaded() { return { data: ['thread-1'], nextCursor: null }; },
        close() { closed += 1; },
      };
      client[method] = async () => {
        pages += 1;
        return {
          data: method === 'listThreads' ? [thread()] : ['thread-1'],
          nextCursor: failure === 'incomplete' ? `page-${pages}` : 'repeated',
        };
      };
      const controller = createController({
        connect: async () => client,
        listProcesses: async () => [{ pid: 40000, ppid: selected.pid, name: 'codex.exe', commandLine: 'codex' }],
        panes: () => [selected],
        apply(_id, identity) { Object.assign(selected, identity); },
      });
      t.after(() => controller.stop());
      await controller.refresh();
      assert.equal(pages, failure === 'incomplete' ? 1000 : 2);
      assert.equal(controller.status().connection, 'disconnected');
      assert.deepEqual(controller.status().threads, []);
      assert.equal(selected.agentThreadId, '');
      assert.equal(selected.agentState, 'unknown');
      assert.equal(closed, 1);
    });
  }
}

test('R1-05 explicit selection resets old completion and failure through the controller', async t => {
  for (const previousState of ['completed', 'failed']) {
    const selected = pane({ agentBinding: 'explicit', agentThreadId: 'thread-1', agentSessionId: 'session-1', agentState: previousState });
    const threads = [thread(), thread({ id: 'thread-2', sessionId: 'session-2' })];
    const controller = createController({
      connect: async () => ({
        async listThreads() { return { data: threads, nextCursor: null }; },
        async listLoaded() { return { data: ['thread-1', 'thread-2'], nextCursor: null }; },
        close() {},
      }),
      listProcesses: async () => [{ pid: 40000, ppid: selected.pid, name: 'codex.exe', commandLine: 'codex' }],
      panes: () => [selected],
      apply(_id, identity) { Object.assign(selected, identity); },
    });
    t.after(() => controller.stop());
    await controller.refresh();
    assert.equal(selected.agentState, previousState);
    const bound = await controller.bind('pane', 'thread-2');
    assert.equal(bound.ok, true);
    assert.equal(bound.state, 'idle');
    assert.equal(selected.agentThreadId, 'thread-2');
    assert.equal(selected.agentSessionId, 'session-2');
    assert.equal(selected.agentState, 'idle');
  }
});

test('hook-proven activity survives native disconnect and exact pane/session identity', async t => {
  const panes = [
    pane({ id: 'pane-a', agentId: 'codex', agentBinding: 'explicit', agentThreadId: 'thread-1', agentSessionId: 'session-1', agentState: 'running' }),
    pane({ id: 'pane-b', pid: 26684, agentId: 'codex', agentBinding: 'explicit', agentThreadId: 'thread-2', agentSessionId: 'session-2', agentState: 'running' }),
  ];
  let unavailable = false;
  const listed = [thread(), thread({ id: 'thread-2', sessionId: 'session-2' })];
  const client = {
    async listThreads() { if (unavailable) throw new Error('transport disconnected'); return { data: listed, nextCursor: null }; },
    async listLoaded() { if (unavailable) throw new Error('transport disconnected'); return { data: ['thread-1', 'thread-2'], nextCursor: null }; },
    close() {},
  };
  const controller = createController({
    connect: async () => client,
    listProcesses: async () => [
      { pid: 18464, ppid: 1, name: 'pwsh.exe', executable: 'C:\\pwsh.exe', commandLine: 'pwsh' },
      { pid: 40000, ppid: 18464, name: 'codex.exe', executable: 'C:\\codex.exe', commandLine: 'codex' },
      { pid: 26684, ppid: 1, name: 'pwsh.exe', executable: 'C:\\pwsh.exe', commandLine: 'pwsh' },
      { pid: 41000, ppid: 26684, name: 'codex.exe', executable: 'C:\\codex.exe', commandLine: 'codex' },
    ],
    panes: () => panes,
    apply(_id, identity) {
      const target = panes.find(item => item.id === _id);
      if (!identity) return;
      Object.assign(target, identity);
      if (identity.agentActivity == null) delete target.agentActivity;
    },
  });
  t.after(() => controller.stop());
  await controller.refresh();

  const ambiguous = await controller.hook({ agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-1', cwd });
  assert.equal(ambiguous.applied, false, 'same-cwd hooks without a pane are not assigned by guesswork');
  const foreign = await controller.hook({ agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-1', cwd, paneId: 'pane-b' });
  assert.equal(foreign.applied, false, 'an explicit pane must match its own session');
  const exact = await controller.hook({ agentId: 'codex', event: 'PreToolUse', sessionId: 'session-1', cwd, paneId: 'pane-a', phase: 'start', toolName: 'Read', toolId: 'read-1' });
  assert.equal(exact.applied, true);
  assert.equal(panes[0].agentActivity, 'reading');

  unavailable = true;
  await controller.refresh();
  assert.equal(controller.status().connection, 'disconnected');
  assert.equal(panes[0].agentState, 'running');
  assert.equal(panes[0].agentActivity, 'reading');
  assert.equal(panes[0].agentSessionId, 'session-1');
  assert.equal(panes[1].agentState, 'unknown', 'another pane cannot borrow the hook lock');

  const stopped = await controller.hook({ agentId: 'codex', event: 'Stop', sessionId: 'session-1', cwd, paneId: 'pane-a' });
  assert.equal(stopped.applied, true);
  assert.equal(panes[0].agentState, 'completed');
  assert.equal(panes[0].agentActivity, undefined);
  await controller.refresh();
  assert.equal(panes[0].agentState, 'completed', 'a later disconnected poll cannot erase the hook result');
});
