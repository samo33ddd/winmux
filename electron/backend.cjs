'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { LIMITS, locations, createToken, authenticated, fail, string, integer } = require('./backend/shared.cjs');
const { discover, validateLaunch } = require('./backend/environment.cjs');
const { cwdFromOsc } = require('./backend/shell-integration.cjs');
const { terminalEnvironment } = require('./backend/terminal-env.cjs');
const { createController: createCodexController } = require('./codex-integration.cjs');
const { createController: createAgentController } = require('./agent-integration.cjs');
const { ACTIVITY_KINDS, createActivityTracker } = require('./agent-activity.cjs');

function replaceLeaf(node, paneId, replacement) {
  if (node.type === 'leaf') return node.paneId === paneId ? replacement : node;
  const first = replaceLeaf(node.first, paneId, replacement), second = replaceLeaf(node.second, paneId, replacement);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}
function findSplit(node, id) {
  if (!node || node.type === 'leaf') return null;
  return node.id === id ? node : findSplit(node.first, id) || findSplit(node.second, id);
}
function leafIds(node) { return !node ? [] : node.type === 'leaf' ? [node.paneId] : [...leafIds(node.first), ...leafIds(node.second)]; }
function syncTabs(workspace) {
  if (!workspace.tabs.some(tab => tab.id === workspace.activeTabId)) workspace.activeTabId = workspace.tabs[0]?.id;
  workspace.root = workspace.tabs.find(tab => tab.id === workspace.activeTabId)?.root;
}
const AGENT_STATES = new Set(['starting', 'running', 'waiting', 'idle', 'completed', 'failed', 'unknown']);
function tabTitleMode(titleMode, hasTitle) {
  if (titleMode === undefined) return hasTitle ? 'custom' : 'auto';
  if (titleMode !== 'auto' && titleMode !== 'custom') fail('INVALID_ARGUMENT', 'titleMode must be auto or custom');
  if (titleMode === 'custom' && !hasTitle) fail('INVALID_ARGUMENT', 'A custom tab title is required');
  return titleMode;
}
function loadState(file) {
  const initial = { workspaces: [], notifications: [], settings: { fontSize: 14, theme: 'dark' } };
  if (!fs.existsSync(file)) return initial;
  if (fs.statSync(file).size > 4 * 1024 * 1024) fail('STATE_INVALID', 'Saved state exceeds the size limit');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('STATE_INVALID', `Cannot parse saved state; preserve and repair ${file}`); }
  if (![1, 2].includes(saved.version) || !saved.state || !Array.isArray(saved.state.workspaces)) fail('STATE_INVALID', `Unsupported saved state in ${file}`);
  const state = saved.state;
  const ids = new Set(); let count = 0;
  const unique = id => { string(id, 'saved id', 128); if (ids.has(id)) fail('STATE_INVALID', 'Duplicate saved identifier'); ids.add(id); };
  for (const workspace of state.workspaces) {
    unique(workspace.id); string(workspace.name, 'workspace name', 120); string(workspace.cwd, 'cwd', 4096); string(workspace.profileId, 'profileId', 256);
    if (!Array.isArray(workspace.panes) || !workspace.panes.length) fail('STATE_INVALID', 'Workspace has no panes');
    const leaves = new Set();
    for (const pane of workspace.panes) {
      if (++count > LIMITS.panes) fail('STATE_INVALID', 'Too many saved panes');
      unique(pane.id); string(pane.title, 'title', 256); string(pane.cwd, 'cwd', 4096); string(pane.profileId, 'profileId', 256);
      integer(pane.cols, 'cols', 2, 300); integer(pane.rows, 'rows', 1, 200);
      pane.pid = null; pane.status = 'exited'; delete pane.exitCode;
      delete pane.agentId; delete pane.agentLabel; delete pane.agentThreadId; delete pane.agentSessionId; delete pane.agentBinding;
      pane.agentState = 'unknown'; delete pane.agentExitCode; delete pane.agentUpdatedAt; delete pane.agentActivity; delete pane.agentPid;
    }
    const walk = (node, depth) => {
      if (!node || depth > LIMITS.panes) fail('STATE_INVALID', 'Invalid saved layout');
      if (node.type === 'leaf') {
        if (leaves.has(node.paneId) || !workspace.panes.some(p => p.id === node.paneId)) fail('STATE_INVALID', 'Invalid saved pane reference');
        leaves.add(node.paneId);
      } else if (node.type === 'split') {
        unique(node.id);
        if (!['horizontal', 'vertical'].includes(node.direction) || !Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) fail('STATE_INVALID', 'Invalid saved split');
        walk(node.first, depth + 1); walk(node.second, depth + 1);
      } else fail('STATE_INVALID', 'Invalid saved layout node');
    };
    if (workspace.tabs === undefined) workspace.tabs = [{ id: randomUUID(), title: 'Terminal', root: workspace.root }];
    if (!Array.isArray(workspace.tabs) || !workspace.tabs.length || workspace.tabs.length > LIMITS.panes) fail('STATE_INVALID', 'Invalid saved tabs');
    for (const tab of workspace.tabs) {
      unique(tab.id); string(tab.title, 'tab title', 120); walk(tab.root, 0);
      if (tab.titleMode !== undefined && tab.titleMode !== 'auto' && tab.titleMode !== 'custom') fail('STATE_INVALID', 'Invalid saved tab title mode');
      for (const id of leafIds(tab.root)) workspace.panes.find(p => p.id === id).tabId = tab.id;
    }
    syncTabs(workspace);
    if (leaves.size !== workspace.panes.length) fail('STATE_INVALID', 'Saved panes do not match layout');
  }
  if (!state.settings || !['dark', 'light'].includes(state.settings.theme)) fail('STATE_INVALID', 'Invalid saved settings');
  integer(state.settings.fontSize, 'fontSize', 9, 32);
  state.notifications = Array.isArray(state.notifications) ? state.notifications.filter(n => n && typeof n.id === 'string' && typeof n.title === 'string' && typeof n.body === 'string' && typeof n.paneId === 'string' && typeof n.workspaceId === 'string' && Number.isFinite(n.createdAt)).slice(-LIMITS.notifications).map(n => ({ ...n, title: n.title.slice(0, 256), body: n.body.slice(0, 4096), read: Boolean(n.read) })) : [];
  if (!state.workspaces.some(w => w.id === state.settings.activeWorkspaceId)) state.settings.activeWorkspaceId = state.workspaces[0]?.id;
  return state;
}

