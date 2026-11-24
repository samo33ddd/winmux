'use strict';
// One automation run owns the initial root turn of one newly created managed
// task. This module owns the request contract, the private run record and the
// lifecycle reducer. It starts no process, reads no terminal text and stores no
// prompt or captured output.
const crypto = require('node:crypto');
const { fail, string } = require('./shared.cjs');
const { AGENT_IDS, AGENTS } = require('./agent-registry.cjs');

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PROMPT_LIMIT = 16384;
const DRAIN_MS = 10000;
const STATUSES = Object.freeze(['creating', 'starting', 'running', 'waiting', 'completed', 'failed', 'interrupted']);
const TERMINAL = Object.freeze(new Set(['completed', 'failed', 'interrupted']));
const REQUEST_FIELDS = Object.freeze(['runId', 'projectDirectory', 'name', 'profileId', 'agentId', 'baseBranch', 'primaryBranch', 'prompt']);
// Agent ids this API can launch. WSL profiles are rejected separately.
const AUTOMATION_AGENTS = Object.freeze(['codex', 'claude', 'omp', 'pi', 'hermes']);
// Session-hook and project-extension evidence that carries a turn boundary.
const SESSION_TERMINAL = Object.freeze({ Stop: 'completed', StopFailure: 'failed' });
// A boundary only proves a replacement when it carries a different session
// identity; a compression keeps the plugin's stable reporting id.
const SESSION_BOUNDARY = Object.freeze(new Set(['SessionStart']));
const SESSION_SHUTDOWN = Object.freeze(new Set(['SessionEnd']));
const EXTENSION_BOUNDARY = Object.freeze(new Set(['session_start', 'session_switch']));
const EXTENSION_SHUTDOWN = Object.freeze(new Set(['session_shutdown']));

function isTerminal(status) { return TERMINAL.has(status); }

function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('INVALID_AUTOMATION_PROMPT', 'prompt must be nonempty text without NUL characters');
  if (value.length > PROMPT_LIMIT || Buffer.byteLength(value) > PROMPT_LIMIT) fail('INVALID_AUTOMATION_PROMPT', `prompt must be at most ${PROMPT_LIMIT} UTF-16 units and ${PROMPT_LIMIT} UTF-8 bytes`);
  return value;
}

// Reject a Pi prompt whose first character is '@': its CLI reads that argument
// as a file attachment even after '--', which would silently consume a file.
function validateAgentPrompt(agentId, prompt) {
  if (agentId === 'pi' && prompt.startsWith('@')) fail('INVALID_AUTOMATION_PROMPT', 'Pi interprets a prompt beginning with @ as a file attachment; rephrase it');
  return prompt;
}

function normalizeRunStart(params, environment) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('INVALID_ARGUMENT', 'Automation request must be an object');
  const unknown = Object.keys(params).filter(key => !REQUEST_FIELDS.includes(key));
  if (unknown.length) fail('INVALID_ARGUMENT', `Unknown automation request field: ${unknown[0].slice(0, 64)}`);
  const runId = params.runId;
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) fail('INVALID_ARGUMENT', 'runId must be a lowercase hyphenated UUID');
  const agentId = params.agentId;
  if (typeof agentId !== 'string' || !AGENT_IDS.includes(agentId) || !AUTOMATION_AGENTS.includes(agentId)) fail('INVALID_ARGUMENT', 'agentId must be one of codex, claude, omp, pi, hermes');
  const profileId = string(params.profileId, 'profileId', 256);
  const profile = environment?.profiles?.find(item => item.id === profileId);
  if (!profile || profile.available === false || !['windows', 'wsl'].includes(profile.environment)) fail('PROFILE_UNAVAILABLE', 'Profile shell environment is unavailable');
  // Reject a non-Windows profile before any project, task or worktree change.
  if (profile.environment !== 'windows') fail('UNSUPPORTED_ENVIRONMENT', 'Automation runs support Windows profiles only');
  return {
    runId,
    projectDirectory: string(params.projectDirectory, 'projectDirectory', 4096),
    name: string(params.name, 'name', 120).trim(),
    profileId,
    agentId,
    baseBranch: string(params.baseBranch, 'baseBranch', 256),
    primaryBranch: params.primaryBranch === undefined ? null : string(params.primaryBranch, 'primaryBranch', 256),
    prompt: validateAgentPrompt(agentId, validatePrompt(params.prompt)),
  };
}

function requestHash(spec) {
  return crypto.createHash('sha256').update(JSON.stringify([1, spec.projectDirectory, spec.name, spec.profileId, spec.agentId, spec.baseBranch, spec.primaryBranch ?? null, spec.prompt])).digest('hex');
}

// The archived/normalized request a repeat of task.run.start must match.
function specForHash(spec) {
  return { projectDirectory: spec.projectDirectory, name: spec.name, profileId: spec.profileId, agentId: spec.agentId, baseBranch: spec.baseBranch, primaryBranch: spec.primaryBranch ?? null, prompt: spec.prompt };
}

