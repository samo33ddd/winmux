'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

// Native worker owns electron/codex-daemon.cjs and must export:
//   connectReadonly(options?) -> Promise<CodexReadonlyClient>
// CodexReadonlyClient:
//   listThreads({ cwd, limit, cursor, useStateDbOnly }) -> { data, nextCursor }
//   listLoaded({ cursor, limit }?) -> { data, nextCursor }
//   onNotification(message => void) -> unsubscribe
//   close() -> void | Promise<void>
// Transport: one WebSocket text frame per JSON-RPC message, over a Duplex of
// `codex app-server proxy` stdin/stdout. Attach to the daemon that is already
// running. Never spawn a second daemon, and never call thread/start,
// thread/resume, thread/fork, turn/start, turn/steer, or approval responses.
// Read requests are only initialize, the initialized notification, thread/list,
// and thread/loaded/list. Threads can come from vscode or cli; do not assume cli.
// A loaded root has parentThreadId null and an id returned by thread/loaded/list.

const WAITING_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const HOOK_RUNNING = new Set(['UserPromptSubmit', 'PreModelRequest', 'PreToolUse', 'PostToolUse']);
const HOOK_WAITING = new Set(['PermissionRequest', 'Interrupt']);

function normalizeCwd(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const normalized = path.win32.normalize(value.trim().replace(/\//g, '\\'));
  const trimmed = normalized.length > 3 ? normalized.replace(/[\\/]+$/, '') : normalized;
  return trimmed.toLowerCase();
}

function isCodexProcess(proc) {
  const name = String(proc?.name || '').toLowerCase();
  const executable = String(proc?.executable || '').replace(/\//g, '\\').toLowerCase();
  const base = executable ? path.win32.basename(executable).toLowerCase() : '';
  const named = name === 'codex.exe' || name === 'codex' || base === 'codex.exe' || base === 'codex';
  if (!named) return false;
  return !/\bapp-server\b/i.test(String(proc?.commandLine || ''));
}

function findCodexDescendants(rootPid, processes, limits = {}) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0) return [];
  const maxNodes = limits.maxNodes || 64;
  const maxDepth = limits.maxDepth || 8;
  const children = new Map();
  for (const proc of processes || []) {
    const pid = Number(proc.pid), ppid = Number(proc.ppid);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid) || [];
    list.push(proc);
    children.set(ppid, list);
  }
  const found = [];
  const queue = [{ pid: root, depth: 0 }];
  const seen = new Set([root]);
  let walked = 0;
  while (queue.length && walked < maxNodes) {
    const current = queue.shift();
    for (const child of children.get(current.pid) || []) {
      const pid = Number(child.pid);
      if (seen.has(pid)) continue;
      seen.add(pid);
      walked += 1;
      if (isCodexProcess(child)) found.push(pid);
      if (current.depth + 1 < maxDepth) queue.push({ pid, depth: current.depth + 1 });
      if (walked >= maxNodes) break;
    }
  }
  return found;
}

function agentStateFor(previous, status, identity = null) {
  const previousState = typeof previous === 'string' ? previous : previous?.agentState;
  const sameIdentity = !identity || (typeof previous === 'object' && previous?.agentThreadId === identity.threadId && (previous.agentSessionId || '') === (identity.sessionId || ''));
  if (!status || status.type === 'notLoaded') return sameIdentity && (previousState === 'completed' || previousState === 'failed') ? previousState : 'unknown';
  if (status.type === 'systemError') return 'failed';
  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    return flags.some(flag => WAITING_FLAGS.has(flag)) ? 'waiting' : 'running';
  }
  if (status.type === 'idle') return sameIdentity && (previousState === 'completed' || previousState === 'failed') ? previousState : 'idle';
  return 'unknown';
}

function stateAfterTurn(turn) {
  if (turn?.status === 'completed') return 'completed';
  if (turn?.status === 'failed') return 'failed';
  return null;
}

function hookState(event) {
  if (HOOK_RUNNING.has(event)) return 'running';
  if (HOOK_WAITING.has(event)) return 'waiting';
  if (event === 'Stop') return 'completed';
  if (event === 'StopFailure') return 'failed';
  return null;
}

function loadedRoots(threads, loadedIds) {
  const loaded = new Set(loadedIds || []);
  return (threads || []).filter(thread => thread && loaded.has(thread.id) && thread.parentThreadId == null && typeof thread.id === 'string');
}

