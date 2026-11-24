'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createController } = require('../electron/agent-integration.cjs');
const { hookActivity, claudeState } = require('../electron/backend/agent-status.cjs');
const { claudeSettings } = require('../electron/backend/agent-hooks.cjs');
const { createActivityTracker } = require('../electron/agent-activity.cjs');
const automation = require('../electron/backend/task-automation.cjs');

function fixture(overrides = {}) {
  const panes = [{ id: 'pane', pid: 100, status: 'running', cwd: 'E:/project', agentState: 'unknown' }];
  const applied = [];
  const controller = createController({ panes: () => panes, now: () => 2000, monotonic: () => 1000000000000n,
    apply(id, identity) { applied.push({ id, identity }); if (identity) Object.assign(panes.find(pane => pane.id === id), identity); }, ...overrides });
  const shell = { pid: 100, ppid: 1, name: 'pwsh.exe', executable: 'C:/Program Files/PowerShell/7/pwsh.exe' };
  const omp = { pid: 200, ppid: 100, name: 'omp.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'omp', 'omp.exe'), createdAt: new Date(1000).toISOString(), processIdentity: '638000000000000000' };
  const event = extra => ({ agentId: 'omp', event: 'agent_start', sessionId: 'session', cwd: 'E:/project', paneId: 'pane', pid: 200, stamp: '999000000001', state: 'running', processIdentity: omp.processIdentity, ...extra });
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

test('ordinary pane status survives a process identity becoming available', () => {
  const lost = [];
  const f = fixture({ onIdentityLost: (...args) => lost.push(args) });
  f.controller.scan([f.shell, { ...f.omp, processIdentity: '' }]);
  assert.equal(f.controller.hook(f.event({ processIdentity: undefined })).applied, true);
  f.controller.scan([f.shell, f.omp]);
  assert.equal(f.panes[0].agentState, 'running');
  assert.equal(lost.length, 0);
  assert.equal(f.controller.hook(f.event({ event: 'agent_end', state: 'completed', stamp: '999000000002' })).applied, true);
});

test('an incomplete initial automation identity is never promoted by an ambiguous PID', () => {
  const lifecycle = [], lost = [];
  const f = fixture({ holdIdentity: () => true, onLifecycle: event => lifecycle.push(event), onIdentityLost: (...args) => lost.push(args) });
  f.controller.scan([f.shell, { ...f.omp, processIdentity: '' }]);
  assert.equal(f.controller.hasCandidate(f.event()), false);
  assert.equal(f.controller.hook(f.event()).reason, 'unverified-generation');
  f.controller.scan([f.shell, f.omp]);
  assert.equal(f.controller.hook(f.event()).reason, 'unverified-generation');
  assert.equal(lifecycle.length, 0);
  assert.equal(lost.length, 0);
  f.controller.scan([f.shell, { ...f.omp, createdAt: new Date(1900).toISOString() }]);
  assert.equal(lost.length, 1, 'a different creation time proves replacement');
});

test('unavailable snapshots and process disappearance retain an unaccepted run without inventing an exit', () => {
  const record = automation.createRecord('a'.repeat(64), 1000), session = {};
  const losses = [];
  const f = fixture({
    holdIdentity: () => !automation.isTerminal(record.status),
    onIdentityLost: (...args) => losses.push(args),
    onLifecycle: event => automation.applyEvidence(record, { ...event, channel: 'extension', at: event.receivedAt }, session),
  });
  f.controller.scan([f.shell, f.omp]);
  f.controller.scan([], false);
  assert.equal(losses.length, 0);
  assert.equal(record.exit, undefined);
  f.controller.scan([f.shell], true, { epoch: 2000, monotonic: 1000000000000n });
  assert.equal(losses.length, 0);
  assert.equal(record.acceptedAt, undefined);
  assert.equal(record.exit, undefined);
  assert.equal(f.controller.hook(f.event({ emittedAt: 1998 })).applied, true);
  assert.equal(f.controller.hook(f.event({ event: 'agent_end', state: 'completed', stamp: '999000000002', emittedAt: 1999 })).applied, true);
  assert.equal(record.status, 'completed');
  assert.equal(record.exit, undefined);

});

test('an unheld disappearance retires identity and a held identity cannot survive replacement or pane removal', () => {
  const ordinary = fixture();
  ordinary.controller.scan([ordinary.shell, ordinary.omp]);
  assert.equal(ordinary.controller.hook(ordinary.event()).applied, true);
  ordinary.controller.scan([ordinary.shell]);
  assert.equal(ordinary.applied.at(-1).identity, null);
  assert.equal(ordinary.controller.hook(ordinary.event({ event: 'agent_end', state: 'completed', stamp: '999000000002' })).reason, 'unmapped');

  const losses = [];
  const f = fixture({ holdIdentity: () => true, onIdentityLost: (...args) => losses.push(args) });
  f.controller.scan([f.shell, f.omp]);
  assert.equal(f.controller.hook(f.event()).applied, true);
  f.controller.scan([f.shell]);
  assert.equal(losses.length, 0);
  f.controller.scan([f.shell, { ...f.omp, createdAt: new Date(1900).toISOString(), processIdentity: '638000000000000001' }]);
  assert.equal(losses.length, 1);
  assert.notEqual(losses[0][1], losses[0][2]);
  assert.equal(f.controller.hook(f.event({ event: 'agent_end', state: 'completed', stamp: '999000000002' })).reason, 'stale-process');
  f.panes.length = 0;
  f.controller.scan([f.shell]);
  assert.equal(losses.length, 2);
  assert.equal(f.controller.hook(f.event({ stamp: '999000000003' })).reason, 'unmapped');
});

test('held OMP identity accepts only events from the original process even across an omitted snapshot', () => {
  const losses = [], events = [];
  const f = fixture({ holdIdentity: () => true, onIdentityLost: (...args) => losses.push(args), onLifecycle: event => events.push(event) });
  f.controller.scan([f.shell, f.omp]);
  f.controller.scan([], false, { epoch: 1700, monotonic: 999000000010n });
  assert.equal(f.controller.hasCandidate(f.event()), false);
  assert.equal(f.controller.hook(f.event({ emittedAt: 1600, processIdentity: undefined })).reason, 'unverified-generation');
  f.controller.scan([f.shell], true, { epoch: 1800, monotonic: 999000000020n });
  f.controller.scan([f.shell], true, { epoch: 1950, monotonic: 999000000030n });
  assert.equal(f.controller.hook(f.event({ emittedAt: 1799, processIdentity: '638000000000000001' })).reason, 'stale-process');
  assert.equal(f.controller.hook(f.event({ emittedAt: 1900 })).applied, true);
  assert.equal(f.controller.hook(f.event({ event: 'agent_end', state: 'completed', stamp: '999000000002', emittedAt: 1901 })).applied, true);
  assert.equal(events.length, 2);
  f.controller.scan([f.shell, f.omp]);
  assert.equal(f.controller.hasCandidate(f.event()), true);
  assert.equal(losses.length, 0);
});

test('held Pi identity rejects a successor even before the cutoff and reports a reused PID generation', () => {
  const losses = [], events = [];
  const f = fixture({ holdIdentity: () => true, onIdentityLost: (...args) => losses.push(args), onLifecycle: event => events.push(event) });
  const pi = { ...f.omp, name: 'pi.exe', executable: 'C:/tools/pi.exe' };
  const event = extra => f.event({ agentId: 'pi', ...extra });
  f.controller.scan([f.shell, pi]);
  f.controller.scan([f.shell], true, { epoch: 2000, monotonic: 999000000010n });
  assert.equal(f.controller.hasCandidate(event()), false);
  assert.equal(f.controller.hook(event({ stamp: '999000000009', processIdentity: '638000000000000001' })).reason, 'stale-process');
  assert.equal(f.controller.hook(event({ stamp: '999000000010' })).applied, true);
  f.controller.scan([f.shell, { ...pi, processIdentity: '638000000000000001' }]);
  assert.equal(losses.length, 1);
  assert.notEqual(losses[0][1], losses[0][2]);
  assert.equal(f.controller.hook(event({ event: 'agent_end', state: 'completed', stamp: '999000000012' })).applied, false);
  assert.equal(events.length, 1);
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
  f.controller.scan([f.shell, { ...f.omp, createdAt: new Date(1900).toISOString(), processIdentity: '638000000000000001' }]);
  assert.equal(f.panes[0].agentState, 'unknown');
  assert.equal(f.controller.hook(f.event({ stamp: '999900000000' })).reason, 'stale-process');
  assert.equal(f.controller.hook(f.event({ event: 'session_start', stamp: '999950000000', state: 'idle', processIdentity: '638000000000000001' })).applied, true, 'an explicit new lifecycle can resume the same session in a fresh process');
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
  assert.equal(f.controller.hasCandidate(event), true);
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

test('legacy Hermes observer status remains visible without becoming automation evidence', () => {
  const f = fixture({ preserveObserver: () => true });
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  const event = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/gateway', sessionId: 'legacy', ...extra });
  assert.equal(f.controller.hook(event({ event: 'session_start', state: 'idle', stamp: '999000000001' })).generationVerified, false);
  assert.equal(f.controller.hook(event({ event: 'agent_start', state: 'running', stamp: '999000000002' })).generationVerified, false);
  assert.equal(f.controller.sessions().sessions[0].state, 'running');
  assert.equal(f.controller.bind('pane', 'legacy', { cwd: 'E:/gateway', notBefore: 1000 }).applied, false);
  assert.equal(f.controller.bind('pane', 'legacy').applied, true);
});

test('an unrelated process cannot register itself as a Hermes observer', () => {
  const f = fixture();
  f.controller.scan([f.shell, f.omp, { pid: 300, ppid: 1, name: 'node.exe', executable: 'C:/tools/node.exe', commandLine: 'node other.js' }]);
  assert.equal(f.controller.hook(f.event({ agentId: 'hermes', pid: 300 })).applied, false);
  assert.equal(f.controller.sessions().sessions.length, 0);
});

test('a verified Hermes observer retains one bounded first turn for explicit replay', () => {
  const f = fixture({ holdIdentity: () => true, preserveObserver: () => true });
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  const event = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/gateway', sessionId: 'root', processIdentity: gateway.processIdentity, ...extra });
  assert.equal(f.controller.hook(event({ event: 'session_start', stamp: '999000000001', state: 'idle' })).reason, 'binding-required');
  f.controller.scan([], false);
  assert.equal(f.controller.sessions().sessions.length, 1);
  assert.equal(f.controller.hook(event({ event: 'agent_start', stamp: '999000000002', state: 'running', processIdentity: undefined })).reason, 'unverified');
  f.controller.scan([f.shell, client, gateway]);
  assert.equal(f.controller.hook(event({ event: 'agent_start', stamp: '999000000002', state: 'running' })).reason, 'binding-required');
  // A compression keeps the plugin's stable reporting id and its retained pieces.
  assert.equal(f.controller.hook(event({ event: 'session_switch', stamp: '999000000003', state: 'idle' })).reason, 'binding-required');
  for (let index = 0; index < 6; index++) {
    assert.equal(f.controller.hook(event({ event: 'tool_approval_requested', stamp: `99900000001${index}`, state: 'waiting' })).reason, 'binding-required');
  }
  assert.equal(f.controller.hook(event({ event: 'agent_end', stamp: '999000000099', state: 'completed' })).reason, 'binding-required');
  // The first start and the first terminal survive later evidence, bounded to three pieces.
  const bound = f.controller.bind('pane', 'root');
  assert.equal(bound.applied, true);
  assert.deepEqual(bound.retained.map(piece => piece.event), ['agent_start', 'tool_approval_requested', 'agent_end']);
  assert.ok(bound.retained.length <= 3, 'retention is bounded');
  assert.equal(bound.retained.at(-1).state, 'completed');
  assert.equal(f.panes[0].agentState, 'completed');
  // A repeated ordinary bind is idempotent, and later evidence keeps applying.
  assert.equal(f.controller.bind('pane', 'root').applied, true);
  assert.equal(f.controller.hook(event({ event: 'agent_end', stamp: '999000000100', state: 'failed' })).applied, true);
});

test('a Hermes root start cannot reuse a session boundary from another directory', () => {
  const f = fixture();
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  const report = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/first', sessionId: 'root', processIdentity: gateway.processIdentity, ...extra });
  assert.equal(f.controller.hook(report({ event: 'session_start', state: 'idle', stamp: '999000000001' })).reason, 'binding-required');
  assert.equal(f.controller.hook(report({ cwd: 'E:/second', event: 'agent_start', state: 'running', stamp: '999000000002' })).reason, 'cwd');
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'E:/first', notBefore: 1000 }).applied, false);
  assert.equal(f.controller.hook(report({ cwd: 'E:/second', event: 'session_start', state: 'idle', stamp: '999000000003' })).reason, 'binding-required');
  assert.equal(f.controller.hook(report({ cwd: 'E:/second', event: 'agent_start', state: 'running', stamp: '999000000004' })).reason, 'binding-required');
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'E:/first', notBefore: 1000 }).applied, false);
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'E:/second', notBefore: 1000 }).applied, true);
});

