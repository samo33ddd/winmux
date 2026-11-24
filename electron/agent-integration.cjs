'use strict';
const path = require('node:path');
const { findPrimaryAgents } = require('./agent-processes.cjs');
const { createActivityTracker } = require('./agent-activity.cjs');
const { AGENTS, HOOK_AGENT_IDS, HOOK_STATES, EXTENSION_EVENTS } = require('./backend/agent-registry.cjs');

const STATES = new Set(HOOK_STATES);
const SESSION_EVENTS = new Set(['session_start', 'session_switch', 'SessionStart']);
const EXTENSION_EVENT_SET = new Set(EXTENSION_EVENTS);
const TURN_END_STATES = new Set(['completed', 'failed', 'idle']);
const CLAUDE_STATES = AGENTS.claude.eventStates;
const cwdKey = value => typeof value === 'string' && value ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase() : '';

function createController(options = {}) {
  const records = new Map(), retired = new Set(), retiredSessions = new Set(), observers = new Map();
  let processes = [], snapshotAvailable = true;
  const now = options.now || Date.now;
  const monotonic = options.monotonic || (() => process.hrtime.bigint());
  // A process timestamp from the originating adapter proves which process
  // produced an event even when the next process snapshot omits that PID.
  function verifiedGeneration(source, input) {
    return Boolean(source?.processIdentity && input.processIdentity === source.processIdentity);
  }
  function generationChanged(source, row) {
    if (!row) return null;
    if (source.processIdentity && row.processIdentity) return source.processIdentity !== row.processIdentity;
    if (source.createdAt && row.createdAt && source.createdAt !== row.createdAt) return true;
    if (source.processIdentity || row.processIdentity || !source.createdAt || !row.createdAt) return null;
    return false;
  }
  function sameOrdinaryProcess(source, row) {
    return Boolean(row && source.createdAt && row.createdAt === source.createdAt && generationChanged(source, row) === null);
  }
  function unverify(source, available, snapshotStart) {
    source.unverified = true;
    if (available && !source.omission) source.omission = snapshotStart || {};
  }
  function reverify(source) {
    source.unverified = false;
    delete source.omission;
  }
  function beforeOmission(source, input) {
    if (!source.unverified) return true;
    if (verifiedGeneration(source, input)) return true;
    const cutoff = source.omission;
    if (input.agentId === 'omp') return Number.isSafeInteger(input.emittedAt) && input.emittedAt > 0
      && Number.isSafeInteger(cutoff?.epoch) && input.emittedAt < cutoff.epoch;
    return (input.agentId === 'pi' || input.agentId === 'hermes')
      && typeof input.stamp === 'string' && /^\d{1,32}$/.test(input.stamp)
      && typeof cutoff?.monotonic === 'bigint' && BigInt(input.stamp) < cutoff.monotonic;
  }
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
  function lifecycleGeneration(record) {
    return record.observer
      ? `${record.generation}:observer:${record.observer.pid}:${record.observer.processIdentity || record.observer.createdAt || ''}`
      : record.generation;
  }
  function observerProcess(pid) {
    if (!snapshotAvailable && ![...observers.values()].some(observer => observer.pid === pid && options.preserveObserver?.(observer.cwd))) return null;
    const row = processes.find(item => item.pid === pid);
    if (!row || !findPrimaryAgents(row.ppid, processes).some(agent => agent.pid === pid && agent.agentId === 'hermes')) return null;
    return row;
  }
  // Retain at most three metadata-only pieces of the first root turn for a
  // verified observer: the first accepted start, the latest nonterminal
  // waiting/running evidence and the first immutable end. No text is stored.
  function retainFirstTurn(observer, input, state, at) {
    const generation = `${observer.pid}:${observer.processIdentity || observer.createdAt || ''}:${observer.sessionId}`;
    const verified = verifiedGeneration(observer, input);
    if (input.event === 'session_start') { observer.firstTurn = { generation, sessionStartedAt: at, sessionVerified: verified }; return; }
    if (input.event === 'agent_start') {
      observer.firstTurn ??= { generation, sessionStartedAt: null };
      observer.firstTurn.generation = generation;
      observer.firstTurn.agentStart ??= { event: input.event, state, at, stamp: input.stamp, verified };
      return;
    }
    if (!observer.firstTurn) return;
    // A compression emits session_switch with the plugin's stable reporting id;
    // keeping the retained pieces is what proves the same first turn survived it.
    if (input.event === 'agent_end' && TURN_END_STATES.has(state)) {
      observer.firstTurn.terminal ??= { event: input.event, state, at, stamp: input.stamp, verified };
      return;
    }
    if (state === 'running' || state === 'waiting') observer.firstTurn.pending = { event: input.event, state, at, stamp: input.stamp, verified };
  }
  function retainedEvidence(observer, requireVerified = false) {
    const turn = observer.firstTurn;
    if (!turn) return [];
    const pieces = [turn.agentStart, turn.pending, turn.terminal].filter(piece => piece && (!requireVerified || piece.verified));
    if (!pieces.length) return [];
    const generation = turn.generation;
    return pieces.map(piece => ({ event: piece.event, state: piece.state, at: piece.at, stamp: piece.stamp, generation }));
  }
  function scan(nextProcesses, available = true, snapshotStart = null) {
    // Keep the last verified table for queued observer hooks when enumeration
    // fails; ordinary pane detection still sees an empty snapshot.
    snapshotAvailable = available;
    if (available) processes = nextProcesses;
    const panes = options.panes?.() || [];
    const live = new Set();
    for (const pane of panes) {
      live.add(pane.id);
      if (pane.agentLaunchLocked) { retire(records.get(pane.id)); records.delete(pane.id); continue; }
      const primary = available && pane.status === 'running' ? findPrimaryAgents(pane.pid, processes) : [];
      const agent = primary.length === 1 && primary[0].agentId !== 'codex' ? primary[0] : null;
      const previous = records.get(pane.id);
      if (previous?.observer && available && options.holdIdentity?.(pane.id, previous.generation)) {
        const row = processes.find(item => item.pid === previous.observer.pid);
        if (generationChanged(previous.observer, row) === true) {
          previous.observer = null;
          previous.state = 'unknown'; previous.activity.clear();
          options.apply?.(pane.id, identity(previous));
          options.onIdentityLost?.(pane.id, previous.generation, `${previous.generation}:observer:${row.pid}:${row.processIdentity || row.createdAt}`);
        }
      }
      if (!agent) {
        if (previous) {
          // An active run retains its last verified generation until a real
          // shell exit, a proven replacement, or explicit pane disposal.
          if (options.holdIdentity?.(pane.id, previous.generation)) {
            const row = available && processes.find(item => item.pid === previous.agent.pid);
            if (generationChanged(previous, row) !== true) {
              unverify(previous, available, snapshotStart);
              continue;
            }
            retire(previous); records.delete(pane.id);
            options.onIdentityLost?.(pane.id, previous.generation, `${pane.pid}:${row.pid}:${row.processIdentity || row.createdAt}`);
            options.apply?.(pane.id, null);
            continue;
          }
          retire(previous); records.delete(pane.id);
          options.onIdentityLost?.(pane.id, previous.generation);
          options.apply?.(pane.id, null);
        }
        continue;
      }
      const processRow = processes.find(row => row.pid === agent.pid);
      const createdAt = processRow?.createdAt || '';
      const processIdentity = processRow?.processIdentity || '';
      const generation = `${pane.pid}:${agent.pid}:${processIdentity || createdAt}`;
      const held = previous && options.holdIdentity?.(pane.id, previous.generation);
      const sameAgent = previous && previous.agent.pid === agent.pid && previous.agent.agentId === agent.agentId;
      if (previous && previous.agent.pid === agent.pid && previous.agent.agentId === agent.agentId
        && generationChanged(previous, processRow) === null && held) {
        unverify(previous, false, snapshotStart);
        continue;
      }
      if ((previous?.generation === generation && previous.agent.agentId === agent.agentId)
        || (sameAgent && !held && sameOrdinaryProcess(previous, processRow))) {
        if (!held && !previous.processIdentity && processIdentity) {
          previous.processIdentity = processIdentity;
          previous.generation = generation;
        }
        if (!previous.unverified || createdAt) reverify(previous);
        if (previous.observer) {
          const source = observerProcess(previous.observer.pid);
          const held = options.holdIdentity?.(pane.id, previous.generation);
          const changed = generationChanged(previous.observer, source);
          if (changed === null && held) {
            unverify(previous.observer, available, snapshotStart);
          } else if (changed === false || (!held && sameOrdinaryProcess(previous.observer, source))) {
            if (!previous.observer.processIdentity && source.processIdentity) previous.observer.processIdentity = source.processIdentity;
            reverify(previous.observer);
          } else {
            previous.observer = null; previous.state = 'unknown'; previous.activity.clear();
            options.apply?.(pane.id, identity(previous));
            options.onIdentityLost?.(pane.id, previous.generation, changed === true ? `${previous.generation}:observer:${source.pid}:${source.processIdentity || source.createdAt || ''}` : undefined);
          }
        }
        continue;
      }
      retire(previous);
      // The replacement generation is passed along so an observer can tell a
      // proven replacement apart from an agent that vanished without a successor.
      if (previous) options.onIdentityLost?.(pane.id, previous.generation, generation);
      const record = { agent, generation, createdAt, processIdentity, state: 'unknown', sessionId: '', stamp: -1n, activity: createActivityTracker() };
      if (!processIdentity && options.holdIdentity?.(pane.id, generation)) unverify(record, false, snapshotStart);
      records.set(pane.id, record);
      options.apply?.(pane.id, identity(record));
    }
    for (const [paneId, record] of records) if (!live.has(paneId)) {
      retire(record); records.delete(paneId);
      options.onIdentityLost?.(paneId, record.generation);
    }
    for (const [key, observer] of observers) {
      const held = options.preserveObserver?.(observer.cwd)
        || [...records].some(([paneId, record]) => record.observer?.pid === observer.pid && record.sessionId === observer.sessionId
          && options.holdIdentity?.(paneId, record.generation));
      if (!available && held) { unverify(observer, false, snapshotStart); continue; }
      const row = observerProcess(observer.pid);
      const changed = generationChanged(observer, row);
      if (changed === null && held) { unverify(observer, available, snapshotStart); continue; }
      const same = changed === false || (!held && sameOrdinaryProcess(observer, row));
      if (same) {
        if (!observer.processIdentity && row.processIdentity) observer.processIdentity = row.processIdentity;
        reverify(observer);
      }
      if (!same || now() - observer.lastSeen > 600000) observers.delete(key);
    }
  }
  function hook(input) {
    const panes = options.panes?.() || [];
    if (!input || !HOOK_AGENT_IDS.has(input.agentId)
      || typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128
      || typeof input.cwd !== 'string' || !input.cwd || input.cwd.length > 4096) return { applied: false, reason: 'event' };
    const state = input.agentId === 'claude' ? CLAUDE_STATES[input.event] : input.state;
    if (!STATES.has(state) || (input.agentId !== 'claude' && !EXTENSION_EVENT_SET.has(input.event))) return { applied: false, reason: 'event' };
    const matches = [...records].filter(([paneId, record]) => {
      const pane = panes.find(item => item.id === paneId);
      const boundObserver = record.observer && record.observer.pid === input.pid && record.sessionId === input.sessionId;
      return pane && !pane.agentLaunchLocked && record.agent.agentId === input.agentId
        && (!record.observer || record.observer.pid === input.pid)
        && (boundObserver || !input.paneId || input.paneId === paneId)
        && (boundObserver
          || (cwdKey(pane.cwd) === cwdKey(input.cwd)
            && (input.pid === undefined ? input.agentId === 'claude' : input.pid === record.agent.pid)));
    });
    // Hermes runs root sessions in a shared gateway. Its PID cannot identify a
    // terminal client; retain a verified observer as an explicit binding choice.
    const knownObserver = input.agentId === 'hermes' && observers.get(`${input.pid}:${input.sessionId}`);
    const currentObserverProcess = input.agentId === 'hermes' && snapshotAvailable ? observerProcess(input.pid) : null;
    const observerRow = currentObserverProcess || (knownObserver?.unverified ? knownObserver.row : null);
    if (!matches.length && input.agentId === 'hermes' && observerRow) {
      if (typeof input.stamp !== 'string' || !/^\d{1,32}$/.test(input.stamp)) return { applied: false, reason: 'stamp' };
      const stamp = BigInt(input.stamp), row = observerRow;
      const key = `${input.pid}:${input.sessionId}`;
      const previous = observers.get(key);
      if (input.processIdentity && row.processIdentity && input.processIdentity !== row.processIdentity) return { applied: false, reason: 'stale-process' };
      if (previous && generationChanged(previous, row) === true) return { applied: false, reason: 'stale-process' };
      if (previous && !beforeOmission(previous, input)) return { applied: false, reason: 'unverified' };
      if (!snapshotAvailable && (!previous || cwdKey(previous.cwd) !== cwdKey(input.cwd))) return { applied: false, reason: 'unmapped' };
      if (stamp <= (previous?.stamp ?? -1n) || stamp > monotonic() + 1000000000n) return { applied: false, reason: 'stale' };
      const createdAtMs = Date.parse(row.createdAt);
      if (Number.isFinite(createdAtMs) && stamp < monotonic() - BigInt(Math.max(0, Math.ceil(now() - createdAtMs + 1000))) * 1000000n) return { applied: false, reason: 'stale-process' };
      if (previous && cwdKey(previous.cwd) !== cwdKey(input.cwd)) {
        // A root start in another directory cannot belong to the retained
        // first turn. Only a verified new session boundary may change its cwd.
        if (input.event !== 'session_start' || !snapshotAvailable) return { applied: false, reason: 'cwd' };
        previous.cwd = input.cwd;
      }
      const observer = previous || { pid: input.pid, sessionId: input.sessionId, cwd: input.cwd, createdAt: row.createdAt || '', processIdentity: row.processIdentity || '', row, activity: createActivityTracker(), firstTurn: null };
      observer.stamp = stamp; observer.state = state; observer.lastSeen = now();
      if (SESSION_EVENTS.has(input.event)) observer.activity.clear();
      if (input.phase) observer.activity.update(input);
      if (!['running', 'waiting'].includes(state)) observer.activity.clear();
      retainFirstTurn(observer, input, state, now());
      observers.set(key, observer);
      if (observers.size > 128) observers.delete(observers.keys().next().value);
      return { applied: false, reason: 'binding-required', generationVerified: verifiedGeneration(observer, input) };
    }
    if (matches.length !== 1) return { applied: false, reason: matches.length ? 'ambiguous' : 'unmapped' };
    const [paneId, record] = matches[0];
    const source = record.observer && record.observer.pid === input.pid ? record.observer : record;
    if (input.processIdentity && source.processIdentity && input.processIdentity !== source.processIdentity) return { applied: false, reason: 'stale-process' };
    if (input.agentId !== 'claude' && options.holdIdentity?.(paneId, record.generation) && !verifiedGeneration(source, input)) return { applied: false, reason: 'unverified-generation' };
    if (!beforeOmission(source, input)) return { applied: false, reason: 'unverified' };
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
    if (record.observer?.automationCwd && record.observer.pid === input.pid
      && record.sessionId === input.sessionId && cwdKey(input.cwd) !== record.observer.automationCwd) {
      // A verified session boundary in another directory replaces this bound
      // automation identity; ordinary wrong-cwd events cannot describe its turn.
      if (SESSION_EVENTS.has(input.event)) options.onIdentityLost?.(paneId, record.generation, `${record.generation}:cwd`);
      return { applied: false, reason: 'cwd' };
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
    options.onLifecycle?.({ paneId, agentId: record.agent.agentId, generation: lifecycleGeneration(record),
      sessionId: input.sessionId, event: input.event, state, receivedAt: now(), stamp: input.stamp,
      generationVerified: verifiedGeneration(source, input) });
    return { applied: true, paneId, state };
  }
  return {
    scan, hook,
    hasCandidate(input) {
      const candidates = [...records.values()].filter(record => record.agent.agentId === input?.agentId
        && (input.pid === undefined || record.agent.pid === input.pid || record.observer?.pid === input.pid));
      const observer = input?.agentId === 'hermes' && observers.get(`${input.pid}:${input.sessionId}`);
      if (candidates.some(record => record.unverified || (record.observer && record.observer.pid === input.pid && record.observer.unverified)) || observer?.unverified) return false;
      if (input?.processIdentity && candidates.some(record => {
        const source = record.observer && record.observer.pid === input.pid ? record.observer : record;
        return source.processIdentity && input.processIdentity !== source.processIdentity;
      })) return false;
      if (input?.processIdentity && observer?.processIdentity && input.processIdentity !== observer.processIdentity) return false;
      return candidates.length > 0 || Boolean(observer);
    },
    sessions() {
      return { sessions: [...observers.values()].map(item => ({ agentId: 'hermes', sessionId: item.sessionId, pid: item.pid, cwd: item.cwd, state: item.state, lastSeen: item.lastSeen })),
        panes: [...records].filter(([, record]) => record.agent.agentId === 'hermes').map(([paneId, record]) => ({ paneId, agentId: 'hermes', sessionId: record.sessionId || null })) };
    },
    bind(paneId, sessionId, automationConstraint = null) {
      const record = records.get(paneId);
      let candidates = [...observers.values()].filter(item => item.sessionId === sessionId && !item.unverified && snapshotAvailable && observerProcess(item.pid) && now() - item.lastSeen <= 600000);
      // An automation run only accepts the observer created for its own task
      // directory and after the run started, so an older session cannot satisfy it.
      if (automationConstraint) candidates = candidates.filter(item => cwdKey(item.cwd) === cwdKey(automationConstraint.cwd)
        && Number.isFinite(item.firstTurn?.sessionStartedAt) && item.firstTurn.sessionStartedAt >= automationConstraint.notBefore
        && item.firstTurn.sessionVerified && item.firstTurn.agentStart?.verified
        && Number.isFinite(item.firstTurn?.agentStart?.at) && item.firstTurn.agentStart.at >= automationConstraint.notBefore);
      if (!record || record.unverified || record.agent.agentId !== 'hermes' || candidates.length !== 1) return { applied: false, reason: 'unmapped' };
      const observer = candidates[0];
      if ([...records].some(([id, other]) => id !== paneId && other.observer?.pid === observer.pid && other.sessionId === sessionId)) return { applied: false, reason: 'ambiguous' };
      retire(record); record.activity = observer.activity; record.observer = { pid: observer.pid, createdAt: observer.createdAt, processIdentity: observer.processIdentity,
        ...(automationConstraint ? { automationCwd: cwdKey(automationConstraint.cwd) } : {}) };
      record.sessionId = sessionId; record.state = observer.state; record.stamp = observer.stamp;
      retired.delete(retirementKey(record, sessionId));
      options.apply?.(paneId, identity(record));
      const generation = lifecycleGeneration(record);
      return { applied: true, paneId, sessionId,
        retained: retainedEvidence(observer, Boolean(automationConstraint)).map(piece => ({ ...piece, generation })) };
    },
  };
}

module.exports = { createController };