function decoratePanes(panes, processes) {
  return (panes || []).map(pane => {
    const descendants = pane?.status === 'running' ? findCodexDescendants(pane.pid, processes) : [];
    return { ...pane, codexPid: descendants[0] || null, codexCount: descendants.length };
  });
}

function planBindings({ panes, threads, loadedIds }) {
  const roots = loadedRoots(threads, loadedIds);
  const byCwd = new Map();
  for (const thread of roots) {
    const cwd = normalizeCwd(thread.cwd);
    if (!cwd) continue;
    const list = byCwd.get(cwd) || [];
    list.push(thread);
    byCwd.set(cwd, list);
  }
  const codexPanes = panes.filter(pane => pane.codexPid);
  const panesByCwd = new Map();
  for (const pane of codexPanes) {
    const cwd = normalizeCwd(pane.cwd);
    if (!cwd) continue;
    const list = panesByCwd.get(cwd) || [];
    list.push(pane);
    panesByCwd.set(cwd, list);
  }
  return panes.map(pane => {
    if (pane.agentLaunchLocked) return { paneId: pane.id, action: 'skip' };
    if (!pane.codexPid) return { paneId: pane.id, action: pane.agentId === 'codex' ? 'clear' : 'ignore' };
    const cwd = normalizeCwd(pane.cwd);
    const cwdThreads = byCwd.get(cwd) || [];
    const cwdPanes = panesByCwd.get(cwd) || [];
    const candidates = cwdThreads.map(thread => thread.id);
    if (pane.agentBinding === 'explicit' && pane.agentThreadId) {
      const thread = cwdThreads.find(item => item.id === pane.agentThreadId) || null;
      if (!thread) return { paneId: pane.id, action: 'stale', candidates, state: 'unknown' };
      return { paneId: pane.id, action: 'keep', thread, candidates, state: agentStateFor(pane, thread.status, { threadId: thread.id, sessionId: thread.sessionId || '' }) };
    }
    if ((pane.codexCount || 0) > 1) return { paneId: pane.id, action: 'ambiguous', candidates: [], state: 'unknown' };
    if (cwdPanes.length === 1 && cwdThreads.length === 1) {
      const thread = cwdThreads[0];
      return { paneId: pane.id, action: 'auto', thread, candidates, state: agentStateFor(pane, thread.status, { threadId: thread.id, sessionId: thread.sessionId || '' }) };
    }
    return { paneId: pane.id, action: 'ambiguous', candidates, state: 'unknown' };
  });
}

function matchHook({ agentId, event, sessionId, cwd, paneId, panes, threads, loadedIds }) {
  const state = hookState(event);
  if (agentId !== 'codex' || !state || typeof sessionId !== 'string' || !sessionId) return { action: 'ignore', reason: 'event' };
  const roots = loadedRoots(threads, loadedIds);
  const processPanes = (panes || []).filter(pane => pane.codexPid);
  const codexPanes = processPanes.filter(pane => !pane.agentLaunchLocked);
  const eligible = pane => pane.codexCount === 1;
  const bound = (id) => {
    const pane = codexPanes.find(item => item.id === id);
    if (!pane?.agentThreadId || !eligible(pane) || pane.agentSessionId !== sessionId
      || !['auto', 'explicit'].includes(pane.agentBinding)) return null;
    const thread = roots.find(item => item.id === pane.agentThreadId && item.sessionId === sessionId
      && normalizeCwd(item.cwd) && normalizeCwd(item.cwd) === normalizeCwd(pane.cwd));
    return thread ? pane : null;
  };
  if (paneId) {
    const pane = codexPanes.find(item => item.id === paneId);
    if (!pane) return { action: 'ignore', reason: 'pane' };
    if (pane.agentThreadId) return bound(pane.id) ? { action: 'apply', paneId: pane.id, state } : { action: 'ignore', reason: 'stale' };
    const samePanes = processPanes.filter(item => normalizeCwd(item.cwd) && normalizeCwd(item.cwd) === normalizeCwd(pane.cwd));
    const sameThreads = roots.filter(thread => normalizeCwd(thread.cwd) === normalizeCwd(pane.cwd));
    if (eligible(pane) && samePanes.length === 1 && sameThreads.length === 1 && sameThreads[0].sessionId === sessionId) return { action: 'apply', paneId: pane.id, state, thread: sameThreads[0] };
    return { action: 'ignore', reason: 'ambiguous' };
  }
  const sessionPanes = codexPanes.filter(pane => bound(pane.id));
  if (sessionPanes.length === 1) return { action: 'apply', paneId: sessionPanes[0].id, state };
  if (sessionPanes.length > 1) return { action: 'ignore', reason: 'ambiguous' };
  const cwdKey = normalizeCwd(cwd);
  const cwdPanes = processPanes.filter(pane => normalizeCwd(pane.cwd) === cwdKey);
  const cwdThreads = roots.filter(thread => normalizeCwd(thread.cwd) === cwdKey);
  if (cwdKey && cwdPanes.length === 1 && eligible(cwdPanes[0]) && !cwdPanes[0].agentLaunchLocked && !cwdPanes[0].agentThreadId
    && cwdThreads.length === 1 && cwdThreads[0].sessionId === sessionId) return { action: 'apply', paneId: cwdPanes[0].id, state, thread: cwdThreads[0] };
  return { action: 'ignore', reason: 'unmapped' };
}