test('a bound Hermes automation rejects another directory and treats its boundary as replacement', () => {
  const lifecycle = [], lost = [];
  const f = fixture({ onLifecycle: event => lifecycle.push(event), onIdentityLost: (...args) => lost.push(args) });
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  const report = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/project', sessionId: 'root', processIdentity: gateway.processIdentity, ...extra });
  assert.equal(f.controller.hook(report({ event: 'session_start', state: 'idle', stamp: '999000000001' })).reason, 'binding-required');
  assert.equal(f.controller.hook(report({ event: 'agent_start', state: 'running', stamp: '999000000002' })).reason, 'binding-required');
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'E:/project', notBefore: 1000 }).applied, true);
  assert.equal(f.controller.hook(report({ cwd: 'E:/other', event: 'agent_end', state: 'completed', stamp: '999000000003' })).reason, 'cwd');
  assert.equal(lifecycle.length, 0, 'wrong-directory completion never reaches the reducer');
  assert.equal(f.controller.hook(report({ cwd: 'E:/other', event: 'session_start', state: 'idle', stamp: '999000000004' })).reason, 'cwd');
  assert.equal(lost.length, 1);
  assert.ok(lost[0][2], 'a verified boundary in another directory proves replacement');
});

test('retained and live Hermes evidence share the bound observer generation', () => {
  const lifecycle = [];
  const f = fixture({ onLifecycle: event => lifecycle.push(event) });
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1, processIdentity: '638000000000000010' };
  const event = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/project', sessionId: 'root', processIdentity: gateway.processIdentity, ...extra });
  f.controller.scan([f.shell, client, gateway]);
  f.controller.hook(event({ event: 'session_start', state: 'idle', stamp: '999000000001' }));
  f.controller.hook(event({ event: 'agent_start', state: 'running', stamp: '999000000002' }));
  const bound = f.controller.bind('pane', 'root', { cwd: 'E:/project', notBefore: 1000 });
  assert.equal(bound.applied, true);
  assert.match(bound.retained[0].generation, /:observer:300:638000000000000010$/);
  assert.equal(f.controller.hook(event({ event: 'agent_end', state: 'completed', stamp: '999000000003' })).applied, true);
  assert.equal(lifecycle[0].generation, bound.retained[0].generation);
});

