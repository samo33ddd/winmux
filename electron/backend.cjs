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
const { createTaskGitService, createGitExecutor } = require('./backend/task-git.cjs');
const { createTaskDelivery, normalizeTaskReview } = require('./backend/task-delivery.cjs');
const { deliverySupportFor } = require('./backend/task-instructions.cjs');

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
function setAgentState(pane, next, reset = false) {
  if (reset || pane.agentState !== next || !Number.isFinite(pane.agentStateSince)) pane.agentStateSince = Date.now();
  pane.agentState = next;
}
const STATE_MAX_BYTES = 4 * 1024 * 1024;
const STATE_RECOVERY_MAX_BYTES = 16 * 1024 * 1024;
function tabTitleMode(titleMode, hasTitle) {
  if (titleMode === undefined) return hasTitle ? 'custom' : 'auto';
  if (titleMode !== 'auto' && titleMode !== 'custom') fail('INVALID_ARGUMENT', 'titleMode must be auto or custom');
  if (titleMode === 'custom' && !hasTitle) fail('INVALID_ARGUMENT', 'A custom tab title is required');
  return titleMode;
}
function boundedText(value, max) {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result;
}
function stateDocument(state) { return JSON.stringify({ version: 3, state }); }
function fitStateSize(state) {
  let serialized = stateDocument(state);
  if (Buffer.byteLength(serialized) <= STATE_MAX_BYTES) return { serialized, dropped: 0 };
  const total = state.notifications.length;
  let low = 0, high = total;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...state, notifications: state.notifications.slice(-middle) };
    if (Buffer.byteLength(stateDocument(candidate)) <= STATE_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  state.notifications = low ? state.notifications.slice(-low) : [];
  serialized = stateDocument(state);
  if (Buffer.byteLength(serialized) > STATE_MAX_BYTES) fail('STATE_INVALID', 'Saved workspace state exceeds the size limit');
  return { serialized, dropped: total - low };
}
function backupRecoveredState(file) {
  const backup = `${file}.recovery-${Date.now()}-${randomUUID().slice(0, 8)}.bak`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(backup, 0o600); } catch {}
}
function loadState(file) {
  const initial = { workspaces: [], projects: [], tasks: [], notifications: [], settings: { fontSize: 14, theme: 'dark' } };
  if (!fs.existsSync(file)) return initial;
  const savedBytes = fs.statSync(file).size;
  if (savedBytes > STATE_RECOVERY_MAX_BYTES) fail('STATE_INVALID', 'Saved state exceeds the recovery size limit');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('STATE_INVALID', `Cannot parse saved state; preserve and repair ${file}`); }
  if (![1, 2, 3].includes(saved.version) || !saved.state || !Array.isArray(saved.state.workspaces)) fail('STATE_INVALID', `Unsupported saved state in ${file}`);
  const state = saved.state;
  if (saved.version < 3) {
    fs.copyFileSync(file, `${file}.pre-tasks-${randomUUID()}.bak`, fs.constants.COPYFILE_EXCL);
    state.projects = []; state.tasks = [];
  }
  let recovered = savedBytes > STATE_MAX_BYTES;
  const ids = new Set(); let count = 0;
  const unique = id => { string(id, 'saved id', 128); if (ids.has(id)) fail('STATE_INVALID', 'Duplicate saved identifier'); ids.add(id); };
  for (const workspace of state.workspaces) {
    unique(workspace.id);
    if (typeof workspace.name !== 'string' || !workspace.name.trim() || workspace.name.includes('\0')) fail('STATE_INVALID', 'Invalid saved workspace name');
    const normalizedName = workspace.name.trim();
    const boundedName = boundedText(normalizedName, 120) || 'Workspace';
    if (boundedName !== workspace.name) { workspace.name = boundedName; recovered = true; }
    string(workspace.cwd, 'cwd', 4096); string(workspace.profileId, 'profileId', 256);
    if (!Array.isArray(workspace.panes) || !workspace.panes.length) fail('STATE_INVALID', 'Workspace has no panes');
    const leaves = new Set();
    for (const pane of workspace.panes) {
      if (++count > LIMITS.panes) fail('STATE_INVALID', 'Too many saved panes');
      unique(pane.id); string(pane.title, 'title', 256); string(pane.cwd, 'cwd', 4096); string(pane.profileId, 'profileId', 256);
      integer(pane.cols, 'cols', 2, 300); integer(pane.rows, 'rows', 1, 200);
      pane.pid = null; pane.status = 'exited'; delete pane.exitCode;
      delete pane.agentId; delete pane.agentLabel; delete pane.agentThreadId; delete pane.agentSessionId; delete pane.agentBinding;
      pane.agentState = 'unknown'; delete pane.agentStateSince; delete pane.agentExitCode; delete pane.agentUpdatedAt; delete pane.agentActivity; delete pane.agentPid;
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
  if (!Array.isArray(state.projects) || !Array.isArray(state.tasks) || state.projects.length > 1024 || state.tasks.length > 4096) fail('STATE_INVALID', 'Invalid project or task records');
  for (const project of state.projects) {
    unique(project.id); string(project.name, 'project name', 120); string(project.root, 'project root', 4096);
    string(project.profileId, 'project profile', 256); string(project.primaryBranch, 'primary branch', 256);
  }
  for (const task of state.tasks) {
    unique(task.id); string(task.name, 'task name', 120); string(task.projectId, 'task project', 128);
    string(task.cwd, 'task directory', 4096); string(task.branch, 'task branch', 256); string(task.base, 'task base', 256);
    if (!state.projects.some(project => project.id === task.projectId) || typeof task.managed !== 'boolean' || typeof task.archived !== 'boolean') fail('STATE_INVALID', 'Invalid task ownership');
    if (task.ownership && (task.ownership.taskId !== task.id || task.ownership.path !== task.cwd || task.ownership.branch !== task.branch || typeof task.ownership.marker !== 'string' || typeof task.ownership.adminDir !== 'string')) fail('STATE_INVALID', 'Invalid worktree ownership record');
    if (task.workspaceId !== undefined && !state.workspaces.some(workspace => workspace.id === task.workspaceId)) delete task.workspaceId;
    if (task.review !== undefined) {
      try {
        const review = normalizeTaskReview(task.review);
        if (JSON.stringify(review) !== JSON.stringify(task.review)) { task.review = review; recovered = true; }
      } catch { fail('STATE_INVALID', 'Invalid task review record'); }
    }
  }
  if (!state.settings || !['dark', 'light'].includes(state.settings.theme)) fail('STATE_INVALID', 'Invalid saved settings');
  integer(state.settings.fontSize, 'fontSize', 9, 32);
  state.notifications = Array.isArray(state.notifications) ? state.notifications.filter(n => n && typeof n.id === 'string' && typeof n.title === 'string' && typeof n.body === 'string' && typeof n.paneId === 'string' && typeof n.workspaceId === 'string' && Number.isFinite(n.createdAt)).slice(-LIMITS.notifications).map(n => ({
    id: boundedText(n.id, 128), paneId: boundedText(n.paneId, 128), workspaceId: boundedText(n.workspaceId, 128),
    title: n.title.slice(0, 256), body: n.body.slice(0, 4096), createdAt: n.createdAt, read: Boolean(n.read),
  })) : [];
  const fitted = fitStateSize(state);
  if (fitted.dropped) recovered = true;
  if (!state.workspaces.some(w => w.id === state.settings.activeWorkspaceId)) state.settings.activeWorkspaceId = state.workspaces[0]?.id;
  if (recovered) backupRecoveredState(file);
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
  const clients = new Set(), runtimes = new Map(), deliveries = new Set(), archives = new Set(), deliveryRequests = new Set();
  const ownership = {
    get: id => state.tasks.find(task => task.id === id)?.ownership,
    set: (id, record) => { const task = state.tasks.find(item => item.id === id); if (!task) fail('NOT_FOUND', 'Task not found'); task.ownership = record; changed(); },
    delete: id => { const task = state.tasks.find(item => item.id === id); if (task) { delete task.ownership; changed(); } },
    entries: () => state.tasks.map(task => task.ownership).filter(Boolean),
  };
  const taskGit = createTaskGitService({store:ownership}), executeTaskGit = createGitExecutor();
  let codexController, agentController;
  let stopping = false, closePromise, persistTimer, mutationTail = Promise.resolve();
  const publicState = () => structuredClone(state);
  function save() {
    clearTimeout(persistTimer);
    const temp = `${loc.stateFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, fitStateSize(state).serialized, { mode: 0o600 });
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
  function broadcast(event) {
    for (const client of clients) if (client.authorized) {
      if (event.type === 'state' && client.socket.writableNeedDrain) client.pendingState = event;
      else {
        if (event.type === 'state') delete client.pendingState;
        send(client, { event });
      }
    }
  }
  function changed() { save(); broadcast({ type: 'state', state: publicState() }); }
  function asyncChanged() { safeSave(); broadcast({ type: 'state', state: publicState() }); }
  function workspaceById(id) { const w = state.workspaces.find(w => w.id === id); if (!w) fail('NOT_FOUND', 'Workspace not found'); return w; }
  function taskById(id) { const task = state.tasks.find(item => item.id === id); if (!task) fail('NOT_FOUND', 'Task not found'); return task; }
  function projectContext(project) {
    const profile = environment.profiles.find(item => item.id === project.profileId);
    if (!profile || profile.available === false) fail('PROFILE_UNAVAILABLE', 'Project shell environment is unavailable');
    return { repo:project.root, environment:profile.environment, distro:profile.distro };
  }
  async function deliveryFor(task) {
    const project = state.projects.find(item => item.id === task.projectId);
    if (!project || task.archived || archives.has(task.id) || task.phase !== 'ready') fail('TASK_UNAVAILABLE', 'Task is unavailable for delivery');
    const context = { ...projectContext(project), cwd:task.cwd };
    const git = async args => (await executeTaskGit(args, context)).stdout.trim();
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch !== task.branch) fail('TASK_BRANCH_MISMATCH', 'Task worktree is not on its assigned branch');
    const sha = await git(['rev-parse', '--verify', 'HEAD']);
    const remote = await git(['remote', 'get-url', 'origin']);
    const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote);
    if (!match) fail('GITHUB_UNAVAILABLE', 'The origin must be a GitHub repository without embedded credentials');
    const repo = match[1];
    return { delivery:(options.createTaskDelivery || createTaskDelivery)({ repo, base:project.primaryBranch }), spec:{source:repo, head:task.branch, sha, ...(task.delivery?.number ? {number:task.delivery.number} : {}), ...(task.review ? {review:task.review} : {})}, project };
  }
  function forgetWorkspace(id) { for (const task of state.tasks) if (task.workspaceId === id) delete task.workspaceId; }
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
  function notifyAgentState(pane) {
    const runtime = runtimes.get(pane.id);
    if (!runtime || !pane.agentId) return;
    if (['starting','running','waiting','idle'].includes(pane.agentState)) { runtime.lastAgentNotice = ''; return; }
    if (!['completed','failed'].includes(pane.agentState)) return;
    const notice = `${pane.agentId}:${pane.agentState}`;
    if (runtime.lastAgentNotice === notice) return;
    runtime.lastAgentNotice = notice;
    addNotification(pane.id, pane.agentState === 'failed' ? 'Agent failed' : 'Agent completed', pane.agentLabel || pane.agentId);
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
      if (state !== 'unknown' || !['running', 'waiting', 'completed', 'failed'].includes(pane.agentState)) setAgentState(pane, state);
      notifyAgentState(pane);
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
    runtime.cleanupHooks = launch.cleanupHooks;
    try {
      // Even an unset name in WSLENV creates an empty variable in Linux.
      const forwardedEnv = (process.env.WSLENV || '').split(':').filter(entry => entry.split('/')[0].toUpperCase() !== 'ELECTRON_RUN_AS_NODE');
      const shellEnv = terminalEnvironment(process.env);
      Object.assign(shellEnv, { WINMUX_PANE_ID: pane.id, WINMUX_DATA_DIR: loc.dataDir, WINMUX_PIPE_NAME: loc.pipeName,
        WINMUX_TASK_ID: launch.taskId || '',
        WINMUX_AGENT_LAUNCH_ID: launch.agentLaunchId || '',
        WINMUX_AGENT_NODE: process.execPath, WINMUX_AGENT_HELPER: path.join(__dirname, 'backend', 'agent-status.cjs'),
        WSLENV: [...forwardedEnv, 'WINMUX_PANE_ID', 'WINMUX_DATA_DIR', 'WINMUX_PIPE_NAME', 'WINMUX_TASK_ID', 'WINMUX_AGENT_LAUNCH_ID', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER'].filter(Boolean).join(':') });
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
        runtime.cleanupHooks?.();
        if (runtime.disposed || stopping) return;
        fence(runtime, () => {
          if (runtime.disposed || stopping) return;
          pane.status = 'exited'; pane.exitCode = exitCode; pane.pid = null;
          if (runtime.agentLaunchId && !runtime.agentEnded) { setAgentState(pane, 'unknown'); delete pane.agentExitCode; runtime.agentEnded = true; }
          runtime.agentLaunchId = '';
          asyncChanged(); broadcast({ type: 'exit', paneId: pane.id, exitCode });
        }).catch(error => { if (!runtime.disposed && !stopping) console.error(error.message); });
      }));
      return runtime;
    } catch (error) { launch.cleanupHooks?.(); disposePane(pane); fail('SPAWN_FAILED', `Cannot start ${launch.profile.label}: ${error.message}`); }
  }
  function disposePane(pane) {
    const runtime = runtimes.get(pane.id);
    if (!runtime) return;
    runtime.disposed = true;
    runtime.cleanupHooks?.();
    try { runtime.pty?.kill(); } catch (error) { if (pane.status === 'running') console.warn(`PTY cleanup: ${error.message}`); }
    for (const disposable of runtime.subscriptions) disposable.dispose();
    runtime.terminal.dispose(); runtimes.delete(pane.id);
  }
  const makePane = launch => ({ id: launch.paneId, title: launch.profile.label, profileId: launch.profile.id, cwd: launch.cwd, ...(launch.agentId ? { agentId: launch.agentId, agentLabel: launch.agentLabel } : {}), agentState: launch.agentId ? 'starting' : 'unknown', pid: null, status: 'exited', cols: 100, rows: 28 });
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
      forgetWorkspace(workspace.id);
      state.workspaces = state.workspaces.filter(w => w !== workspace);
      if (state.settings.activeWorkspaceId === workspace.id) state.settings.activeWorkspaceId = state.workspaces[0]?.id;
    }
  }
  async function dispatch(method, params) {
    if (stopping) fail('SHUTTING_DOWN', 'Daemon is shutting down');
    switch (method) {
      case 'state': return publicState();
      case 'environment': return structuredClone(environment);
      case 'project.inspect': {
        const profile = environment.profiles.find(item => item.id === params.profileId);
        if (!profile || profile.available === false || !['windows', 'wsl'].includes(profile.environment)) fail('PROFILE_UNAVAILABLE', 'Project shell environment is unavailable');
        const repo = string(params.cwd, 'cwd', 4096);
        const context = { repo, environment: profile.environment, distro: profile.distro };
        const repository = await taskGit.inspectRepository(context);
        const branches = await taskGit.listBranches(context);
        const worktrees = await taskGit.listWorktrees(context);
        let primary = '';
        try { primary = (await executeTaskGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd:repo, environment:profile.environment, distro:profile.distro })).stdout.trim().replace(/^origin\//, ''); } catch {}
        if (!branches.some(branch => branch.name === primary)) primary = ['main', 'master'].find(name => branches.some(branch => branch.name === name)) || '';
        return { root:worktrees[0]?.path || repository.root, commonDir:repository.commonDir, branches:branches.map(branch => branch.name), primary, worktrees:worktrees.map((worktree, index) => ({ path:worktree.path, branch:worktree.branch || '', primary:index === 0, detached:worktree.detached })) };
      }
      case 'task.create': {
        const profileId = string(params.profileId, 'profileId', 256);
        const name = string(params.name, 'name', 120).trim();
        const agentId = string(params.agentId, 'agentId', 256);
        const base = string(params.baseBranch, 'baseBranch', 256);
        if (!['new', 'attach'].includes(params.mode)) fail('INVALID_ARGUMENT', 'Invalid task mode');
        const inspected = await dispatch('project.inspect', { cwd:params.projectDirectory, profileId });
        const primary = inspected.primary || string(params.primaryBranch, 'primaryBranch', 256);
        if (!inspected.branches.includes(primary)) fail('PRIMARY_UNAVAILABLE', 'Select an existing primary branch');
        if (!inspected.branches.includes(base)) fail('INVALID_ARGUMENT', 'Base branch must be local');
        const agentHooks = Boolean(environment.agents?.find(agent => agent.id === agentId)?.hookAdapter);
        await validateLaunch(environment, profileId, inspected.root, agentId, false);
        const profile = environment.profiles.find(item => item.id === profileId);
        const identity = value => {
          if (profile.environment !== 'windows') return path.posix.normalize(value);
          try { return fs.realpathSync.native(value).toLowerCase(); }
          catch { return path.win32.normalize(value).toLowerCase(); }
        };
        let project = state.projects.find(item => {
          const projectProfile = environment.profiles.find(candidate => candidate.id === item.profileId);
          return identity(item.commonDir || '') === identity(inspected.commonDir) && projectProfile?.environment === profile.environment && projectProfile.distro === profile.distro;
        });
        if (!project) {
          const paths = profile.environment === 'wsl' ? path.posix : path.win32;
          project = { id:randomUUID(), name:paths.basename(inspected.root).slice(0,120) || 'Project', root:inspected.root, commonDir:inspected.commonDir, profileId, primaryBranch:primary };
          state.projects.push(project);
        }
        const paths = profile.environment === 'wsl' ? path.posix : path.win32;
        const id = randomUUID(), slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
        let cwd = paths.join(paths.dirname(project.root), `${paths.basename(project.root)}.winmux-worktrees`, id);
        let branch = `winmux/${slug}-${id.slice(0,8)}`;
        if (params.mode === 'attach') {
          cwd = string(params.worktreePath, 'worktreePath', 4096);
          const found = inspected.worktrees.find(item => identity(item.path) === identity(cwd));
          if (!found || found.primary || found.detached || !found.branch) fail('INVALID_ARGUMENT', 'Select a linked worktree with a branch');
          branch = found.branch; cwd = found.path;
          if (state.tasks.some(item => (!item.archived || item.phase === 'ready') && item.projectId === project.id && identity(item.cwd) === identity(cwd))) fail('ALREADY_EXISTS', 'This worktree is already attached to a task');
        }
        const task = { id, name, projectId:project.id, cwd, branch, base, agentId, managed:params.mode === 'new', archived:false, phase:'creating', deliverySupport:deliverySupportFor(agentId) };
        state.tasks.push(task); changed();
        try {
          const context = { ...projectContext(project), path:cwd, branch, base, taskId:id };
          if (task.managed) await taskGit.createWorktree(context); else await taskGit.attachWorktree(context);
          task.phase = 'ready'; changed();
          const workspace = await dispatch('workspace.create', { name, cwd, profileId, agentId, agentHooks, taskId:task.id });
          delete task.error; changed();
          return workspace;
        } catch (error) { task.error = String(error.message || error).slice(0, 1024); changed(); throw error; }
      }
      case 'task.open': {
        const task = taskById(params.taskId), project = state.projects.find(item => item.id === task.projectId);
        if (!project) fail('NOT_FOUND', 'Task project not found');
        const existing = state.workspaces.find(item => item.id === task.workspaceId);
        if (existing) return structuredClone(existing);
        if (task.phase !== 'ready') fail('TASK_INCOMPLETE', task.error || 'Task creation did not finish; inspect the worktree before retrying');
        if (task.archived && task.removed) {
          await taskGit.createWorktree({ ...projectContext(project), path:task.cwd, branch:task.branch, base:task.base, taskId:task.id, restore:true });
          task.removed = false; changed();
        }
        const workspace = await dispatch('workspace.create', {name:task.name,cwd:task.cwd,profileId:project.profileId,taskId:task.id});
        delete task.error; changed(); return workspace;
      }
      case 'task.archive': {
        const task = taskById(params.taskId), project = state.projects.find(item => item.id === task.projectId);
        if (!project) fail('NOT_FOUND', 'Task project not found');
        if (deliveries.has(task.id)) fail('TASK_IN_USE', 'Wait for the task delivery operation to finish');
        if (state.workspaces.some(item => item.id === task.workspaceId)) fail('TASK_IN_USE', 'Close task terminals before archiving');
        archives.add(task.id);
        try {
        let reason = '';
        const context = projectContext(project), paths = context.environment === 'wsl' ? path.posix : path.win32;
        const contains = value => { const relative = paths.relative(task.cwd, value); return relative === '' || (!relative.startsWith('..' + paths.sep) && relative !== '..' && !paths.isAbsolute(relative)); };
        const sameEnvironment = profileId => { const profile = environment.profiles.find(item => item.id === profileId); return profile?.environment === context.environment && profile.distro === context.distro; };
        if (state.workspaces.some(workspace => (sameEnvironment(workspace.profileId) && contains(workspace.cwd)) || workspace.panes.some(pane => sameEnvironment(pane.profileId) && contains(pane.cwd)))) reason = 'Worktree is used by another workspace';
        else if (task.managed && task.ownership) {
          try { await taskGit.removeWorktree({ ...context, path:task.cwd, taskId:task.id }); task.removed = true; }
          catch (error) { reason = String(error.message || error).slice(0, 1024); }
        }
        task.archived = true; task.archiveReason = reason; changed(); return { archived:true, removed:task.removed === true, reason };
        } finally { archives.delete(task.id); }
      }
      case 'task.delivery.context': {
        const task = taskById(params.taskId), project = state.projects.find(item => item.id === task.projectId);
        if (!project) fail('NOT_FOUND', 'Task project not found');
        return { taskId:task.id, name:task.name, branch:task.branch, cwd:task.cwd, primaryBranch:project.primaryBranch, delivery:task.delivery || null, review:task.review || null };
      }
      case 'task.delivery.review': {
        const task = taskById(params.taskId);
        if (deliveries.has(task.id)) fail('TASK_IN_USE', 'Another delivery operation is running for this task');
        deliveries.add(task.id);
        try {
          const review = normalizeTaskReview({ sha:params.sha, reviewer:params.reviewer, summary:params.summary, outcome:params.outcome, reviewedAt:Date.now() });
          const { spec } = await deliveryFor(task);
          if (review.sha !== spec.sha) fail('STALE_HEAD', 'Review commit does not match the current task HEAD');
          task.review = review; changed(); return review;
        } finally { deliveries.delete(task.id); }
      }
      case 'task.delivery.refresh':
      case 'task.delivery.submit':
      case 'task.delivery.merge': {
        const task = taskById(params.taskId);
        if (deliveries.has(task.id)) fail('TASK_IN_USE', 'Another delivery operation is running for this task');
        deliveries.add(task.id);
        try {
          const { delivery, spec } = await deliveryFor(task);
          const result = method === 'task.delivery.submit' ? await delivery.submit({ ...spec, title:params.title, body:params.body }) : method === 'task.delivery.merge' ? await delivery.merge(spec) : await delivery.status(spec);
          task.delivery = result; changed(); return result;
        } catch (error) {
          task.delivery = { state:null, code:typeof error.code === 'string' ? error.code : 'UNAVAILABLE', number:task.delivery?.number || null, url:task.delivery?.url || null, headOid:null };
          changed(); throw error;
        } finally { deliveries.delete(task.id); }
      }
      case 'workspace.create': {
        if (runtimes.size >= LIMITS.panes) fail('LIMIT_REACHED', 'Maximum number of terminal panes reached');
        const profileId = params.profileId ?? 'powershell'; string(profileId, 'profileId', 256);
        const requestedName = params.name === undefined ? null : string(params.name, 'name', 120).trim();
        const task = params.taskId === undefined ? null : taskById(params.taskId);
        if (task && (task.cwd !== params.cwd || state.projects.find(item => item.id === task.projectId)?.profileId !== profileId || (params.agentId !== undefined && task.agentId !== params.agentId) || task.phase !== 'ready' || state.workspaces.some(item => item.id === task.workspaceId))) fail('INVALID_ARGUMENT', 'Task does not match the launch');
        const launch = await validateLaunch(environment, profileId, params.cwd, params.agentId, params.agentHooks, { dataDir: loc.dataDir, pipeName: loc.pipeName }, task?.id);
        if (task) launch.taskId = task.id;
        const pane = makePane(launch);
        const tab = { id: randomUUID(), title: launch.profile.label, root: { type: 'leaf', paneId: pane.id } }; pane.tabId = tab.id;
        tab.titleMode = 'auto';
        const autoName = boundedText((path.basename(launch.cwd) || launch.profile.label).trim(), 120) || launch.profile.label;
        const workspace = { id: randomUUID(), name: requestedName || autoName, cwd: launch.cwd, profileId, tabs: [tab], activeTabId: tab.id, root: tab.root, panes: [pane] };
        spawnPane(pane, launch); state.workspaces.push(workspace); if (task) { task.workspaceId = workspace.id; task.archived = false; } state.settings.activeWorkspaceId = workspace.id; changed();
        return structuredClone(workspace);
      }
      case 'workspace.rename': {
        const workspace = workspaceById(params.workspaceId); workspace.name = string(params.name, 'name', 120).trim(); changed(); return structuredClone(workspace);
      }
      case 'workspace.close': {
        const workspace = workspaceById(params.workspaceId); workspace.panes.forEach(disposePane);
        forgetWorkspace(workspace.id);
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
        const task = state.tasks.find(item => item.workspaceId === workspace.id && !item.archived);
        const launch = await validateLaunch(environment, profileId, params.cwd ?? (profileId === source.profileId ? source.cwd : undefined), params.agentId, params.agentHooks, { dataDir: loc.dataDir, pipeName: loc.pipeName }, task && task.agentId === params.agentId ? task.id : undefined);
        if (task) launch.taskId = task.id;
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
        const task = state.tasks.find(item => item.workspaceId === workspace.id && !item.archived);
        const launch = await validateLaunch(environment, profileId, params.cwd ?? (profileId === source.profileId ? source.cwd : undefined), params.agentId, params.agentHooks, { dataDir: loc.dataDir, pipeName: loc.pipeName }, task && task.agentId === params.agentId ? task.id : undefined);
        if (task) launch.taskId = task.id;
        const pane = makePane(launch); pane.tabId = tab.id; spawnPane(pane, launch);
        tab.root = replaceLeaf(tab.root, source.id, { type: 'split', id: randomUUID(), direction: params.direction, ratio: 0.5, first: { type: 'leaf', paneId: source.id }, second: { type: 'leaf', paneId: pane.id } });
        workspace.panes.push(pane); syncTabs(workspace); changed(); return structuredClone(pane);
      }
      case 'pane.move': {
        const paneId = string(params.paneId, 'paneId', 128);
        const targetPaneId = string(params.targetPaneId, 'targetPaneId', 128);
        const side = string(params.side, 'side', 16);
        if (!['left', 'right', 'top', 'bottom'].includes(side)) fail('INVALID_ARGUMENT', 'side must be left, right, top, or bottom');
        if (paneId === targetPaneId) fail('INVALID_ARGUMENT', 'A pane cannot be moved beside itself');
        const source = paneById(paneId), target = paneById(targetPaneId);
        if (source.workspace.id !== target.workspace.id) fail('INVALID_ARGUMENT', 'Cannot move a pane across workspaces');
        if (!source.tab || !target.tab) fail('STATE_INVALID', 'Pane is not attached to a tab');
        const { pane: movedPane, workspace, tab: sourceTab } = source;
        const { pane: targetPane, tab: targetTab } = target;
        const sourceRoot = replaceLeaf(sourceTab.root, movedPane.id, null);
        if (sourceTab === targetTab) sourceTab.root = sourceRoot;
        else if (sourceRoot) sourceTab.root = sourceRoot;
        else workspace.tabs = workspace.tabs.filter(tab => tab !== sourceTab);
        const horizontal = side === 'left' || side === 'right';
        const movedFirst = side === 'left' || side === 'top';
        const movedLeaf = { type: 'leaf', paneId: movedPane.id };
        const targetLeaf = { type: 'leaf', paneId: targetPane.id };
        targetTab.root = replaceLeaf(targetTab.root, targetPane.id, {
          type: 'split', id: randomUUID(), direction: horizontal ? 'horizontal' : 'vertical', ratio: 0.5,
          first: movedFirst ? movedLeaf : targetLeaf, second: movedFirst ? targetLeaf : movedLeaf,
        });
        movedPane.tabId = targetTab.id;
        workspace.activeTabId = targetTab.id;
        state.settings.activeWorkspaceId = workspace.id;
        syncTabs(workspace);
        changed();
        return { paneId: movedPane.id, workspaceId: workspace.id, tabId: targetTab.id };
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
        if (typeof params.data !== 'string' || params.data.length > LIMITS.input) fail('INVALID_ARGUMENT', `data must be a string of at most ${LIMITS.input} characters`);
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
        setAgentState(pane, params.state); pane.agentUpdatedAt = Date.now();
        notifyAgentState(pane);
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
  const reads = new Set(['state', 'environment', 'project.inspect', 'task.delivery.context', 'task.delivery.refresh', 'task.delivery.submit', 'task.delivery.merge', 'pane.snapshot', 'pane.screen', 'pane.input', 'codex.status', 'agent.sessions']);
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
    // Process/thread observations describe a current agent, not the previous
    // shell-launched command whose exit code may still be on this pane.
    const oldIdentity = `${pane.agentId || ''}:${pane.agentPid || ''}:${pane.agentSessionId || ''}:${pane.agentThreadId || ''}`;
    const oldState = pane.agentState;
    delete pane.agentExitCode;
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
    setAgentState(pane, pane.agentState, oldState !== pane.agentState || oldIdentity !== `${pane.agentId || ''}:${pane.agentPid || ''}:${pane.agentSessionId || ''}:${pane.agentThreadId || ''}`);
    notifyAgentState(pane);
    pane.agentUpdatedAt = Date.now(); asyncChanged();
  }
  function applyAgentIdentity(paneId, identity) {
    let pane;
    try { pane = paneById(paneId).pane; } catch { return; }
    const runtime = runtimes.get(pane.id);
    if (runtime?.agentSessionHooks && runtime.agentLaunchId && !runtime.agentEnded) return;
    if (!identity && pane.agentId === 'codex') return;
    const before = JSON.stringify([pane.agentId, pane.agentLabel, pane.agentPid, pane.agentSessionId, pane.agentState, pane.agentActivity, pane.agentExitCode]);
    const oldIdentity = `${pane.agentId || ''}:${pane.agentPid || ''}:${pane.agentSessionId || ''}`;
    const oldState = pane.agentState;
    delete pane.agentExitCode;
    for (const key of ['agentId', 'agentLabel', 'agentPid', 'agentSessionId']) {
      if (identity?.[key]) pane[key] = identity[key]; else delete pane[key];
    }
    delete pane.agentThreadId; delete pane.agentBinding;
    pane.agentState = identity?.agentState || 'unknown';
    if (pane.agentState === 'running' && ACTIVITY_KINDS.has(identity?.agentActivity)) pane.agentActivity = identity.agentActivity;
    else delete pane.agentActivity;
    const after = JSON.stringify([pane.agentId, pane.agentLabel, pane.agentPid, pane.agentSessionId, pane.agentState, pane.agentActivity, pane.agentExitCode]);
    if (after !== before) { setAgentState(pane, pane.agentState, oldState !== pane.agentState || oldIdentity !== `${pane.agentId || ''}:${pane.agentPid || ''}:${pane.agentSessionId || ''}`); notifyAgentState(pane); pane.agentUpdatedAt = Date.now(); asyncChanged(); }
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
    socket.on('close', () => { clients.delete(client); delete client.pendingState; clearTimeout(authTimeout); });
    socket.on('drain', () => {
      if (!client.pendingState) return;
      const event = client.pendingState;
      delete client.pendingState;
      send(client, { event });
    });
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
        if (method.startsWith('task.delivery.') && method !== 'task.delivery.context') {
          deliveryRequests.add(result);
          result.finally(() => deliveryRequests.delete(result)).catch(() => {});
        }
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
      await Promise.allSettled([...deliveryRequests]);
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
    for (const workspace of state.workspaces) {
      const task = state.tasks.find(item => item.workspaceId === workspace.id && !item.archived);
      for (const pane of workspace.panes) {
        try {
          const launch = await validateLaunch(environment, pane.profileId, pane.cwd, undefined, undefined, { dataDir: loc.dataDir, pipeName: loc.pipeName }, task?.id);
          if (task) launch.taskId = task.id;
          spawnPane(pane, launch);
        } catch (error) {
          pane.pid = null; pane.status = 'exited'; pane.exitCode = -1;
          const runtime = runtimes.get(pane.id) || terminalFor(pane);
          queueOutput(pane, runtime, `\r\n[Winmux could not restore this terminal]\r\n${error.message}\r\n`);
          addNotification(pane.id, 'Terminal could not be restored', error.message.slice(0, 4096));
        }
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
module.exports = { startServer, tabTitleMode, setAgentState, loadState };
if (require.main === module) {
  startServer().then(daemon => {
    const stop = () => daemon.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    daemon.server.once('close', () => setTimeout(() => process.exit(0), 150).unref());
    console.log(`Winmux daemon ready (PID ${process.pid})`);
  }).catch(error => { console.error(`Winmux daemon failed: ${error.message}`); process.exitCode = 1; });
}