async function windowsProcessTable() {
  const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 3";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], {
    windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
    pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: row.Name || '',
    executable: row.ExecutablePath || '', commandLine: row.CommandLine || '',
  })).filter(row => Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.ppid));
}

function codexCommand() {
  if (process.env.WINMUX_CODEX_BIN) return process.env.WINMUX_CODEX_BIN;
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const managed = path.join(process.env.USERPROFILE || '', '.codex', 'packages', 'app-server-daemon', 'current', 'bin', name);
  return fs.existsSync(managed) ? managed : name;
}
function clientVersion() {
  try {
    const version = require('../package.json').version;
    return typeof version === 'string' && version ? version : '0.2.1';
  } catch {
    return '0.2.1';
  }
}
function openDaemon(options = {}) {
  const { createCodexDaemon } = require('./codex-daemon.cjs');
  const WebSocket = options.WebSocket || require('ws');
  return createCodexDaemon({ WebSocket, command: options.command || codexCommand(), clientVersion: options.clientVersion || clientVersion(), ...options });
}
function connectReadonly(options = {}) {
  const daemon = options.daemon || openDaemon(options);
  let page = null;
  const ready = () => page || daemon.refresh({ limit: 1 }).then(result => { page = result; return result; });
  return {
    listThreads: async params => {
      page = await daemon.refresh({ cwd: params?.cwd, limit: params?.limit, cursor: params?.cursor });
      return { data: page.threads, nextCursor: page.nextCursor };
    },
    listLoaded: async () => {
      const current = await ready();
      return { data: current.loadedThreadIds, nextCursor: null };
    },
    onNotification(listener) {
      const status = payload => listener({ method: 'thread/status/changed', params: payload });
      const turn = payload => listener({ method: 'turn/completed', params: { threadId: payload.threadId, turn: { status: payload.status } } });
      daemon.on('status', status); daemon.on('turn', turn);
      return () => { daemon.off('status', status); daemon.off('turn', turn); };
    },
    close() { daemon.dispose(); },
  };
}

async function collectPages(read, params, limit) {
  const data = [];
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < 5; page += 1) {
    const result = await read({ ...params, cursor, limit });
    if (!Array.isArray(result?.data) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) {
      throw Object.assign(new Error('Codex enumeration returned an invalid page'), { code: 'INCOMPLETE_ENUMERATION' });
    }
    const rows = result.data;
    data.push(...rows);
    cursor = result?.nextCursor || null;
    if (!cursor) return data;
    if (rows.length === 0 || seen.has(cursor)) throw Object.assign(new Error('Codex enumeration is incomplete'), { code: 'INCOMPLETE_ENUMERATION' });
    seen.add(cursor);
  }
  if (cursor) throw Object.assign(new Error('Codex enumeration is incomplete'), { code: 'INCOMPLETE_ENUMERATION' });
  return data;
}