test('Hermes replay ignores an earlier pane boundary and rejects completion from the wrong process', () => {
  const run = automation.createRecord('a'.repeat(64), 1000), binding = {};
  const f = fixture({ holdIdentity: () => true, preserveObserver: () => true,
    onLifecycle: event => automation.applyEvidence(run, { ...event, channel: 'extension', at: event.receivedAt }, binding) });
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1, processIdentity: '638000000000000010' };
  const event = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/project', sessionId: 'root', processIdentity: gateway.processIdentity, ...extra });
  f.controller.scan([f.shell, client, gateway]);
  assert.equal(f.controller.hook(event({ pid: client.pid, paneId: 'pane', processIdentity: client.processIdentity, event: 'session_start', state: 'idle', stamp: '999000000001' })).applied, true);
  assert.equal(binding.generation, undefined);
  f.controller.hook(event({ event: 'session_start', state: 'idle', stamp: '999000000002' }));
  f.controller.hook(event({ event: 'agent_start', state: 'running', stamp: '999000000003' }));
  const bound = f.controller.bind('pane', 'root', { cwd: 'E:/project', notBefore: 1000 });
  assert.equal(bound.applied, true);
  for (const piece of bound.retained) automation.applyEvidence(run, { ...piece, channel: 'extension', sessionId: 'root' }, binding);
  assert.equal(run.status, 'running');
  assert.equal(f.controller.hook(event({ pid: client.pid, paneId: 'pane', processIdentity: client.processIdentity, event: 'agent_end', state: 'completed', stamp: '999000000004' })).applied, false);
  assert.equal(run.status, 'running');
  assert.equal(f.controller.hook(event({ event: 'agent_end', state: 'completed', stamp: '999000000005' })).applied, true);
  assert.equal(run.status, 'completed');
});

