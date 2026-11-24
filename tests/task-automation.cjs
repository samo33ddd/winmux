'use strict';
// Automation run contract: request normalization, lifecycle reduction, the
// bounded shell-exit drain and persisted-record recovery. No daemon, no agent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ta = require('../electron/backend/task-automation.cjs');
const { loadState } = require('../electron/backend.cjs');

const ENVIRONMENT = {
  profiles: [{ id: 'powershell', environment: 'windows' }, { id: 'wsl:Debian', environment: 'wsl', distro: 'Debian' }],
  agents: [],
};
const RUN_ID = '74e2c604-5426-4f0e-b93b-33351303d1b5';
const BASE = { runId: RUN_ID, projectDirectory: 'C:/work/example', name: 'Inspect parser', profileId: 'powershell', agentId: 'codex', baseBranch: 'main', prompt: 'Describe the parser entrypoint.' };
const TASK = { id: RUN_ID, agentId: 'codex', cwd: 'C:/work/example.winmux-worktrees/' + RUN_ID, branch: 'winmux/inspect-74e2c604' };
const HASH = ta.requestHash(ta.normalizeRunStart(BASE, ENVIRONMENT));
const evidence = (channel, event, state, at, sessionId = 'session-1') => ({ channel, event, state, at, sessionId });

function freshRecord(at = 1000) {
  return ta.createRecord(HASH, at);
}
function acceptedRecord(at = 1000) {
  const record = freshRecord(at);
  ta.applyEvidence(record, evidence('session', 'UserPromptSubmit', 'running', at + 1000), {});
  return record;
}

test('automation requests reject unsupported scope and never trim the prompt', () => {
  assert.throws(() => ta.normalizeRunStart({ ...BASE, profileId: 'wsl:Debian' }, ENVIRONMENT), { code: 'UNSUPPORTED_ENVIRONMENT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, profileId: 'missing' }, ENVIRONMENT), { code: 'PROFILE_UNAVAILABLE' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, agentId: 'pi', prompt: '@notes.md summarize' }, ENVIRONMENT), { code: 'INVALID_AUTOMATION_PROMPT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, runId: RUN_ID.toUpperCase() }, ENVIRONMENT), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, mode: 'attach' }, ENVIRONMENT), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, agentId: 'unknown' }, ENVIRONMENT), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, prompt: '   ' }, ENVIRONMENT), { code: 'INVALID_AUTOMATION_PROMPT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, prompt: 'a\0b' }, ENVIRONMENT), { code: 'INVALID_AUTOMATION_PROMPT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, prompt: 'x'.repeat(16385) }, ENVIRONMENT), { code: 'INVALID_AUTOMATION_PROMPT' });
  assert.throws(() => ta.normalizeRunStart({ ...BASE, prompt: 'ж'.repeat(8193) }, ENVIRONMENT), { code: 'INVALID_AUTOMATION_PROMPT' });
  const exact = ta.normalizeRunStart({ ...BASE, prompt: 'ж'.repeat(8192) }, ENVIRONMENT);
  assert.equal(exact.prompt.length, 8192);
  const padded = '  keep surrounding spaces  ';
  assert.equal(ta.normalizeRunStart({ ...BASE, prompt: padded }, ENVIRONMENT).prompt, padded);
  // A Pi prompt that merely contains '@' is still a literal prompt.
  assert.equal(ta.normalizeRunStart({ ...BASE, agentId: 'pi', prompt: 'mail a@b.c please' }, ENVIRONMENT).prompt, 'mail a@b.c please');
});

test('the request hash covers the exact archived request, including the prompt', () => {
  const spec = ta.normalizeRunStart(BASE, ENVIRONMENT);
  assert.equal(ta.requestHash(spec), HASH);
  assert.notEqual(ta.requestHash({ ...spec, prompt: `${BASE.prompt} ` }), HASH);
  assert.notEqual(ta.requestHash({ ...spec, primaryBranch: 'main' }), HASH);
  assert.equal(ta.requestHash(ta.specForHash(spec)), HASH);
});

test('the prompt is one literal argv element for every adapter', () => {
  const prompt = 'Quote "x" `tick` $(touch pwned) --help models — Ж';
  assert.deepEqual(ta.automationArgs('codex', ['-c', 'a'], prompt), ['-c', 'a', '--', prompt]);
  assert.deepEqual(ta.automationArgs('claude', ['--settings', '{}'], prompt), ['--settings', '{}', '--', prompt]);
  assert.deepEqual(ta.automationArgs('omp', ['--append-system-prompt', 'x'], prompt), ['launch', '--append-system-prompt', 'x', '--', prompt]);
  assert.deepEqual(ta.automationArgs('pi', [], prompt), ['--', prompt]);
  assert.deepEqual(ta.automationArgs('hermes', [], prompt), ['chat', `--query=${prompt}`]);
});

