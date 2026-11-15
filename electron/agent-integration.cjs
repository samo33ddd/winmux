'use strict';
const path = require('node:path');
const { findPrimaryAgents } = require('./agent-processes.cjs');
const { createActivityTracker } = require('./agent-activity.cjs');

const STATES = new Set(['running', 'waiting', 'idle', 'completed', 'failed']);
const SESSION_EVENTS = new Set(['session_start', 'session_switch', 'SessionStart']);
const EXTENSION_EVENTS = new Set(['session_start', 'session_switch', 'session_shutdown', 'agent_start', 'agent_end', 'tool_execution_start', 'tool_execution_end', 'tool_approval_requested', 'tool_approval_resolved']);
const CLAUDE_STATES = { SessionStart: 'idle', UserPromptSubmit: 'running', PreToolUse: 'running', PostToolUse: 'running', PostToolUseFailure: 'running', PermissionRequest: 'waiting', Stop: 'completed', StopFailure: 'failed', SessionEnd: 'idle' };
const cwdKey = value => typeof value === 'string' && value ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase() : '';

function createController(options = {}) {
  const records = new Map(), retired = new Set(), retiredSessions = new Set(), observers = new Map();
  let processes = [];
  const now = options.now || Date.now;
  const monotonic = options.monotonic || (() => process.hrtime.bigint());
  const retirementKey = (record, sessionId) => `${record.generation}:${sessionId}`;
  function retire(record) {
    record?.activity.clear();
    if (record?.sessionId) {
      retired.add(retirementKey(record, record.sessionId));
      retiredSessions.add(`${record.agent.agentId}:${record.sessionId}`);
    }
    if (retired.size > 256) retired.delete(retired.values().next().value);
    if (retiredSessions.size > 256) retiredSessions.delete(retiredSessions.values().next().value);
  }
  function identity(record) {
    return { agentId: record.agent.agentId, agentLabel: record.agent.label, agentPid: record.agent.pid,
      agentSessionId: record.sessionId || '', agentState: record.state,
      agentActivity: record.state === 'running' ? record.activity.current() : null };
  }
  function observerProcess(pid) {
    const row = processes.find(item => item.pid === pid);
    if (!row || !findPrimaryAgents(row.ppid, processes).some(agent => agent.pid === pid && agent.agentId === 'hermes')) return null;
    return row;
  }
  function scan(nextProcesses) {
    processes = nextProcesses;
    const panes = options.panes?.() || [];
    const live = new Set();
    for (const pane of panes) {
      live.add(pane.id);
      if (pane.agentLaunchLocked) { retire(records.get(pane.id)); records.delete(pane.id); continue; }
      const primary = pane.status === 'running' ? findPrimaryAgents(pane.pid, processes) : [];
      const agent = primary.length === 1 && primary[0].agentId !== 'codex' ? primary[0] : null;
      const previous = records.get(pane.id);
      if (!agent) {
        if (previous) { retire(previous); records.delete(pane.id); options.apply?.(pane.id, null); }
        continue;
      }
      const processRow = processes.find(row => row.pid === agent.pid);
      const createdAt = processRow?.createdAt || '';
      const generation = `${pane.pid}:${agent.pid}:${createdAt}`;
      if (previous?.generation === generation && previous.agent.agentId === agent.agentId) {
        if (previous.observer) {
          const source = observerProcess(previous.observer.pid);
          if (!source || (source.createdAt || '') !== previous.observer.createdAt) {
            previous.observer = null; previous.state = 'unknown'; previous.activity.clear();
            options.apply?.(pane.id, identity(previous));
          }
        }
        continue;
      }
      retire(previous);
      const record = { agent, generation, createdAt, state: 'unknown', sessionId: '', stamp: -1n, activity: createActivityTracker() };
      records.set(pane.id, record);
      options.apply?.(pane.id, identity(record));
    }
    for (const [paneId, record] of records) if (!live.has(paneId)) { retire(record); records.delete(paneId); }
    for (const [key, observer] of observers) {
      const row = observerProcess(observer.pid);
      if (!row || (row.createdAt || '') !== observer.createdAt || now() - observer.lastSeen > 600000) observers.delete(key);
    }
  }
  function hook(input) {
    const panes = options.panes?.() || [];
    if (!input || !['omp', 'pi', 'claude', 'hermes'].includes(input.agentId)
      || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128
      || typeof input.cwd !== 'string' || !input.cwd || input.cwd.length > 4096) return { applied: false, reason: 'event' };
    const state = input.agentId === 'claude' ? CLAUDE_STATES[input.event] : input.state;
    if (!STATES.has(state) || (input.agentId !== 'claude' && !EXTENSION_EVENTS.has(input.event))) return { applied: false, reason: 'event' };
    const matches = [...records].filter(([paneId, record]) => {
      const pane = panes.find(item => item.id === paneId);
      const boundObserver = record.observer && record.observer.pid === input.pid && record.sessionId === input.sessionId;
      return pane && !pane.agentLaunchLocked && record.agent.agentId === input.agentId
        && (boundObserver || !input.paneId || input.paneId === paneId)
        && (boundObserver
          || (cwdKey(pane.cwd) === cwdKey(input.cwd)
            && (input.pid === undefined ? input.agentId === 'claude' : input.pid === record.agent.pid)));
    });
    // Hermes runs root sessions in a shared gateway. Its PID cannot identify a
    // terminal client; retain a verified observer as an explicit binding choice.
    if (!matches.length && input.agentId === 'hermes' && observerProcess(input.pid)) {
      if (typeof input.stamp !== 'string' || !/^\d{1,32}$/.test(input.stamp)) return { applied: false, reason: 'stamp' };
      const stamp = BigInt(input.stamp), row = observerProcess(input.pid);
      const key = `${input.pid}:${input.sessionId}`;
      const previous = observers.get(key);
      if (stamp <= (previous?.stamp ?? -1n) || stamp > monotonic() + 1000000000n) return { applied: false, reason: 'stale' };
      const createdAtMs = Date.parse(row.createdAt);
      if (Number.isFinite(createdAtMs) && stamp < monotonic() - BigInt(Math.max(0, Math.ceil(now() - createdAtMs + 1000))) * 1000000n) return { applied: false, reason: 'stale-process' };
      const observer = previous || { pid: input.pid, sessionId: input.sessionId, cwd: input.cwd, createdAt: row.createdAt || '', activity: createActivityTracker() };
      observer.stamp = stamp; observer.state = state; observer.lastSeen = now();
      if (SESSION_EVENTS.has(input.event)) observer.activity.clear();
      if (input.phase) observer.activity.update(input);
      if (!['running', 'waiting'].includes(state)) observer.activity.clear();
      observers.set(key, observer);
      if (observers.size > 128) observers.delete(observers.keys().next().value);
      return { applied: false, reason: 'binding-required' };
    }
    if (matches.length !== 1) return { applied: false, reason: matches.length ? 'ambiguous' : 'unmapped' };
    const [paneId, record] = matches[0];
    if (!SESSION_EVENTS.has(input.event) && (retired.has(retirementKey(record, input.sessionId)) || (!record.sessionId && retiredSessions.has(`${input.agentId}:${input.sessionId}`)))) return { applied: false, reason: 'stale-session' };
    let stamp;
    if (input.agentId !== 'claude' || input.stamp !== undefined) {
      if (typeof input.stamp !== 'string' || !/^\d{1,32}$/.test(input.stamp)) return { applied: false, reason: 'stamp' };
      stamp = BigInt(input.stamp);
      if (stamp <= record.stamp) return { applied: false, reason: 'stale' };
      const createdAtMs = Date.parse(record.createdAt);
      if (input.emittedAt !== undefined) {
        // Native OMP/Bun hrtime starts at process launch, while Node's clock
        // has a different origin. Keep its monotonic ordering and validate the
        // process generation with the separately captured wall-clock time.
        if (!Number.isSafeInteger(input.emittedAt) || input.emittedAt <= 0 || input.emittedAt > now() + 1000) return { applied: false, reason: 'stale' };
        if (Number.isFinite(createdAtMs) && input.emittedAt < createdAtMs - 1000) return { applied: false, reason: 'stale-process' };
      } else if (stamp > monotonic() + 1000000000n) return { applied: false, reason: 'stale' };
      else if (Number.isFinite(createdAtMs)) {
        // hrtime uses the host monotonic clock. Translate the process creation
        // boundary once per event with one second for wall-clock sampling skew.
        const floor = monotonic() - BigInt(Math.max(0, Math.ceil(now() - createdAtMs + 1000))) * 1000000n;
        if (stamp < floor) return { applied: false, reason: 'stale-process' };
      }
    }
    if (record.sessionId && record.sessionId !== input.sessionId) {
      if (!SESSION_EVENTS.has(input.event)) return { applied: false, reason: 'session' };
      retire(record); record.activity = createActivityTracker();
    }
    if (SESSION_EVENTS.has(input.event)) {
      record.activity.clear(); retired.delete(retirementKey(record, input.sessionId));
      retiredSessions.delete(`${input.agentId}:${input.sessionId}`);
    }
    record.sessionId = input.sessionId;
    if (stamp !== undefined) record.stamp = stamp;
    record.state = state;
    if (input.phase) record.activity.update(input);
    if (!['running', 'waiting'].includes(state)) record.activity.clear();
    if (record.observer) {
      const observer = observers.get(`${record.observer.pid}:${record.sessionId}`);
      if (observer) { observer.stamp = record.stamp; observer.state = state; observer.lastSeen = now(); }
    }
    options.apply?.(paneId, identity(record));
    return { applied: true, paneId, state };
  }
  return {
    scan, hook,
    hasCandidate(input) { return [...records.values()].some(record => record.agent.agentId === input?.agentId && (input.pid === undefined || record.agent.pid === input.pid || record.observer?.pid === input.pid)) || (input?.agentId === 'hermes' && observers.has(`${input.pid}:${input.sessionId}`)); },
    sessions() {
      return { sessions: [...observers.values()].map(item => ({ agentId: 'hermes', sessionId: item.sessionId, pid: item.pid, cwd: item.cwd, state: item.state, lastSeen: item.lastSeen })),
        panes: [...records].filter(([, record]) => record.agent.agentId === 'hermes').map(([paneId, record]) => ({ paneId, agentId: 'hermes', sessionId: record.sessionId || null })) };
    },
    bind(paneId, sessionId) {
      const record = records.get(paneId);
      const candidates = [...observers.values()].filter(item => item.sessionId === sessionId && observerProcess(item.pid) && now() - item.lastSeen <= 600000);
      if (!record || record.agent.agentId !== 'hermes' || candidates.length !== 1) return { applied: false, reason: 'unmapped' };
      const observer = candidates[0];
      if ([...records].some(([id, other]) => id !== paneId && other.observer?.pid === observer.pid && other.sessionId === sessionId)) return { applied: false, reason: 'ambiguous' };
      retire(record); record.activity = observer.activity; record.observer = { pid: observer.pid, createdAt: observer.createdAt };
      record.sessionId = sessionId; record.state = observer.state; record.stamp = observer.stamp;
      retired.delete(retirementKey(record, sessionId));
      options.apply?.(paneId, identity(record));
      return { applied: true, paneId, sessionId };
    },
  };
}

module.exports = { createController };