test('a held Hermes observer rejects a reused PID while accepting its original delayed events', () => {
  const lost = [], lifecycle = [];
  const f = fixture({ holdIdentity: () => true, preserveObserver: () => true,
    onIdentityLost: (...args) => lost.push(args), onLifecycle: event => lifecycle.push(event) });
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  const event = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/project', sessionId: 'root', processIdentity: gateway.processIdentity, ...extra });
  f.controller.scan([f.shell, client, gateway]);
  assert.equal(f.controller.hook(event({ event: 'session_start', state: 'idle', stamp: '999000000001' })).reason, 'binding-required');
  assert.equal(f.controller.hook(event({ event: 'agent_start', state: 'running', stamp: '999000000002' })).reason, 'binding-required');
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'E:/project', notBefore: 1000 }).applied, true);
  f.controller.scan([f.shell, client], true, { epoch: 2000, monotonic: 999000000010n });
  const end = event({ event: 'agent_end', state: 'completed', stamp: '999000000010' });
  assert.equal(f.controller.hasCandidate(end), false, 'the retained observer cannot bypass refresh');
  assert.equal(f.controller.hook({ ...end, stamp: '999000000009', processIdentity: '638000000000000001' }).reason, 'stale-process');
  assert.equal(f.controller.hook(end).applied, true);
  assert.equal(lifecycle.length, 1);
  f.controller.scan([f.shell, client, { ...gateway, processIdentity: '638000000000000001' }]);
  assert.equal(lost.length, 1);
  assert.ok(lost[0][2]);
});