function createController(options = {}) {
  const connect = options.connect || null;
  const listProcesses = options.listProcesses || windowsProcessTable;
  const intervalMs = options.intervalMs || 2000;
  let client = null, unsubscribe = null, timer = null, refreshing = null, stopped = false;
  let daemon = null;
  let connection = 'disconnected', connectionReason = 'starting';
  let threads = [], loadedIds = [], processes = [], plans = [];
  function snapshot() {
    return {
      connection, reason: connectionReason,
      threads: loadedRoots(threads, loadedIds).map(thread => ({
        id: thread.id, cwd: thread.cwd, name: thread.name || thread.preview || thread.id,
        source: thread.source ?? null, parentThreadId: thread.parentThreadId ?? null,
        sessionId: thread.sessionId || null, status: thread.status || { type: 'notLoaded' },
      })),
      panes: plans.filter(plan => plan.action !== 'skip' && plan.action !== 'ignore').map(plan => ({
        paneId: plan.paneId, action: plan.action, threadId: plan.thread?.id || null, candidates: plan.candidates || [], state: plan.state || null,
      })),
    };
  }
  function handleNotification(message) {
    const method = message?.method, params = message?.params || {};
    if (method === 'turn/completed') {
      const state = stateAfterTurn(params.turn);
      const plan = plans.find(item => item.thread?.id === params.threadId && (item.action === 'auto' || item.action === 'keep'));
      if (!state || !plan) return;
      options.apply?.(plan.paneId, identity(plan.thread, state, plan.action === 'keep' ? 'explicit' : 'auto'));
      return;
    }
    if (method === 'thread/status/changed' && params.threadId) {
      const thread = threads.find(item => item.id === params.threadId);
      if (thread && params.status) thread.status = params.status;
      const plan = plans.find(item => item.thread?.id === params.threadId && (item.action === 'auto' || item.action === 'keep'));
      if (!plan) return;
      const panes = options.panes?.() || [];
      const pane = panes.find(item => item.id === plan.paneId);
      const state = agentStateFor(pane, params.status, { threadId: plan.thread.id, sessionId: plan.thread.sessionId || '' });
      options.apply?.(plan.paneId, identity(plan.thread, state, plan.action === 'keep' ? 'explicit' : 'auto'));
    }
  }
  async function ensure() {
    if (client || stopped) return;
    if (!connect) {
      try {
        daemon = (options.createDaemon || openDaemon)();
        const currentDaemon = daemon;
        daemon.on('unavailable', () => {
          if (daemon !== currentDaemon) return;
          connection = 'disconnected'; connectionReason = 'unavailable';
          threads = []; loadedIds = []; plans = [];
        });
        daemon.on('status', payload => handleNotification({ method: 'thread/status/changed', params: payload }));
        daemon.on('turn', payload => handleNotification({ method: 'turn/completed', params: { threadId: payload.threadId, turn: { status: payload.status } } }));
        await daemon.connect();
        if (!daemon.readState().available) throw new Error('Codex daemon is disconnected');
        client = daemon; connection = 'connected'; connectionReason = '';
      } catch (error) {
        daemon = null; client = null; connection = 'disconnected';
        connectionReason = error.code === 'ADAPTER_MISSING' ? 'adapter-missing' : 'unavailable';
      }
      return;
    }
    try {
      client = await connect();
      unsubscribe = client.onNotification?.(handleNotification) || null;
      connection = 'connected'; connectionReason = '';
    } catch (error) {
      client = null; connection = 'disconnected';
      connectionReason = error.code === 'ADAPTER_MISSING' ? 'adapter-missing' : 'unavailable';
    }
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await ensure();
      const rawPanes = options.panes?.() || [];
      try {
        processes = rawPanes.some(pane => pane.status === 'running' && pane.pid) ? await listProcesses() : [];
      } catch { processes = []; }
      const decorated = decoratePanes(rawPanes, processes);
      const cwds = [...new Set(decorated.filter(pane => pane.codexPid).map(pane => pane.cwd).filter(cwd => typeof cwd === 'string' && cwd))];
      let daemonAvailable = false;
      if (client) {
        try {
          if (daemon && daemon.readState && daemon.readState().available === false) throw Object.assign(new Error('Codex daemon is disconnected'), { code: 'unavailable' });
          if (daemon) {
            const page = cwds.length ? await daemon.refresh({ cwd: cwds, limit: 100, maxPages: 5 }) : { threads: [], loadedThreadIds: daemon.readState().loadedThreadIds, complete: true };
            if (page.complete === false || page.nextCursor) throw Object.assign(new Error('Codex enumeration is incomplete'), { code: 'INCOMPLETE_ENUMERATION' });
            threads = page.threads || []; loadedIds = page.loadedThreadIds || [];
          } else {
            loadedIds = await collectPages(params => client.listLoaded(params), {}, 100);
            const listed = [];
            for (const cwd of cwds) listed.push(...await collectPages(params => client.listThreads(params), { cwd, useStateDbOnly: true }, 20));
            threads = listed;
          }
          connection = 'connected'; connectionReason = '';
          daemonAvailable = true;
        } catch {
          connection = 'disconnected'; connectionReason = 'unavailable'; threads = []; loadedIds = [];
          try { await client.close?.(); } catch { /* The proxy process is ours; the user daemon stays up. */ }
          try { daemon?.dispose?.(); } catch { /* dispose is idempotent */ }
          unsubscribe?.(); unsubscribe = null; client = null;
          daemon = null;
        }
      }
      if (daemonAvailable) {
        plans = planBindings({ panes: decorated, threads, loadedIds });
        for (const plan of plans) {
          if (plan.action === 'auto' || plan.action === 'keep') options.apply?.(plan.paneId, identity(plan.thread, plan.state, plan.action === 'keep' ? 'explicit' : 'auto'));
          else if (plan.action === 'stale') options.apply?.(plan.paneId, processIdentity());
          else if (plan.action === 'clear') options.apply?.(plan.paneId, null);
          else if (plan.action === 'ambiguous') options.apply?.(plan.paneId, processIdentity());
        }
      } else {
        plans = decorated.filter(pane => pane.codexPid).map(pane => ({ paneId: pane.id, action: 'unknown', candidates: [], state: 'unknown' }));
        for (const plan of plans) options.apply?.(plan.paneId, processIdentity());
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  function identity(thread, state, binding) {
    return {
      agentId: 'codex', agentLabel: 'Codex', agentThreadId: thread.id, agentSessionId: thread.sessionId || '',
      agentBinding: binding, agentState: state,
    };
  }
  function processIdentity() {
    return { agentId: 'codex', agentLabel: 'Codex', agentThreadId: '', agentSessionId: '', agentBinding: '', agentState: 'unknown' };
  }
  return {
    start() {
      if (timer || stopped) return;
      const tick = () => { refresh().catch(() => {}); };
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true; clearInterval(timer); timer = null;
      unsubscribe?.(); unsubscribe = null;
      const current = client; client = null; connection = 'disconnected'; connectionReason = 'stopped';
      const currentDaemon = daemon; daemon = null;
      try { await current?.close?.(); } catch { /* Closing the proxy must not affect the user daemon. */ }
      try { currentDaemon?.dispose?.(); } catch { /* The proxy is the only process we started. */ }
    },
    refresh, status: snapshot,
    async bind(paneId, threadId) {
      await refresh();
      const pane = decoratePanes(options.panes?.() || [], processes).find(item => item.id === paneId);
      if (!pane) return { ok: false, code: 'NOT_FOUND' };
      if (!pane.codexPid || pane.agentLaunchLocked) return { ok: false, code: 'CODEX_PROCESS_REQUIRED' };
      const thread = loadedRoots(threads, loadedIds).find(item => item.id === threadId && normalizeCwd(item.cwd) === normalizeCwd(pane.cwd));
      if (!thread) return { ok: false, code: 'STALE_THREAD' };
      const state = agentStateFor(pane, thread.status, { threadId: thread.id, sessionId: thread.sessionId || '' });
      options.apply?.(paneId, identity(thread, state, 'explicit'));
      await refresh();
      return { ok: true, paneId, threadId, state };
    },
    async hook(input) {
      await refresh();
      const match = matchHook({ ...input, panes: decoratePanes(options.panes?.() || [], processes), threads, loadedIds });
      if (match.action !== 'apply') return { applied: false, reason: match.reason };
      options.apply?.(match.paneId, match.thread ? identity(match.thread, match.state, 'auto') : { agentState: match.state });
      return { applied: true, paneId: match.paneId, state: match.state };
    },
  };
}

module.exports = {
  normalizeCwd, isCodexProcess, findCodexDescendants, agentStateFor, stateAfterTurn, hookState,
  planBindings, matchHook, windowsProcessTable, createController, connectReadonly,
};