test('only validated lifecycle evidence accepts and finishes the first root turn', () => {
  const record = freshRecord();
  const session = {};
  // Plain pane state, OSC and tool events never accept or finish a run.
  for (const state of ['completed', 'failed', 'running', 'waiting']) {
    assert.equal(ta.applyEvidence(record, evidence('extension', 'tool_execution_start', state, 1500), session), false);
    assert.equal(ta.applyEvidence(record, evidence('gateway', 'Stop', state, 1500), session), false);
  }
  assert.equal(record.status, 'creating');
  assert.equal(record.revision, 1);
  assert.equal(ta.applyEvidence(record, evidence('session', 'UserPromptSubmit', 'running', 2000), session), true);
  assert.equal(record.status, 'running');
  assert.equal(record.code, null);
  assert.equal(record.acceptedAt, 2000);
  assert.equal(record.revision, 2);
  assert.equal(ta.applyEvidence(record, evidence('session', 'Stop', 'completed', 3000), session), true);
  assert.equal(record.status, 'completed');
  assert.equal(record.code, null);
  assert.equal(record.finishedAt, 3000);
  assert.equal(record.revision, 3);
  // Repeated evidence never changes a revision, and a confirmed outcome is immutable.
  assert.equal(ta.applyEvidence(record, evidence('session', 'Stop', 'completed', 3500), session), false);
  assert.equal(ta.applyEvidence(record, evidence('session', 'UserPromptSubmit', 'running', 4000), session), false);
  assert.equal(ta.applyEvidence(record, evidence('session', 'StopFailure', 'failed', 5000), session), false);
  assert.equal(record.status, 'completed');
  assert.equal(record.revision, 3);
  assert.equal(record.finishedAt, 3000);
});

test('waiting, resume and continuation keep one first root turn', () => {
  const record = acceptedRecord();
  assert.equal(ta.applyEvidence(record, evidence('session', 'PermissionRequest', 'waiting', 3000), {}), true);
  assert.equal(record.status, 'waiting');
  assert.equal(record.code, 'AGENT_WAITING');
  const waitingRevision = record.revision;
  assert.equal(ta.applyEvidence(record, evidence('session', 'PermissionRequest', 'waiting', 3100), {}), false);
  assert.equal(record.revision, waitingRevision);
  assert.equal(ta.applyEvidence(record, evidence('session', 'PreToolUse', 'running', 4000), {}), true);
  assert.equal(record.status, 'running');
  assert.equal(record.code, null);
  // A continuation end (still running) does not finish the run.
  const extension = ta.createRecord(HASH, 1000);
  assert.equal(ta.applyEvidence(extension, evidence('extension', 'agent_start', 'running', 2000), {}), true);
  assert.equal(ta.applyEvidence(extension, evidence('extension', 'agent_end', 'running', 3000), {}), false);
  assert.equal(extension.status, 'running');
  assert.equal(ta.applyEvidence(extension, evidence('extension', 'agent_end', 'completed', 4000), {}), true);
  assert.equal(extension.status, 'completed');
  // The extension channel reports waiting through the approved-tool hook.
  const waiting = ta.createRecord(HASH, 1000);
  ta.applyEvidence(waiting, evidence('extension', 'agent_start', 'running', 2000), {});
  assert.equal(ta.applyEvidence(waiting, evidence('extension', 'tool_approval_requested', 'waiting', 2500), {}), true);
  assert.equal(waiting.status, 'waiting');
});

test('an aborted end and a session shutdown interrupt without acceptance', () => {
  const aborted = freshRecord();
  assert.equal(ta.applyEvidence(aborted, evidence('extension', 'agent_end', 'idle', 2000), {}), true);
  assert.equal(aborted.status, 'interrupted');
  assert.equal(aborted.code, 'AGENT_INTERRUPTED');
  const shutdown = freshRecord();
  assert.equal(ta.applyEvidence(shutdown, evidence('extension', 'session_shutdown', 'idle', 2000), {}), true);
  assert.equal(shutdown.code, 'AGENT_SESSION_ENDED');
  // A creation failure can be published before any acceptance.
  const failed = freshRecord();
  assert.equal(ta.failRun(failed, 'AGENT_HOOKS_UNSUPPORTED', 1500), true);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.acceptedAt, undefined);
  assert.equal(failed.finishedAt, 1500);
  // The same failure is idempotent.
  assert.equal(ta.failRun(failed, 'RUN_CREATE_FAILED', 1600), false);
  assert.equal(failed.code, 'AGENT_HOOKS_UNSUPPORTED');
});