test('an unavailable snapshot cannot register or bind a new Hermes observer', () => {
  const f = fixture({ holdIdentity: () => true, preserveObserver: () => true });
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  f.controller.scan([], false);
  const event = { agentId: 'hermes', pid: 300, cwd: 'E:/project', sessionId: 'new', event: 'agent_start', state: 'running', stamp: '999000000002' };
  assert.equal(f.controller.hasCandidate(event), false);
  assert.equal(f.controller.hook(event).applied, false);
  assert.equal(f.controller.sessions().sessions.length, 0);
  assert.equal(f.controller.bind('pane', 'new').applied, false);
});

test('verified Hermes observers evict the oldest at 128 while retaining bounded first-turn evidence', () => {
  const f = fixture();
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  let stamp = 999000000000n;
  const report = (sessionId, event, state) => {
    const nextStamp = String(++stamp);
    const result = f.controller.hook({ agentId: 'hermes', pid: 300, cwd: 'E:/gateway', sessionId, event, state, stamp: nextStamp, processIdentity: gateway.processIdentity });
    assert.equal(result.reason, 'binding-required');
    return nextStamp;
  };
  let newest;
  for (let index = 0; index < 129; index++) {
    const sessionId = `observer-${index}`;
    report(sessionId, 'session_start', 'idle');
    const start = report(sessionId, 'agent_start', 'running');
    report(sessionId, 'tool_approval_requested', 'waiting');
    const pending = report(sessionId, 'tool_approval_requested', 'waiting');
    const terminal = report(sessionId, 'agent_end', 'completed');
    report(sessionId, 'agent_end', 'failed');
    assert.equal(f.controller.sessions().sessions.length, Math.min(index + 1, 128));
    if (index === 128) newest = { sessionId, start, pending, terminal };
  }
  const sessions = f.controller.sessions().sessions.map(item => item.sessionId);
  assert.equal(sessions.length, 128);
  assert.equal(sessions.includes('observer-0'), false);
  assert.deepEqual(sessions, Array.from({ length: 128 }, (_, index) => `observer-${index + 1}`));
  assert.equal(f.controller.bind('pane', 'observer-0').applied, false);
  const bound = f.controller.bind('pane', newest.sessionId, { cwd: 'E:/gateway', notBefore: 2000 });
  assert.equal(bound.applied, true);
  assert.deepEqual(bound.retained.map(({ event, state, stamp: pieceStamp }) => ({ event, state, stamp: pieceStamp })), [
    { event: 'agent_start', state: 'running', stamp: newest.start },
    { event: 'tool_approval_requested', state: 'waiting', stamp: newest.pending },
    { event: 'agent_end', state: 'completed', stamp: newest.terminal },
  ]);
  for (const piece of bound.retained) {
    assert.deepEqual(Object.keys(piece).sort(), ['at', 'event', 'generation', 'stamp', 'state']);
  }
});

