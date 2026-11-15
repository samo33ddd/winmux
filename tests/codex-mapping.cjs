'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  planBindings, matchHook, agentStateFor, normalizeCwd, isCodexProcess,
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

test('an explicit binding rejects a stale thread and keeps a current one', () => {
  const explicit = pane({ agentBinding: 'explicit', agentThreadId: 'gone', agentState: 'completed' });
  const stale = planBindings({ panes: [explicit], threads: [thread()], loadedIds: ['thread-1'] });
  assert.equal(stale[0].action, 'stale');
  assert.equal(stale[0].state, 'unknown', 'a stale explicit thread cannot retain a verified state');
  const current = planBindings({ panes: [pane({ agentBinding: 'explicit', agentThreadId: 'thread-1', agentState: 'completed' })], threads: [thread({ status: { type: 'idle' } })], loadedIds: ['thread-1'] });
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

test('hooks apply only to an exact binding or one verified mapping', () => {
  const panes = [pane(), pane({ id: 'other', pid: 26684, codexPid: 41000 })];
  const threads = [thread(), thread({ id: 'thread-2', sessionId: 'session-2' })];
  const ambiguous = matchHook({ agentId: 'codex', event: 'UserPromptSubmit', sessionId: 'session-1', cwd, panes, threads, loadedIds: ['thread-1', 'thread-2'] });
  assert.equal(ambiguous.action, 'ignore');
  const exact = matchHook({ agentId: 'codex', event: 'Stop', sessionId: 'session-1', paneId: 'pane', panes: [pane({ agentThreadId: 'thread-1' })], threads, loadedIds: ['thread-1'] });
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
  assert.equal(version, '0.2.1');
});