test('terminal evidence without acceptance leaves the run unresolved', () => {
  for (const [channel, event, state] of [['session', 'Stop', 'completed'], ['session', 'StopFailure', 'failed'], ['extension', 'agent_end', 'completed'], ['extension', 'agent_end', 'failed']]) {
    const record = freshRecord();
    assert.equal(ta.applyEvidence(record, evidence(channel, event, state, 2000), {}), false);
    assert.equal(record.status, 'creating');
    assert.equal(record.acceptedAt, undefined);
    assert.equal(record.finishedAt, undefined);
    assert.equal(record.revision, 1);
    // A later acceptance followed by its own terminal evidence resolves it.
    assert.equal(ta.applyEvidence(record, evidence(channel, channel === 'session' ? 'UserPromptSubmit' : 'agent_start', 'running', 3000), {}), true);
    assert.equal(ta.applyEvidence(record, evidence(channel, event, state, 4000), {}), true);
    assert.equal(record.status, state === 'failed' ? 'failed' : 'completed');
  }
});

test('a different session identity proves a replacement, a missing one proves nothing', () => {
  const pinned = () => { const record = freshRecord(); const session = {}; ta.applyEvidence(record, evidence('session', 'UserPromptSubmit', 'running', 2000), session); return { record, session }; };
  const first = pinned();
  assert.equal(first.record.acceptedAt, 2000);
  assert.equal(ta.applyEvidence(first.record, evidence('session', 'Stop', 'completed', 3000, 'other-session'), first.session), true);
  assert.equal(first.record.status, 'interrupted');
  assert.equal(first.record.code, 'AGENT_REPLACED');
  // A compression keeps the plugin reporting identity and changes nothing.
  const compression = pinned();
  assert.equal(ta.applyEvidence(compression.record, evidence('extension', 'session_switch', 'idle', 3000, 'session-1'), compression.session), false);
  assert.equal(compression.record.status, 'running');
  assert.equal(compression.record.code, null);
  // A new session boundary with a different identity is a replacement.
  const boundary = pinned();
  assert.equal(ta.applyEvidence(boundary.record, evidence('extension', 'session_switch', 'idle', 3000, 'session-2'), boundary.session), true);
  assert.equal(boundary.record.code, 'AGENT_REPLACED');
  // Missing session metadata does not invalidate a confirmed outcome.
  const legacy = pinned();
  assert.equal(ta.applyEvidence(legacy.record, { channel: 'session', event: 'Stop', state: 'completed', at: 3000, sessionId: null }, legacy.session), true);
  assert.equal(legacy.record.status, 'completed');
});

test('a shell-observed exit stays private until the drain resolves it', () => {
  // In-window lifecycle evidence replaces the pending exit.
  const record = acceptedRecord();
  const revision = record.revision;
  assert.equal(ta.observeExit(record, 7, 3000), true);
  assert.equal(record.status, 'running');
  assert.equal(record.revision, revision);
  assert.equal(record.finishedAt, undefined);
  assert.deepEqual(record.exit, { outcome: 'failed', code: 'AGENT_EXITED', observedAt: 3000 });
  assert.equal(ta.runView(TASK, record).finishedAt, null);
  assert.equal(ta.runView(TASK, record).status, 'running');
  // A duplicate observation never moves the deadline.
  assert.equal(ta.observeExit(record, 3, 3500), false);
  assert.equal(record.exit.observedAt, 3000);
  assert.equal(ta.applyEvidence(record, evidence('session', 'Stop', 'completed', 4000), {}), true);
  assert.equal(record.status, 'completed');
  assert.equal(record.exit, undefined);
  assert.equal(ta.expireExit(record, 13000), false);

  // No evidence: the window publishes one bounded outcome.
  const expired = acceptedRecord();
  ta.observeExit(expired, 2, 3000);
  assert.equal(ta.expireExit(expired, 13000), true);
  assert.equal(expired.status, 'failed');
  assert.equal(expired.code, 'AGENT_EXITED');
  assert.equal(expired.finishedAt, 13000);
  assert.equal(expired.revision, 3);
  // Late evidence after expiry is ignored.
  assert.equal(ta.applyEvidence(expired, evidence('session', 'Stop', 'completed', 14000), {}), false);
  assert.equal(expired.status, 'failed');

  // A zero exit proves nothing about the turn.
  const zero = acceptedRecord();
  ta.observeExit(zero, 0, 3000);
  ta.expireExit(zero, 13000);
  assert.equal(zero.status, 'interrupted');
  assert.equal(zero.code, 'AGENT_EXITED_UNCONFIRMED');
  // A vanished process carries no code at all.
  const vanished = acceptedRecord();
  ta.observeExit(vanished, null, 3000);
  ta.expireExit(vanished, 13000);
  assert.equal(vanished.code, 'AGENT_EXITED_UNCONFIRMED');
});