function createRecord(hash, at) {
  return { version: 1, requestHash: hash, status: 'creating', code: null, revision: 1, createdAt: at, updatedAt: at };
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('STATE_INVALID', `Invalid automation ${name}`);
  return value;
}

function validateRecord(record, task) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('STATE_INVALID', 'Invalid automation run record');
  const allowed = ['version', 'requestHash', 'status', 'code', 'revision', 'createdAt', 'updatedAt', 'acceptedAt', 'finishedAt', 'workspaceId', 'paneId', 'exit'];
  if (Object.keys(record).some(key => !allowed.includes(key)) || record.version !== 1) fail('STATE_INVALID', 'Invalid automation run record');
  if (typeof record.requestHash !== 'string' || !HASH_PATTERN.test(record.requestHash)) fail('STATE_INVALID', 'Invalid automation request hash');
  if (!STATUSES.includes(record.status)) fail('STATE_INVALID', 'Invalid automation run status');
  if (record.code !== null && (typeof record.code !== 'string' || !CODE_PATTERN.test(record.code))) fail('STATE_INVALID', 'Invalid automation run code');
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) fail('STATE_INVALID', 'Invalid automation run revision');
  timestamp(record.createdAt, 'createdAt'); timestamp(record.updatedAt, 'updatedAt');
  if (record.updatedAt < record.createdAt) fail('STATE_INVALID', 'Invalid automation run timestamps');
  if (record.acceptedAt !== undefined) timestamp(record.acceptedAt, 'acceptedAt');
  if (record.finishedAt !== undefined) {
    timestamp(record.finishedAt, 'finishedAt');
    if (!isTerminal(record.status)) fail('STATE_INVALID', 'Invalid automation run finish timestamp');
  }
  if (isTerminal(record.status) && record.finishedAt === undefined) fail('STATE_INVALID', 'Automation run ended without a finish timestamp');
  for (const key of ['workspaceId', 'paneId']) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !TASK_ID_PATTERN.test(record[key]))) fail('STATE_INVALID', `Invalid automation ${key}`);
  }
  if (record.exit !== undefined) {
    const exit = record.exit;
    if (!exit || typeof exit !== 'object' || Array.isArray(exit) || Object.keys(exit).some(key => !['outcome', 'code', 'observedAt'].includes(key))
      || !['failed', 'interrupted'].includes(exit.outcome) || typeof exit.code !== 'string' || !CODE_PATTERN.test(exit.code)) fail('STATE_INVALID', 'Invalid automation exit record');
    timestamp(exit.observedAt, 'exit time');
    // A finalized run must not retain a pending private exit.
    if (isTerminal(record.status)) fail('STATE_INVALID', 'Automation run retained an exit after finishing');
  }
  // A run record belongs to exactly one task whose ID is its run ID.
  if (!task || !RUN_ID_PATTERN.test(task.id || '') || !TASK_ID_PATTERN.test(task.id)) fail('STATE_INVALID', 'Automation task ID must be a lowercase UUID');
  return record;
}

// Persisted runs cannot survive a daemon restart: the private runtime and the
// evidence channel are gone, and a prompt must never be replayed.
function restartRecord(record, at) {
  if (isTerminal(record.status)) return false;
  record.status = 'interrupted';
  record.code = 'DAEMON_RESTARTED';
  record.finishedAt = at;
  record.updatedAt = at;
  record.revision += 1;
  delete record.exit;
  return true;
}

function runView(task, record) {
  return {
    runId: task.id,
    workspaceId: record.workspaceId ?? task.workspaceId ?? null,
    paneId: record.paneId ?? null,
    agentId: task.agentId || '',
    cwd: task.cwd,
    branch: task.branch,
    status: record.status,
    code: record.code,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    acceptedAt: record.acceptedAt ?? null,
    finishedAt: record.finishedAt ?? null,
  };
}

function publish(record, status, code, at) {
  if (record.status === status && record.code === code) return false;
  record.status = status;
  record.code = code;
  record.updatedAt = Math.max(record.updatedAt, at);
  record.revision += 1;
  return true;
}

function finish(record, status, code, at) {
  if (isTerminal(record.status)) return false;
  record.status = status;
  record.code = code;
  record.updatedAt = Math.max(record.updatedAt, at);
  record.finishedAt = record.updatedAt;
  record.revision += 1;
  delete record.exit;
  return true;
}