async function startServer(options = {}) {
  const loc = locations(options);
  fs.mkdirSync(loc.dataDir, { recursive: true, mode: 0o700 });
  const token = createToken(loc.tokenFile);
  // A data-directory lock prevents two daemon instances from owning the same saved sessions.
  const lockValue = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(loc.lockFile, lockValue, { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt > 0) throw error;
      let existing;
      try { existing = JSON.parse(fs.readFileSync(loc.lockFile, 'utf8')); } catch { fail('DAEMON_LOCKED', `Invalid daemon lock; inspect ${loc.lockFile}`); }
      try { process.kill(existing.pid, 0); fail('DAEMON_RUNNING', `Winmux daemon is already running (PID ${existing.pid})`); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      fs.unlinkSync(loc.lockFile);
    }
  }
  const releaseLock = () => {
    try { if (fs.readFileSync(loc.lockFile, 'utf8') === lockValue) fs.unlinkSync(loc.lockFile); } catch {}
  };
  let state, environment, pty, Terminal, SerializeAddon;
  try {
    state = loadState(loc.stateFile);
    environment = await discover();
    pty = require('node-pty');
    ({ Terminal } = require('@xterm/headless'));
    ({ SerializeAddon } = require('@xterm/addon-serialize'));
  } catch (error) { releaseLock(); throw error; }
  const clients = new Set(), runtimes = new Map();
  let codexController, agentController;
  let stopping = false, closePromise, persistTimer, mutationTail = Promise.resolve();
  const publicState = () => structuredClone(state);
  function save() {
    clearTimeout(persistTimer);
    const temp = `${loc.stateFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 2, state }), { mode: 0o600 });
      fs.renameSync(temp, loc.stateFile);
    } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
  }
  function safeSave() { try { save(); } catch (error) { console.error(`Cannot save Winmux state: ${error.message}`); } }
  function send(client, message) {
    if (client.socket.destroyed) return;
    const frame = JSON.stringify(message) + '\n';
    const length = Buffer.byteLength(frame);
    if (length > LIMITS.response || client.socket.writableLength + length > LIMITS.socket) { client.socket.destroy(); return; }
    client.socket.write(frame);
  }
  function broadcast(event) { for (const client of clients) if (client.authorized) send(client, { event }); }
  function changed() { save(); broadcast({ type: 'state', state: publicState() }); }
  function asyncChanged() { safeSave(); broadcast({ type: 'state', state: publicState() }); }
  function workspaceById(id) { const w = state.workspaces.find(w => w.id === id); if (!w) fail('NOT_FOUND', 'Workspace not found'); return w; }
  function paneById(id) {
    for (const workspace of state.workspaces) { const pane = workspace.panes.find(p => p.id === id); if (pane) return { pane, workspace, tab: workspace.tabs.find(t => t.id === pane.tabId), runtime: runtimes.get(id) }; }
    fail('NOT_FOUND', 'Pane not found');
  }
  function addNotification(paneId, title, body = '') {
    const { workspace } = paneById(paneId);
    const notification = { id: randomUUID(), paneId, workspaceId: workspace.id, title, body, createdAt: Date.now(), read: false };
    state.notifications.push(notification);
    state.notifications = state.notifications.slice(-LIMITS.notifications);
    asyncChanged(); broadcast({ type: 'notification', notification });
    return notification;
  }
  function terminalFor(pane) {
    pane.shellReady = false;
    const terminal = new Terminal({ cols: pane.cols, rows: pane.rows, scrollback: LIMITS.scrollback, allowProposedApi: true });
    const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
    const runtime = { terminal, serializer, seq: 0, pending: 0, paused: false, pty: null, disposed: false, lastNotification: 0, subscriptions: [], activity: createActivityTracker() };
    runtimes.set(pane.id, runtime);
    runtime.subscriptions.push(terminal.parser.registerOscHandler(1337, data => {
      const [kind, launchId, state, code] = data.split(';');
      if (kind !== 'WinmuxAgent') return false;
      if (runtime.disposed || stopping || !runtime.agentLaunchId || launchId !== runtime.agentLaunchId || runtime.agentEnded) return true;
      if (!['starting', 'unknown', 'completed', 'failed'].includes(state)) return true;
      if (state === 'completed' || state === 'failed') {
        if (!/^-?\d{1,10}$/.test(code || '')) return true;
        const exitCode = Number(code);
        if ((state === 'completed') !== (exitCode === 0)) return true;
        pane.agentExitCode = exitCode; runtime.agentEnded = true; runtime.activity.clear(); delete pane.agentActivity;
        runtime.agentLaunchId = '';
      }
      // The shell can confirm invocation and exit, never model activity.
      if (state !== 'unknown' || !['running', 'waiting', 'completed', 'failed'].includes(pane.agentState)) pane.agentState = state;
      pane.agentUpdatedAt = Date.now(); asyncChanged(); return true;
    }));
    runtime.subscriptions.push(terminal.parser.registerOscHandler(7, data => {
      if (runtime.disposed || stopping) return true;
      const profile = environment.profiles.find(item => item.id === pane.profileId);
      const cwd = cwdFromOsc(data, profile?.environment);
      if (cwd && (pane.cwd !== cwd || !pane.shellReady)) { pane.cwd = cwd; pane.shellReady = true; asyncChanged(); }
      return true;
    }));
    runtime.subscriptions.push(terminal.onData(data => { if (!runtime.disposed && pane.status === 'running') { try { runtime.pty?.write(data); } catch {} } }));
    if (terminal.onTitleChange) runtime.subscriptions.push(terminal.onTitleChange(title => {
      if (runtime.disposed || stopping || !title.trim()) return;
      pane.title = title.replace(/\0/g, '').slice(0, 256); asyncChanged();
    }));
    for (const command of [9, 777]) runtime.subscriptions.push(terminal.parser.registerOscHandler(command, data => {
      if (runtime.disposed || stopping || Date.now() - runtime.lastNotification < 1000) return true;
      let title, body;
      if (command === 777) { const parts = data.split(';'); if (parts.shift() !== 'notify') return false; title = parts.shift() || 'Terminal'; body = parts.join(';'); }
      else { if (/^[1-9];/.test(data)) return false; title = pane.title; body = data; }
      runtime.lastNotification = Date.now();
      try { addNotification(pane.id, title.slice(0, 256), body.slice(0, 4096)); } catch {}
      return true;
    }));
    return runtime;
  }
  function queueOutput(pane, runtime, data) {
    if (runtime.disposed || runtime.overloaded) return;
    runtime.pending += Buffer.byteLength(data);
    if (runtime.pending > LIMITS.pending) {
      runtime.pending -= Buffer.byteLength(data);
      runtime.overloaded = true;
      try { runtime.pty?.kill(); } catch {}
      addNotification(pane.id, 'Terminal output limit reached', 'The process was stopped because its output exceeded the bounded terminal queue.');
      return;
    }
    if (runtime.pending > 512 * 1024 && !runtime.paused) { runtime.paused = true; runtime.pty?.pause(); }
    // Split large callbacks while preserving UTF-16 surrogate pairs. Sequence numbers belong
    // to processed writes, never to receipt of PTY data, so snapshot fences are exact.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + LIMITS.chunk, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const chunk = data.slice(offset, end); offset = end;
      runtime.terminal.write(chunk, () => {
        if (runtime.disposed) return;
        runtime.pending -= Buffer.byteLength(chunk);
        broadcast({ type: 'output', paneId: pane.id, data: chunk, seq: ++runtime.seq });
        if (runtime.paused && runtime.pending < 128 * 1024) { runtime.paused = false; runtime.pty?.resume(); }
      });
    }
  }
  function fence(runtime, action) {
    if (!runtime || runtime.disposed) fail('PANE_CLOSED', 'Terminal is closed');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Object.assign(new Error('Terminal snapshot timed out'), { code: 'TIMEOUT' })), 5000);
      runtime.terminal.write('', () => {
        clearTimeout(timeout);
        if (runtime.disposed) { reject(Object.assign(new Error('Terminal is closed'), { code: 'PANE_CLOSED' })); return; }
        try { resolve(action()); } catch (error) { reject(error); }
      });
    });
  }
  function spawnPane(pane, launch) {
    const runtime = terminalFor(pane);
    runtime.agentLaunchId = launch.agentLaunchId;
    runtime.agentSessionHooks = launch.agentSessionHooks === true;
    try {
      // Even an unset name in WSLENV creates an empty variable in Linux.
      const forwardedEnv = (process.env.WSLENV || '').split(':').filter(entry => entry.split('/')[0].toUpperCase() !== 'ELECTRON_RUN_AS_NODE');
      const shellEnv = terminalEnvironment(process.env);
      Object.assign(shellEnv, { WINMUX_PANE_ID: pane.id, WINMUX_DATA_DIR: loc.dataDir, WINMUX_PIPE_NAME: loc.pipeName,
        WINMUX_AGENT_LAUNCH_ID: launch.agentLaunchId || '',
        WINMUX_AGENT_NODE: process.execPath, WINMUX_AGENT_HELPER: path.join(__dirname, 'backend', 'agent-status.cjs'),
        WSLENV: [...forwardedEnv, 'WINMUX_PANE_ID', 'WINMUX_DATA_DIR', 'WINMUX_PIPE_NAME', 'WINMUX_AGENT_LAUNCH_ID', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER'].filter(Boolean).join(':') });
      for (const key of Object.keys(shellEnv)) {
        if ((process.platform === 'win32' ? key.toUpperCase() : key) === 'ELECTRON_RUN_AS_NODE') delete shellEnv[key];
      }
      runtime.pty = pty.spawn(launch.profile.command, launch.args, {
        name: 'xterm-256color', cols: pane.cols, rows: pane.rows, cwd: launch.spawnCwd,
        env: shellEnv,
        useConpty: true, useConptyDll: true,
      });
      pane.pid = runtime.pty.pid; pane.status = 'running'; delete pane.exitCode;
      runtime.subscriptions.push(runtime.pty.onData(data => queueOutput(pane, runtime, data)));
      runtime.subscriptions.push(runtime.pty.onExit(({ exitCode }) => {
        if (runtime.disposed || stopping) return;
        fence(runtime, () => {
          if (runtime.disposed || stopping) return;
          pane.status = 'exited'; pane.exitCode = exitCode; pane.pid = null;
          if (runtime.agentLaunchId && !runtime.agentEnded) { pane.agentState = 'unknown'; delete pane.agentExitCode; runtime.agentEnded = true; }
          runtime.agentLaunchId = '';
          asyncChanged(); broadcast({ type: 'exit', paneId: pane.id, exitCode });
        }).catch(error => { if (!runtime.disposed && !stopping) console.error(error.message); });
      }));
      return runtime;
    } catch (error) { disposePane(pane); fail('SPAWN_FAILED', `Cannot start ${launch.profile.label}: ${error.message}`); }
  }
  function disposePane(pane) {
    const runtime = runtimes.get(pane.id);
    if (!runtime) return;
    runtime.disposed = true;
    try { runtime.pty?.kill(); } catch (error) { if (pane.status === 'running') console.warn(`PTY cleanup: ${error.message}`); }
    for (const disposable of runtime.subscriptions) disposable.dispose();
    runtime.terminal.dispose(); runtimes.delete(pane.id);
  }
  const makePane = launch => ({ id: randomUUID(), title: launch.profile.label, profileId: launch.profile.id, cwd: launch.cwd, ...(launch.agentId ? { agentId: launch.agentId, agentLabel: launch.agentLabel } : {}), agentState: launch.agentId ? 'starting' : 'unknown', pid: null, status: 'exited', cols: 100, rows: 28 });
  function tabTitle(workspace, base) {
    let title = base, sequence = 2;
    while (workspace.tabs.some(tab => tab.title === title)) title = `${base} ${sequence++}`;
    return title;
  }
  function removeTab(workspace, tab) {
    const ids = new Set(leafIds(tab.root));
    workspace.panes.filter(p => ids.has(p.id)).forEach(disposePane);
    workspace.panes = workspace.panes.filter(p => !ids.has(p.id));
    const index = workspace.tabs.indexOf(tab);
    workspace.tabs.splice(index, 1);
    if (workspace.activeTabId === tab.id) workspace.activeTabId = workspace.tabs[Math.min(index, workspace.tabs.length - 1)]?.id;
    syncTabs(workspace);
    if (!workspace.tabs.length) {
      state.workspaces = state.workspaces.filter(w => w !== workspace);
      if (state.settings.activeWorkspaceId === workspace.id) state.settings.activeWorkspaceId = state.workspaces[0]?.id;
    }
  }
  async function dispatch(method, params) {
    if (stopping) fail('SHUTTING_DOWN', 'Daemon is shutting down');
    switch (method) {
      case 'state': return publicState();
      case 'environment': return structuredClone(environment);
      case 'workspace.create': {
        if (runtimes.size >= LIMITS.panes) fail('LIMIT_REACHED', 'Maximum number of terminal panes reached');
        const profileId = params.profileId ?? 'powershell'; string(profileId, 'profileId', 256);
        const name = params.name === undefined ? null : string(params.name, 'name', 120).trim();
        const launch = await validateLaunch(environment, profileId, params.cwd, params.agentId, params.agentHooks);
        const pane = makePane(launch);
        const tab = { id: randomUUID(), title: launch.profile.label, root: { type: 'leaf', paneId: pane.id } }; pane.tabId = tab.id;
        tab.titleMode = 'auto';
        const workspace = { id: randomUUID(), name: name || path.basename(launch.cwd) || launch.profile.label, cwd: launch.cwd, profileId, tabs: [tab], activeTabId: tab.id, root: tab.root, panes: [pane] };
        spawnPane(pane, launch); state.workspaces.push(workspace); state.settings.activeWorkspaceId = workspace.id; changed();
        return structuredClone(workspace);
      }
      case 'workspace.rename': {
        const workspace = workspaceById(params.workspaceId); workspace.name = string(params.name, 'name', 120).trim(); changed(); return structuredClone(workspace);
      }
      case 'workspace.close': {
        const workspace = workspaceById(params.workspaceId); workspace.panes.forEach(disposePane);
        state.workspaces = state.workspaces.filter(w => w !== workspace);
        if (state.settings.activeWorkspaceId === workspace.id) state.settings.activeWorkspaceId = state.workspaces[0]?.id;
        changed(); return { ok: true };
      }
      case 'tab.create': {
        if (runtimes.size >= LIMITS.panes) fail('LIMIT_REACHED', 'Maximum number of terminal panes reached');
        const workspace = workspaceById(params.workspaceId);
        const source = params.sourcePaneId === undefined ? workspace.panes.find(p => p.tabId === workspace.activeTabId) : workspace.panes.find(p => p.id === params.sourcePaneId);
        if (!source) fail('NOT_FOUND', 'Source pane does not belong to workspace');
        const requestedTitle = params.title === undefined ? null : string(params.title, 'title', 120).trim();
        const titleMode = tabTitleMode(params.titleMode, Boolean(requestedTitle));
        const profileId = params.profileId ?? source.profileId;
        const launch = await validateLaunch(environment, profileId, params.cwd ?? (profileId === source.profileId ? source.cwd : undefined), params.agentId, params.agentHooks);
        const pane = makePane(launch);
        const tab = { id: randomUUID(), title: requestedTitle || tabTitle(workspace, launch.agentLabel || launch.profile.label), titleMode, root: { type: 'leaf', paneId: pane.id } }; pane.tabId = tab.id;
        spawnPane(pane, launch); workspace.panes.push(pane); workspace.tabs.push(tab); workspace.activeTabId = tab.id;
        state.settings.activeWorkspaceId = workspace.id; syncTabs(workspace); changed(); return structuredClone(tab);
      }
      case 'tab.select': {
        const workspace = workspaceById(params.workspaceId), tab = workspace.tabs.find(t => t.id === params.tabId);
        if (!tab) fail('NOT_FOUND', 'Tab not found');
        workspace.activeTabId = tab.id; state.settings.activeWorkspaceId = workspace.id; syncTabs(workspace); changed(); return structuredClone(tab);
      }
      case 'tab.close': {
        const workspace = workspaceById(params.workspaceId), tab = workspace.tabs.find(t => t.id === params.tabId);
        if (!tab) fail('NOT_FOUND', 'Tab not found');
        removeTab(workspace, tab); changed(); return { ok: true };
      }
      case 'pane.split': {
        if (runtimes.size >= LIMITS.panes) fail('LIMIT_REACHED', 'Maximum number of terminal panes reached');
        const { pane: source, workspace, tab } = paneById(params.paneId);
        if (!['horizontal', 'vertical'].includes(params.direction)) fail('INVALID_ARGUMENT', 'direction must be horizontal or vertical');
        const profileId = params.profileId ?? source.profileId;
        const launch = await validateLaunch(environment, profileId, params.cwd ?? (profileId === source.profileId ? source.cwd : undefined), params.agentId, params.agentHooks);
        const pane = makePane(launch); pane.tabId = tab.id; spawnPane(pane, launch);
        tab.root = replaceLeaf(tab.root, source.id, { type: 'split', id: randomUUID(), direction: params.direction, ratio: 0.5, first: { type: 'leaf', paneId: source.id }, second: { type: 'leaf', paneId: pane.id } });
        workspace.panes.push(pane); syncTabs(workspace); changed(); return structuredClone(pane);
      }
      case 'pane.close': {
        const { pane, workspace, tab } = paneById(params.paneId);
        if (tab.root.type === 'leaf') removeTab(workspace, tab);
        else { disposePane(pane); tab.root = replaceLeaf(tab.root, pane.id, null); workspace.panes = workspace.panes.filter(p => p !== pane); syncTabs(workspace); }
        changed(); return { ok: true };
      }
      case 'pane.input': {
        const { pane, runtime } = paneById(params.paneId);
        if (pane.status !== 'running' || !runtime?.pty) fail('PANE_EXITED', 'Terminal process has exited');
        string(params.data, 'data', LIMITS.input, true);
        if (Buffer.byteLength(params.data) > LIMITS.input) fail('LIMIT_REACHED', 'Terminal input exceeds 64 KiB');
        runtime.pty.write(params.data); return { ok: true };
      }
      case 'pane.resize': {
        const { pane, runtime } = paneById(params.paneId);
        const cols = integer(params.cols, 'cols', 2, 300), rows = integer(params.rows, 'rows', 1, 200);
        if (pane.cols === cols && pane.rows === rows) return { ok: true };
        return fence(runtime, () => {
          if (pane.status === 'running') runtime.pty.resize(cols, rows);
          runtime.terminal.resize(cols, rows); pane.cols = cols; pane.rows = rows;
          clearTimeout(persistTimer); persistTimer = setTimeout(safeSave, 150); return { ok: true };
        });
      }
      case 'pane.snapshot': {
        const { runtime } = paneById(params.paneId);
        return fence(runtime, () => ({ data: runtime.serializer.serialize({ scrollback: LIMITS.scrollback }), seq: runtime.seq, cols: runtime.terminal.cols, rows: runtime.terminal.rows }));
      }
      case 'pane.screen': {
        const { runtime } = paneById(params.paneId);
        return fence(runtime, () => {
          const buffer = runtime.terminal.buffer.active, lines = [];
          for (let y = 0; y < runtime.terminal.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '');
          return { text: lines.join('\n'), cols: runtime.terminal.cols, rows: runtime.terminal.rows };
        });
      }
      case 'layout.ratio': {
        const split = workspaceById(params.workspaceId).tabs.map(tab => findSplit(tab.root, params.splitId)).find(Boolean);
        if (!split) fail('NOT_FOUND', 'Split not found');
        if (!Number.isFinite(params.ratio) || params.ratio < 0.1 || params.ratio > 0.9) fail('INVALID_ARGUMENT', 'ratio must be between 0.1 and 0.9');
        split.ratio = params.ratio; changed(); return { ok: true };
      }
      case 'agent.status': {
        const { pane, runtime } = paneById(params.paneId);
        if (!AGENT_STATES.has(params.state)) fail('INVALID_ARGUMENT', 'Invalid agent state');
        if (!runtime?.agentLaunchId || runtime.agentEnded || pane.status !== 'running') fail('AGENT_NOT_ACTIVE', 'Pane has no active agent launch');
        if (params.launchId !== runtime.agentLaunchId) fail('STALE_AGENT_LAUNCH', 'Agent launch identity does not match');
        if (params.phase !== undefined && !['start', 'end'].includes(params.phase)) fail('INVALID_ARGUMENT', 'Invalid activity phase');
        const toolName = params.toolName === undefined ? undefined : string(params.toolName, 'toolName', 256);
        const toolId = params.toolId === undefined ? undefined : string(params.toolId, 'toolId', 256);
        if (params.phase) runtime.activity.update({ phase: params.phase, toolName, toolId });
        pane.agentState = params.state; pane.agentUpdatedAt = Date.now();
        if (params.state === 'running') pane.agentActivity = runtime.activity.current();
        else { delete pane.agentActivity; if (params.state !== 'waiting') runtime.activity.clear(); }
        changed(); return { paneId: pane.id, state: pane.agentState, updatedAt: pane.agentUpdatedAt };
      }
      case 'notify': return addNotification(params.paneId, string(params.title, 'title', 256), string(params.body ?? '', 'body', 4096, true));
      case 'notifications.read': {
        if (params.id !== undefined && !state.notifications.some(n => n.id === params.id)) fail('NOT_FOUND', 'Notification not found');
        for (const n of state.notifications) if (params.id === undefined || n.id === params.id) n.read = true;
        changed(); return { ok: true };
      }
      case 'settings.update': {
        const next = { ...state.settings };
        if (params.fontSize !== undefined) next.fontSize = integer(params.fontSize, 'fontSize', 9, 32);
        if (params.theme !== undefined) { if (!['dark', 'light'].includes(params.theme)) fail('INVALID_ARGUMENT', 'theme must be dark or light'); next.theme = params.theme; }
        if (params.activeWorkspaceId !== undefined) { workspaceById(params.activeWorkspaceId); next.activeWorkspaceId = params.activeWorkspaceId; }
        state.settings = next; changed(); return { ...next };
      }
      case 'daemon.shutdown': setTimeout(() => close().catch(error => console.error(error.message)), 30); return { ok: true };
      case 'codex.status': return codexController.status();
      case 'agent.sessions': return agentController.sessions();
      case 'agent.bind': {
        const sessionId = string(params.sessionId, 'sessionId', 128);
        paneById(params.paneId);
        await codexController.refreshProcesses();
        const result = agentController.bind(params.paneId, sessionId);
        if (!result.applied) fail('INVALID_BINDING', 'Select a current Hermes session and its terminal pane');
        return result;
      }
      case 'codex.bind': {
        const threadId = string(params.threadId, 'threadId', 128);
        paneById(params.paneId);
        const result = await codexController.bind(params.paneId, threadId);
        if (!result.ok) fail(result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code, result.code === 'STALE_THREAD' ? 'Codex thread is not available for this pane' : 'A Codex process must be running in this pane');
        return result;
      }
      case 'agent.hook': {
        const agentId = string(params.agentId, 'agentId', 64);
        const event = string(params.event, 'event', 64);
        const sessionId = string(params.sessionId, 'sessionId', 128);
        const cwd = params.cwd === undefined ? '' : string(params.cwd, 'cwd', 4096, true);
        const paneId = params.paneId === undefined ? undefined : string(params.paneId, 'paneId', 128);
        if (paneId && agentId !== 'hermes') paneById(paneId);
        const toolName = params.toolName === undefined ? undefined : string(params.toolName, 'toolName', 256);
        const toolId = params.toolId === undefined ? undefined : string(params.toolId, 'toolId', 256);
        const phase = params.phase;
        if (phase !== undefined && !['start', 'end'].includes(phase)) fail('INVALID_ARGUMENT', 'Invalid activity phase');
        if (agentId === 'codex') return codexController.hook({ agentId, event, sessionId, cwd, paneId, toolName, toolId, phase });
        if (!['omp', 'claude', 'hermes', 'pi'].includes(agentId)) return { applied: false, reason: 'agent' };
        const pid = params.pid === undefined ? undefined : integer(params.pid, 'pid', 1, Number.MAX_SAFE_INTEGER);
        const stamp = params.stamp === undefined ? undefined : string(params.stamp, 'stamp', 32);
        const emittedAt = params.emittedAt === undefined ? undefined : integer(params.emittedAt, 'emittedAt', 1, Number.MAX_SAFE_INTEGER);
        const hook = { agentId, event, sessionId, cwd, paneId, pid, stamp, emittedAt, state: params.state, toolName, toolId, phase };
        if (!agentController.hasCandidate(hook)) await codexController.refreshProcesses();
        return agentController.hook(hook);
      }
      default: fail('METHOD_NOT_FOUND', `Unknown method: ${method}`);
    }
  }
  const reads = new Set(['state', 'environment', 'pane.snapshot', 'pane.screen', 'pane.input', 'codex.status', 'agent.sessions']);
  function codexPanes() {
    return state.workspaces.flatMap(workspace => workspace.panes.map(pane => ({
      id: pane.id, pid: pane.pid, status: pane.status, cwd: pane.cwd, agentId: pane.agentId,
      agentState: pane.agentState, agentThreadId: pane.agentThreadId, agentSessionId: pane.agentSessionId,
      agentBinding: pane.agentBinding, agentLaunchLocked: Boolean(runtimes.get(pane.id)?.agentSessionHooks && runtimes.get(pane.id)?.agentLaunchId && !runtimes.get(pane.id)?.agentEnded),
    })));
  }
  function applyCodexIdentity(paneId, identity) {
    let pane;
    try { pane = paneById(paneId).pane; } catch { return; }
    const runtime = runtimes.get(pane.id);
    if (runtime?.agentSessionHooks && runtime.agentLaunchId && !runtime.agentEnded) return;
    if (pane.agentId && pane.agentId !== 'codex' && (!identity || pane.agentPid)) return;
    if (!identity) {
      delete pane.agentId; delete pane.agentLabel; delete pane.agentThreadId;
      delete pane.agentSessionId; delete pane.agentBinding;
      pane.agentState = 'unknown'; delete pane.agentActivity;
    } else {
      if (identity.agentId) pane.agentId = identity.agentId;
      if (identity.agentLabel) pane.agentLabel = identity.agentLabel;
      if (Object.hasOwn(identity, 'agentThreadId')) {
        if (identity.agentThreadId) pane.agentThreadId = identity.agentThreadId;
        else delete pane.agentThreadId;
      }
      if (Object.hasOwn(identity, 'agentSessionId')) {
        if (identity.agentSessionId) pane.agentSessionId = identity.agentSessionId;
        else delete pane.agentSessionId;
      }
      if (Object.hasOwn(identity, 'agentBinding')) {
        if (identity.agentBinding) pane.agentBinding = identity.agentBinding;
        else delete pane.agentBinding;
      }
      if (identity.agentState && AGENT_STATES.has(identity.agentState)) pane.agentState = identity.agentState;
      if (pane.agentState === 'running' && ACTIVITY_KINDS.has(identity.agentActivity)) pane.agentActivity = identity.agentActivity;
      else delete pane.agentActivity;
    }
    pane.agentUpdatedAt = Date.now(); asyncChanged();
  }
  function applyAgentIdentity(paneId, identity) {
    let pane;
    try { pane = paneById(paneId).pane; } catch { return; }
    const runtime = runtimes.get(pane.id);
    if (runtime?.agentSessionHooks && runtime.agentLaunchId && !runtime.agentEnded) return;
    if (!identity && pane.agentId === 'codex') return;
    const before = JSON.stringify([pane.agentId, pane.agentLabel, pane.agentPid, pane.agentSessionId, pane.agentState, pane.agentActivity]);
    for (const key of ['agentId', 'agentLabel', 'agentPid', 'agentSessionId']) {
      if (identity?.[key]) pane[key] = identity[key]; else delete pane[key];
    }
    delete pane.agentThreadId; delete pane.agentBinding;
    pane.agentState = identity?.agentState || 'unknown';
    if (pane.agentState === 'running' && ACTIVITY_KINDS.has(identity?.agentActivity)) pane.agentActivity = identity.agentActivity;
    else delete pane.agentActivity;
    const after = JSON.stringify([pane.agentId, pane.agentLabel, pane.agentPid, pane.agentSessionId, pane.agentState, pane.agentActivity]);
    if (after !== before) { pane.agentUpdatedAt = Date.now(); asyncChanged(); }
  }
  agentController = createAgentController({ panes: codexPanes, apply: applyAgentIdentity });
  codexController = createCodexController({
    panes: codexPanes, apply: applyCodexIdentity,
    onProcesses: processes => agentController.scan(processes),
    ...(options.codex ? { connect: options.codex.connect, listProcesses: options.codex.listProcesses, intervalMs: options.codex.intervalMs } : {}),
  });
  const server = net.createServer(socket => {
    if (stopping || clients.size >= LIMITS.clients) { socket.destroy(); return; }
    socket.setEncoding('utf8');
    const client = { socket, authorized: false, buffer: '', inflight: 0 };
    clients.add(client);
    const authTimeout = setTimeout(() => { if (!client.authorized) socket.destroy(); }, 5000);
    socket.on('error', () => {});
    socket.on('close', () => { clients.delete(client); clearTimeout(authTimeout); });
    socket.on('data', chunk => {
      client.buffer += chunk;
      let index;
      while ((index = client.buffer.indexOf('\n')) !== -1) {
        const line = client.buffer.slice(0, index); client.buffer = client.buffer.slice(index + 1);
        if (Buffer.byteLength(line) > LIMITS.request || ++client.inflight > LIMITS.inflight) { socket.destroy(); return; }
        let request;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!request || !['string', 'number'].includes(typeof request.id) || String(request.id).length > 128 || !authenticated(request.token, token)) {
          send(client, { id: request?.id ?? null, error: { code: 'UNAUTHORIZED', message: 'Invalid IPC credentials' } }); socket.end(); setTimeout(() => socket.destroy(), 100).unref(); return;
        }
        client.authorized = true; clearTimeout(authTimeout);
        const method = request.method, params = request.params ?? {};
        if (typeof method !== 'string' || method.length > 128 || !params || typeof params !== 'object' || Array.isArray(params)) {
          send(client, { id: request.id, error: { code: 'INVALID_ARGUMENT', message: 'Expected a method and a params object' } }); client.inflight--; continue;
        }
        const invoke = () => dispatch(method, params);
        const result = reads.has(method) ? Promise.resolve().then(invoke) : mutationTail.then(invoke);
        if (!reads.has(method)) mutationTail = result.catch(() => {});
        result.then(value => send(client, { id: request.id, result: value }), error => send(client, { id: request.id, error: { code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR', message: error.message || 'Request failed' } })).finally(() => client.inflight--);
      }
      if (Buffer.byteLength(client.buffer) > LIMITS.request) socket.destroy();
    });
  });
  async function close() {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      clearTimeout(persistTimer);
      await mutationTail;
      await codexController?.stop();
      safeSave();
      for (const workspace of state.workspaces) workspace.panes.forEach(disposePane);
      for (const client of clients) client.socket.destroy();
      await new Promise(resolve => server.close(resolve));
      releaseLock();
      if (process.platform !== 'win32') { try { fs.unlinkSync(loc.pipeName); } catch {} }
    })();
    return closePromise;
  }
  try {
    // Restore identifiers/layout and start fresh shells. No command history is replayed.
    for (const workspace of state.workspaces) for (const pane of workspace.panes) {
      try { const launch = await validateLaunch(environment, pane.profileId, pane.cwd); spawnPane(pane, launch); }
      catch (error) {
        pane.pid = null; pane.status = 'exited'; pane.exitCode = -1;
        const runtime = runtimes.get(pane.id) || terminalFor(pane);
        queueOutput(pane, runtime, `\r\n[Winmux could not restore this terminal]\r\n${error.message}\r\n`);
        addNotification(pane.id, 'Terminal could not be restored', error.message.slice(0, 4096));
      }
    }
    safeSave();
    if (process.platform !== 'win32' && fs.existsSync(loc.pipeName)) fs.unlinkSync(loc.pipeName);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(loc.pipeName, () => { server.removeListener('error', reject); resolve(); }); });
    if (process.platform !== 'win32') fs.chmodSync(loc.pipeName, 0o600);
    if (options.codex || (options.codex !== false && process.env.WINMUX_NO_PROFILE !== '1' && process.env.WINMUX_TEST_MODE !== '1')) codexController.start();
  } catch (error) { await close(); throw error; }
  server.on('error', error => console.error(`Winmux IPC server error: ${error.message}`));
  return { server, dataDir: loc.dataDir, pipeName: loc.pipeName, close, shutdown: close };
}
module.exports = { startServer, tabTitleMode };
if (require.main === module) {
  startServer().then(daemon => {
    const stop = () => daemon.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    daemon.server.once('close', () => setTimeout(() => process.exit(0), 150).unref());
    console.log(`Winmux daemon ready (PID ${process.pid})`);
  }).catch(error => { console.error(`Winmux daemon failed: ${error.message}`); process.exitCode = 1; });
}