test('run views expose only public metadata', () => {
  const record = acceptedRecord();
  ta.observeExit(record, 4, 3000);
  record.workspaceId = 'b9c0a35e-1f1e-4a01-9d5b-2c9f9c0e2f11';
  record.paneId = 'b9c0a35e-1f1e-4a01-9d5b-2c9f9c0e2f12';
  const view = ta.runView(TASK, record);
  assert.deepEqual(Object.keys(view).sort(), ['acceptedAt', 'agentId', 'branch', 'code', 'createdAt', 'cwd', 'finishedAt', 'paneId', 'revision', 'runId', 'status', 'updatedAt', 'workspaceId']);
  assert.equal(JSON.stringify(view).includes('exit'), false);
  assert.equal(view.runId, RUN_ID);
  assert.equal(view.status, 'running');
});

function stateFileWith(record, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-automation-state-'));
  const file = path.join(dir, 'state.json');
  const task = { id: RUN_ID, name: 'Inspect parser', projectId: 'project', cwd: 'C:/work/example.winmux-worktrees/' + RUN_ID,
    branch: 'winmux/inspect-74e2c604', base: 'main', agentId: 'codex', managed: true, archived: false, phase: 'ready', ...overrides, automation: record };
  const document = { version: 3, state: {
    workspaces: [],
    projects: [{ id: 'project', name: 'example', root: 'C:/work/example', commonDir: 'C:/work/example/.git', profileId: 'powershell', primaryBranch: 'main' }],
    tasks: [task], notifications: [], settings: { fontSize: 14, theme: 'dark' },
  } };
  fs.writeFileSync(file, JSON.stringify(document));
  return { dir, file, document };
}