// Classify validated lifecycle evidence. Anything outside this table (tool
// events, OSC, notifications, quiet output) can never accept or finish a run.
function classify(evidence) {
  const { channel, event, state } = evidence;
  if (channel === 'session') {
    if (event === 'UserPromptSubmit') return { kind: 'accept' };
    if (SESSION_TERMINAL[event]) return { kind: SESSION_TERMINAL[event] };
    if (SESSION_BOUNDARY.has(event)) return { kind: 'boundary' };
    if (SESSION_SHUTDOWN.has(event)) return { kind: 'interrupted', code: 'AGENT_SESSION_ENDED' };
    if (state === 'waiting') return { kind: 'waiting' };
    if (state === 'running') return { kind: 'running' };
    return null;
  }
  if (channel !== 'extension') return null;
  if (event === 'agent_start') return { kind: 'accept' };
  if (event === 'agent_end') {
    if (state === 'completed') return { kind: 'completed' };
    if (state === 'failed') return { kind: 'failed' };
    // An idle end is a shutdown; a still-running end is a continuation.
    if (state === 'idle') return { kind: 'interrupted', code: 'AGENT_INTERRUPTED' };
    return null;
  }
  if (EXTENSION_BOUNDARY.has(event)) return { kind: 'boundary' };
  if (EXTENSION_SHUTDOWN.has(event)) return { kind: 'interrupted', code: 'AGENT_SESSION_ENDED' };
  if (event === 'tool_approval_requested') return { kind: 'waiting' };
  if (state === 'waiting') return { kind: 'waiting' };
  if (state === 'running') return { kind: 'running' };
  return null;
}

// Reduce one piece of already-validated evidence. `session` retains the session
// identity pinned by the first acceptance so a proven replacement is detectable.
// Returns true when persisted run state changed.
function applyEvidence(record, evidence, session = {}) {
  if (isTerminal(record.status)) return false;
  const at = evidence.at;
  const action = classify(evidence);
  if (!action) return false;
  // A missing optional session identity neither fabricates nor invalidates one;
  // only a present, different identity proves a replacement.
  // A boundary from a different session is a proven replacement, never evidence
  // about the turn this run accepted.
  const replaced = session.sessionId && evidence.sessionId && evidence.sessionId !== session.sessionId;
  if (action.kind === 'boundary') return replaced ? finish(record, 'interrupted', 'AGENT_REPLACED', at) : false;
  if (action.kind === 'interrupted') return finish(record, 'interrupted', replaced ? 'AGENT_REPLACED' : action.code, at);
  if (action.kind === 'accept') {
    if (!session.sessionId) session.sessionId = evidence.sessionId || null;
    else if (evidence.sessionId && evidence.sessionId !== session.sessionId) return finish(record, 'interrupted', 'AGENT_REPLACED', at);
    if (record.acceptedAt === undefined) record.acceptedAt = at;
    return publish(record, 'running', null, at);
  }
  // Every remaining action concerns a turn that must have been accepted first.
  if (record.acceptedAt === undefined) return false;
  if (session.sessionId && evidence.sessionId && evidence.sessionId !== session.sessionId) return finish(record, 'interrupted', 'AGENT_REPLACED', at);
  if (action.kind === 'waiting') return publish(record, 'waiting', 'AGENT_WAITING', at);
  if (action.kind === 'running') return publish(record, 'running', null, at);
  return finish(record, action.kind, null, at);
}

// A shell-observed exit is private evidence, not an outcome: the process may
// have emitted a valid Stop that is still queued behind the daemon mutation
// tail. Publish nothing and start the bounded drain window.
function observeExit(record, exitCode, at) {
  if (isTerminal(record.status) || record.exit) return false;
  // A nonzero command exit is a failure; a zero exit proves nothing about the
  // turn, and a vanished process gives no code at all.
  const failed = Number.isInteger(exitCode) && exitCode !== 0;
  record.exit = { outcome: failed ? 'failed' : 'interrupted', code: failed ? 'AGENT_EXITED' : 'AGENT_EXITED_UNCONFIRMED', observedAt: at };
  return true;
}

function expireExit(record, at) {
  if (isTerminal(record.status) || !record.exit) return false;
  const { outcome, code } = record.exit;
  return finish(record, outcome, code, at);
}

// Final argv around the existing configured and Winmux hook arguments. The
// prompt is always exactly one argument; it is never shell source.
function automationArgs(agentId, args, prompt) {
  switch (agentId) {
    case 'codex':
    case 'claude':
    case 'pi': return [...args, '--', prompt];
    case 'omp': return ['launch', ...args, '--', prompt];
    case 'hermes': return ['chat', ...args, `--query=${prompt}`];
    default: return [...args];
  }
}

module.exports = {
  DRAIN_MS, PROMPT_LIMIT, RUN_ID_PATTERN, STATUSES, TERMINAL, AUTOMATION_AGENTS, SESSION_PATTERN,
  isTerminal, normalizeRunStart, requestHash, specForHash, createRecord, validateRecord, restartRecord,
  runView, applyEvidence, observeExit, expireExit, automationArgs, validatePrompt, classify,
  setStatus: publish,
  closeRun: finish,
  failRun(record, code, at) { return finish(record, 'failed', code || 'RUN_CREATE_FAILED', at); },
  agentEventState(agentId, event) {
    const entry = AGENTS[agentId];
    if (!entry) return null;
    if (event === 'Notification') return 'waiting';
    return entry.eventStates?.[event] ?? null;
  },
};
