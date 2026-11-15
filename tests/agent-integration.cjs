'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createController } = require('../electron/agent-integration.cjs');
const { hookActivity, claudeState } = require('../electron/backend/agent-status.cjs');
const { claudeSettings } = require('../electron/backend/agent-hooks.cjs');
const { createActivityTracker } = require('../electron/agent-activity.cjs');

function fixture(overrides = {}) {
  const panes = [{ id: 'pane', pid: 100, status: 'running', cwd: 'E:/project', agentState: 'unknown' }];
  const applied = [];
  const controller = createController({ panes: () => panes, now: () => 2000, monotonic: () => 1000000000000n,
    apply(id, identity) { applied.push({ id, identity }); if (identity) Object.assign(panes.find(pane => pane.id === id), identity); }, ...overrides });
  const shell = { pid: 100, ppid: 1, name: 'pwsh.exe', executable: 'C:/Program Files/PowerShell/7/pwsh.exe' };
  const omp = { pid: 200, ppid: 100, name: 'omp.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'omp', 'omp.exe'), createdAt: new Date(1000).toISOString() };
  const event = extra => ({ agentId: 'omp', event: 'agent_start', sessionId: 'session', cwd: 'E:/project', paneId: 'pane', pid: 200, stamp: '999000000001', state: 'running', ...extra });
  return { controller, panes, applied, shell, omp, event };
}

test('a primary process proves identity while only lifecycle events prove activity', () => {
  const f = fixture(); f.controller.scan([f.shell, f.omp]);
  assert.equal(f.panes[0].agentId, 'omp');
  assert.equal(f.panes[0].agentState, 'unknown');
  assert.equal(f.panes[0].agentActivity, null);
  assert.equal(f.controller.hook(f.event()).applied, true);
  assert.equal(f.panes[0].agentState, 'running');
  assert.equal(f.panes[0].agentActivity, 'thinking');
  f.controller.scan([f.shell, f.omp]);
  assert.equal(f.panes[0].agentState, 'running');
});

test('tool correlation survives overlapping work and a completion clears its caption', () => {
  const f = fixture(); f.controller.scan([f.shell, f.omp]);
  f.controller.hook(f.event({ event: 'tool_execution_start', phase: 'start', toolName: 'Read', toolId: 'one' }));
  assert.equal(f.panes[0].agentActivity, 'reading');
  f.controller.hook(f.event({ stamp: '999000000002', event: 'tool_execution_start', phase: 'start', toolName: 'Bash', toolId: 'two' }));
  f.controller.hook(f.event({ stamp: '999000000003', event: 'tool_execution_end', phase: 'end', toolName: 'Read', toolId: 'one' }));
  assert.equal(f.panes[0].agentActivity, 'command');
  f.controller.hook(f.event({ stamp: '999000000004', event: 'tool_approval_requested', state: 'waiting' }));
  assert.equal(f.panes[0].agentActivity, null);
  f.controller.hook(f.event({ stamp: '999000000005', event: 'tool_approval_resolved' }));
  assert.equal(f.panes[0].agentActivity, 'command');
  f.controller.hook(f.event({ stamp: '999000000006', event: 'agent_end', state: 'completed' }));
  assert.equal(f.panes[0].agentActivity, null);
});

test('foreign panes, child PIDs, old stamps and process generations cannot apply events', () => {
  const f = fixture(); f.controller.scan([f.shell, f.omp]);
  assert.equal(f.controller.hook(f.event({ paneId: 'foreign' })).applied, false);
  assert.equal(f.controller.hook(f.event({ pid: 201 })).applied, false);
  assert.equal(f.controller.hook(f.event({ cwd: 'E:/different' })).applied, false);
  assert.equal(f.controller.hook(f.event({ stamp: '997000000000' })).reason, 'stale-process');
  assert.equal(f.controller.hook(f.event()).applied, true);
  assert.equal(f.controller.hook(f.event()).reason, 'stale');
  f.controller.scan([f.shell, { ...f.omp, createdAt: new Date(1900).toISOString() }]);
  assert.equal(f.panes[0].agentState, 'unknown');
  assert.equal(f.controller.hook(f.event({ stamp: '999900000000' })).reason, 'stale-session');
  assert.equal(f.controller.hook(f.event({ event: 'session_start', stamp: '999950000000', state: 'idle' })).applied, true, 'an explicit new lifecycle can resume the same session in a fresh process');
});

test('session switches retire old events and independent primary roots stay ambiguous', () => {
  const f = fixture(); f.controller.scan([f.shell, f.omp]);
  f.controller.hook(f.event());
  assert.equal(f.controller.hook(f.event({ sessionId: 'new', stamp: '999000000002' })).reason, 'session');
  assert.equal(f.controller.hook(f.event({ event: 'session_switch', sessionId: 'new', stamp: '999000000003', state: 'idle' })).applied, true);
  assert.equal(f.controller.hook(f.event({ stamp: '999000000004' })).reason, 'stale-session');
  f.controller.scan([f.shell, f.omp, { ...f.omp, pid: 201 }]);
  assert.equal(f.controller.hook(f.event({ sessionId: 'new', stamp: '999000000005' })).applied, false);
});

test('Claude root hooks are scoped by the real process and exact pane/cwd/session', () => {
  const f = fixture(); f.controller.scan([f.shell, { ...f.omp, executable: 'C:/tools/claude.exe', name: 'claude.exe' }]);
  const event = { agentId: 'claude', event: 'PreToolUse', sessionId: 'claude-session', cwd: 'E:/project', paneId: 'pane', phase: 'start', toolName: 'Edit', toolId: 'edit' };
  assert.equal(f.controller.hook(event).applied, true);
  assert.equal(f.panes[0].agentActivity, 'editing');
  assert.equal(f.controller.hook({ ...event, sessionId: 'foreign' }).applied, false);
  assert.equal(f.controller.hook({ ...event, event: 'Stop' }).applied, true);
  assert.equal(f.panes[0].agentState, 'completed');
  assert.equal(f.panes[0].agentActivity, null);
});

test('per-launch hook metadata keeps only a bounded tool identifier and matching phase', () => {
  assert.deepEqual(hookActivity({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'read', tool_input: { command: 'SECRET_SENTINEL' }, prompt: 'PRIVATE' }), { phase: 'start', toolName: 'Read', toolId: 'read' });
  assert.deepEqual(hookActivity({ hook_event_name: 'Stop', tool_name: 'Read', tool_use_id: 'read' }), {});
  assert.deepEqual(hookActivity({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'x'.repeat(257) }), {});
});

test('the actual Claude session hook configuration clears a failed tool while reasoning continues', () => {
  const settings = claudeSettings({ environment: 'windows' });
  const tracker = createActivityTracker();
  const tool = { tool_name: 'Bash', tool_use_id: 'failed-command' };
  for (const hook_event_name of ['PreToolUse', 'PostToolUseFailure']) {
    assert.ok(settings.hooks[hook_event_name]?.length, `the launch must subscribe to ${hook_event_name}`);
    const event = { ...tool, hook_event_name };
    assert.equal(claudeState(event), 'running');
    tracker.update(hookActivity(event));
    assert.equal(tracker.current(), hook_event_name === 'PreToolUse' ? 'command' : 'thinking');
  }
});

test('a shared Hermes gateway requires an explicit session binding to its real client', () => {
  const f = fixture();
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  const event = f.event({ agentId: 'hermes', pid: 300, cwd: 'E:/gateway', paneId: 'stale-inherited-pane' });
  assert.equal(f.controller.hook(event).reason, 'binding-required');
  assert.equal(f.panes[0].agentState, 'unknown');
  assert.equal(f.controller.sessions().sessions.length, 1);
  assert.equal(f.controller.bind('pane', 'session').applied, true);
  assert.equal(f.panes[0].agentState, 'running');
  assert.equal(f.controller.hook({ ...event, stamp: '999000000002', event: 'tool_execution_start', phase: 'start', toolName: 'Read', toolId: 'read' }).applied, true);
  assert.equal(f.panes[0].agentActivity, 'reading');
  f.controller.scan([f.shell, client]);
  assert.equal(f.panes[0].agentState, 'unknown');
  assert.equal(f.panes[0].agentActivity, null);
});

test('an unrelated process cannot register itself as a Hermes observer', () => {
  const f = fixture();
  f.controller.scan([f.shell, f.omp, { pid: 300, ppid: 1, name: 'node.exe', executable: 'C:/tools/node.exe', commandLine: 'node other.js' }]);
  assert.equal(f.controller.hook(f.event({ agentId: 'hermes', pid: 300 })).applied, false);
  assert.equal(f.controller.sessions().sessions.length, 0);
});

test('native OMP keeps its own monotonic clock and validates wall-clock process provenance', () => {
  const f = fixture(); f.controller.scan([f.shell, f.omp]);
  assert.equal(f.controller.hook(f.event({ stamp: '521211200', emittedAt: 2000 })).applied, true);
  assert.equal(f.controller.hook(f.event({ stamp: '521211200', emittedAt: 2000 })).reason, 'stale');
  assert.equal(f.controller.hook(f.event({ stamp: '521211201', emittedAt: 5000 })).reason, 'stale');
  f.controller.scan([f.shell, { ...f.omp, createdAt: new Date(1900).toISOString() }]);
  assert.equal(f.controller.hook(f.event({ event: 'session_start', sessionId: 'fresh', stamp: '100', emittedAt: 400 })).reason, 'stale-process');
  assert.equal(f.controller.hook(f.event({ event: 'session_start', sessionId: 'fresh', stamp: '100', emittedAt: 2000 })).applied, true);
});