test('automation bind constraints reject foreign directories and pre-run evidence', () => {
  const f = fixture();
  const client = { ...f.omp, name: 'hermes.exe', executable: path.join(process.env.LOCALAPPDATA || 'C:/Users/Fixture/AppData/Local', 'hermes', 'bin', 'hermes.exe') };
  const gateway = { ...client, pid: 300, ppid: 1 };
  f.controller.scan([f.shell, client, gateway]);
  const event = extra => ({ agentId: 'hermes', pid: 300, cwd: 'E:/gateway', sessionId: 'root', processIdentity: gateway.processIdentity, ...extra });
  f.controller.hook(event({ event: 'session_start', stamp: '999000000001', state: 'idle' }));
  f.controller.hook(event({ event: 'agent_start', stamp: '999000000002', state: 'running' }));
  // A session without a retained root start cannot satisfy an automation run.
  f.controller.hook(event({ event: 'session_start', sessionId: 'anchorless', cwd: 'E:/gateway', stamp: '999000000003', state: 'idle' }));
  f.controller.hook(event({ event: 'agent_end', sessionId: 'anchorless', cwd: 'E:/gateway', stamp: '999000000004', state: 'completed' }));
  assert.equal(f.controller.bind('pane', 'anchorless', { cwd: 'E:/gateway', notBefore: 1 }).applied, false);
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'E:/other', notBefore: 1 }).applied, false);
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'E:/gateway', notBefore: 2001 }).applied, false);
  assert.equal(f.controller.bind('pane', 'missing', { cwd: 'E:/gateway', notBefore: 1 }).applied, false);
  assert.equal(f.controller.bind('pane', 'root', { cwd: 'e:/gateway/', notBefore: 2000 }).applied, true);
});

test('session hook provenance is limited to recognized events and bounded identifiers', () => {
  const { lifecycleMeta } = require('../electron/backend/agent-status.cjs');
  assert.deepEqual(lifecycleMeta('claude', { hook_event_name: 'Stop', session_id: 'abc-123' }), { event: 'Stop', sessionId: 'abc-123' });
  assert.deepEqual(lifecycleMeta('claude', { hook_event_name: 'Notification', notification_type: 'permission_prompt' }), { event: 'Notification' });
  assert.deepEqual(lifecycleMeta('codex', { hook_event_name: 'UserPromptSubmit' }), { event: 'UserPromptSubmit' });
  assert.deepEqual(lifecycleMeta('codex', { hook_event_name: 'NotAHook', session_id: 'x' }), { sessionId: 'x' }, 'an unknown event name is never forwarded');
  assert.deepEqual(lifecycleMeta('claude', { hook_event_name: 'Stop', session_id: 'bad id with spaces' }), { event: 'Stop' }, 'an invalid session id is dropped, not fabricated');
  assert.deepEqual(lifecycleMeta('claude', { hook_event_name: 'Stop', prompt: 'secret' }), { event: 'Stop' }, 'prompt content is never forwarded');
});

test('native OMP keeps its own monotonic clock and validates wall-clock process provenance', () => {
  const f = fixture(); f.controller.scan([f.shell, f.omp]);
  assert.equal(f.controller.hook(f.event({ stamp: '521211200', emittedAt: 2000 })).applied, true);
  assert.equal(f.controller.hook(f.event({ stamp: '521211200', emittedAt: 2000 })).reason, 'stale');
  assert.equal(f.controller.hook(f.event({ stamp: '521211201', emittedAt: 5000 })).reason, 'stale');
  f.controller.scan([f.shell, { ...f.omp, createdAt: new Date(1900).toISOString(), processIdentity: '638000000000000001' }]);
  assert.equal(f.controller.hook(f.event({ event: 'session_start', sessionId: 'fresh', stamp: '100', emittedAt: 400, processIdentity: '638000000000000001' })).reason, 'stale-process');
  assert.equal(f.controller.hook(f.event({ event: 'session_start', sessionId: 'fresh', stamp: '100', emittedAt: 2000, processIdentity: '638000000000000001' })).applied, true);
});