test('a persisted non-terminal run is normalized on restart without replaying the prompt', () => {
  const pending = acceptedRecord();
  ta.observeExit(pending, 5, 3000);
  const { dir, file, document } = stateFileWith(pending);
  try {
    const before = fs.readFileSync(file);
    const state = loadState(file);
    const record = state.tasks[0].automation;
    assert.equal(record.status, 'interrupted');
    assert.equal(record.code, 'DAEMON_RESTARTED');
    assert.equal(typeof record.finishedAt, 'number');
    assert.equal(record.exit, undefined);
    assert.equal(record.revision, pending.revision + 1);
    assert.equal(record.acceptedAt, pending.acceptedAt);
    // The recovery backup is the untouched original.
    const backups = fs.readdirSync(dir).filter(name => name.startsWith('state.json.recovery-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, backups[0])), before);
    assert.deepEqual(before, Buffer.from(JSON.stringify(document)));
    // No prompt or captured output reached the persisted record.
    const serialized = JSON.stringify(state.tasks[0]);
    assert.equal(serialized.includes('Describe the parser'), false);
    const allowed = ['version', 'requestHash', 'status', 'code', 'revision', 'createdAt', 'updatedAt', 'acceptedAt', 'finishedAt', 'workspaceId', 'paneId', 'exit'];
    for (const key of Object.keys(record)) assert.ok(allowed.includes(key), `unexpected record field ${key}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a confirmed run and an archived tombstone survive a restart unchanged', () => {
  const completed = acceptedRecord();
  ta.applyEvidence(completed, evidence('session', 'Stop', 'completed', 3000), {});
  const { dir, file } = stateFileWith(completed, { archived: true });
  try {
    const state = loadState(file);
    assert.equal(state.tasks[0].archived, true);
    assert.equal(state.tasks[0].automation.status, 'completed');
    assert.equal(state.tasks[0].automation.revision, completed.revision);
    assert.equal(fs.readdirSync(dir).some(name => name.startsWith('state.json.recovery-')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed automation records fail the whole state', () => {
  const valid = acceptedRecord();
  const cases = [
    ['bad version', { ...valid, version: 2 }],
    ['bad hash', { ...valid, requestHash: 'x'.repeat(64) }],
    ['bad status', { ...valid, status: 'ready' }],
    ['bad code', { ...valid, code: 'lowercase' }],
    ['bad revision', { ...valid, revision: 0 }],
    ['bad timestamp', { ...valid, createdAt: -1 }],
    ['inverted timestamps', { ...valid, updatedAt: valid.createdAt - 1 }],
    ['finish without terminal status', { ...valid, finishedAt: 2000 }],
    ['terminal without finish', { ...valid, status: 'completed' }],
    ['exit after finishing', { ...acceptedRecord(), status: 'completed', finishedAt: 2000, exit: { outcome: 'failed', code: 'AGENT_EXITED', observedAt: 1000 } }],
    ['bad exit shape', { ...valid, exit: { outcome: 'failed', code: 'AGENT_EXITED' } }],
    ['unknown field', { ...valid, prompt: 'leak' }],
    ['non-uuid task', valid],
  ];
  for (const [label, record] of cases) {
    const { dir, file } = stateFileWith(record, label === 'non-uuid task' ? { id: 'task-1' } : {});
    try { assert.throws(() => loadState(file), { code: 'STATE_INVALID' }, label); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('duplicate run identifiers are rejected on load', () => {
  const record = acceptedRecord();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-automation-state-'));
  try {
    const file = path.join(dir, 'state.json');
    const task = { id: RUN_ID, name: 'Inspect parser', projectId: 'project', cwd: 'C:/work/example.winmux-worktrees/' + RUN_ID,
      branch: 'winmux/inspect-74e2c604', base: 'main', agentId: 'codex', managed: true, archived: false, phase: 'ready', automation: record };
    fs.writeFileSync(file, JSON.stringify({ version: 3, state: {
      workspaces: [],
      projects: [{ id: 'project', name: 'example', root: 'C:/work/example', commonDir: 'C:/work/example/.git', profileId: 'powershell', primaryBranch: 'main' }],
      tasks: [task, { ...task, automation: ta.createRecord(HASH, 1000) }], notifications: [], settings: { fontSize: 14, theme: 'dark' },
    } }));
    assert.throws(() => loadState(file), { code: 'STATE_INVALID' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lifecycle provenance resolves composite and WSL launch ids', () => {
  // Panes carry a launch id, not a bare adapter id: `hook:<profile>:<adapter>`
  // for hook smokes and `wsl:<distro>:<adapter>` for WSL launches.
  assert.equal(ta.agentEventState('codex', 'UserPromptSubmit'), 'running');
  assert.equal(ta.agentEventState('hook:powershell:codex', 'UserPromptSubmit'), 'running');
  assert.equal(ta.agentEventState('wsl:Ubuntu-24.04:claude', 'Stop'), 'completed');
  assert.equal(ta.agentEventState('hook:wsl:Ubuntu-24.04:claude', 'Notification'), 'waiting');
  assert.equal(ta.agentEventState('wsl:Ubuntu-24.04:pi', 'agent_end'), null, 'extension events are not session events');
  assert.equal(ta.agentEventState('unknown', 'Stop'), null);
});

test('a successor generation cannot accept or finish the run it replaced', () => {
  const record = ta.createRecord(HASH, 1000);
  const binding = { sessionId: null, drain: null };
  const first = { channel: 'extension', event: 'agent_start', state: 'running', sessionId: 'resumed', generation: 'pane:11:1000', at: 1100 };
  assert.equal(ta.applyEvidence(record, first, binding), true);
  assert.equal(record.acceptedAt, 1100);
  assert.equal(binding.generation, 'pane:11:1000');
  // The launched process exits privately; the accepted turn is still open.
  assert.equal(ta.observeExit(record, 0, 1200), true);
  // A successor in the same pane resumes the very same session id. Its events
  // describe a different process, so they are not evidence about this turn.
  for (const event of [
    { event: 'agent_start', state: 'running' },
    { event: 'tool_approval_requested', state: 'waiting' },
    { event: 'agent_end', state: 'completed' },
    { event: 'agent_end', state: 'failed' },
  ]) {
    assert.equal(ta.applyEvidence(record, { ...event, channel: 'extension', sessionId: 'resumed', generation: 'pane:22:2000', at: 1300 }, binding), false, event.event);
  }
  assert.equal(record.status, 'running');
  assert.equal(record.finishedAt, undefined);
  assert.equal(record.exit.code, 'AGENT_EXITED_UNCONFIRMED');
  // The launched generation still owns the outcome.
  assert.equal(ta.applyEvidence(record, { channel: 'extension', event: 'agent_end', state: 'completed', sessionId: 'resumed', generation: 'pane:11:1000', at: 1400 }, binding), true);
  assert.equal(record.status, 'completed');
  assert.equal(record.finishedAt, 1400);
});
