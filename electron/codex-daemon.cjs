// Read-only JSON-RPC client for the shared native Codex app-server daemon.
// The daemon is never started, restarted, stopped, or sent prompts.
'use strict';

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 16;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 6000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;
const CLIENT_NAME = 'winmux';
const CLIENT_TITLE = 'Winmux';
const ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const READ_METHODS = new Set(['thread/list', 'thread/loaded/list']);

class CodexDaemonError extends Error {
  constructor(message, code = 'unavailable', cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CodexDaemonError';
    this.code = code;
  }
}

function unavailable(message, cause) {
  return new CodexDaemonError(message, 'unavailable', cause);
}

function normalizeStatus(status, completedThreadIds = new Set()) {
  if (status?.type === 'notLoaded') return { type: 'notLoaded' };
  if (status?.type === 'idle') return { type: 'idle' };
  if (status?.type === 'systemError') return { type: 'systemError' };
  if (status?.type === 'active') {
    const flags = Array.isArray(status.activeFlags)
      ? [...new Set(status.activeFlags.filter(flag => ACTIVE_FLAGS.has(flag)))]
      : [];
    return { type: 'active', activeFlags: flags };
  }
  if (status?.type === 'completed' && typeof status.threadId === 'string' && completedThreadIds.has(status.threadId)) {
    return { type: 'completed' };
  }
  return { type: 'unknown' };
}

function publicThread(thread, loadedIds, completedThreadIds) {
  if (!thread || typeof thread.id !== 'string' || !thread.id) return null;
  if (typeof thread.sessionId !== 'string' || !thread.sessionId) return null;
  const source = thread.source && typeof thread.source === 'object'
    ? { ...thread.source }
    : thread.source ?? null;
  return {
    id: thread.id,
    cwd: typeof thread.cwd === 'string' ? thread.cwd : null,
    name: typeof thread.name === 'string' ? thread.name : null,
    status: normalizeStatus(thread.status, completedThreadIds),
    parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null,
    source,
    sessionId: thread.sessionId,
    loaded: loadedIds.has(thread.id),
  };
}

function normalizeLimit(limit) {
  const value = Number.isInteger(limit) ? limit : DEFAULT_LIST_LIMIT;
  if (value < 1 || value > MAX_LIST_LIMIT) throw unavailable('Thread list limit must be from 1 to 100');
  return value;
}

function createWebSocket({ WebSocket, stream, handshakeTimeout, maxPayload }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket('ws://localhost/', {
      createConnection: () => stream,
      handshakeTimeout,
      maxPayload,
      perMessageDeflate: false,
      skipUTF8Validation: false,
    });
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(unavailable('Codex daemon WebSocket handshake failed', error));
    };
    socket.once('open', () => {
      if (settled) return;
      settled = true;
      resolve(socket);
    });
    socket.once('error', fail);
    socket.once('unexpected-response', () => fail(new Error('WebSocket upgrade was rejected')));
  });
}

function parseFrame(chunk) {
  if (typeof chunk === 'string') return JSON.parse(chunk);
  if (Buffer.isBuffer(chunk)) return JSON.parse(chunk.toString('utf8'));
  if (ArrayBuffer.isView(chunk)) return JSON.parse(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8'));
  if (chunk instanceof ArrayBuffer) return JSON.parse(Buffer.from(chunk).toString('utf8'));
  throw new Error('Unsupported daemon frame');
}

function createProxyTransport(options) {
  const spawnProcess = options.spawnProcess || spawn;
  const command = options.command;
  if (isBatch(command)) throw unavailable('Codex proxy requires the daemon executable');
  const args = [...(options.args || ['app-server', 'proxy']), ...(options.socketPath ? ['--sock', options.socketPath] : [])];
  const child = spawnProcess(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: options.env,
    shell: false,
  });
  const stderr = new StringDecoder('utf8');
  let stderrText = '';
  child.stderr?.on('data', chunk => {
    stderrText = (stderrText + stderr.write(chunk)).slice(-4096);
  });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  return {
    stream,
    close() {
      stream.destroy();
      child.kill();
    },
    describeExit() {
      const detail = stderrText.trim();
      return detail ? `Codex proxy exited: ${detail}` : 'Codex proxy exited';
    },
    onClose(listener) {
      child.once('error', error => listener(unavailable('Codex proxy could not start', error)));
      child.once('exit', () => listener(unavailable(this.describeExit())));
    },
  };
}

function isBatch(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function launch(spawnProcess, command, args, stdio) {
  const childOptions = { stdio, windowsHide: true, shell: false };
  if (!isBatch(command)) return spawnProcess(command, args, childOptions);
  return spawnProcess(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], childOptions);
}

function readOutput(child, timeoutMs, clock) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = clock.setTimeout(() => {
      child.kill?.();
      finish(unavailable('Codex daemon version timed out'));
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout = (stdout + decoder.write(chunk)).slice(-65536); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.once('error', error => finish(unavailable('Codex executable was not found', error)));
    child.once('exit', code => finish(code === 0 ? null : unavailable(stderr.trim() || 'Codex daemon version failed'), stdout));
  });
}

function parseDaemonVersion(value) {
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? {});
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw unavailable('Codex daemon version was not JSON');
  let version;
  try { version = JSON.parse(text.slice(start, end + 1)); }
  catch (error) { throw unavailable('Codex daemon version was not JSON', error); }
  if (version.status !== 'running' && version.status !== 'alreadyRunning') throw unavailable('Codex daemon is not running');
  if (typeof version.managedCodexPath !== 'string' || !version.managedCodexPath.trim()) throw unavailable('Codex daemon did not report its executable');
  if (process.platform === 'win32' && !/\.exe$/i.test(version.managedCodexPath)) throw unavailable('Codex daemon did not report its executable');
  return version;
}

async function discoverCodexCommand(spawnProcess, clock, timeoutMs) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const stdout = await readOutput(spawnProcess(locator, ['codex'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
  }), timeoutMs, clock);
  const paths = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const selected = process.platform === 'win32'
    ? paths.find(item => /\.exe$/i.test(item)) || paths.find(item => /\.(cmd|bat)$/i.test(item))
    : paths[0];
  if (!selected) throw unavailable('Codex executable was not found');
  return selected;
}

async function readDaemonVersion(command, spawnProcess, clock, timeoutMs) {
  const stdout = await readOutput(
    launch(spawnProcess, command, ['app-server', 'daemon', 'version'], ['ignore', 'pipe', 'pipe']),
    timeoutMs,
    clock,
  );
  return parseDaemonVersion(stdout);
}

async function resolveLaunch(options, clock, timeoutMs) {
  const spawnProcess = options.spawnProcess || spawn;
  const version = typeof options.version === 'function'
    ? parseDaemonVersion(await options.version())
    : await readDaemonVersion(options.command || await discoverCodexCommand(spawnProcess, clock, timeoutMs), spawnProcess, clock, timeoutMs);
  const explicitExecutable = typeof options.command === 'string' && options.command && !isBatch(options.command);
  return {
    command: explicitExecutable ? options.command : version.managedCodexPath,
    socketPath: options.socketPath || version.socketPath,
  };
}

function createCodexDaemon(options = {}) {
  const clock = options.clock || { now: () => Date.now(), setTimeout, clearTimeout };
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const clientVersion = options.clientVersion || '0.0.0';
  const emitter = new EventEmitter();
  const pending = new Map();
  const threads = new Map();
  const loadedIds = new Set();
  const completedThreadIds = new Set();
  let nextId = 1;
  let socket = null;
  let transport = null;
  let connectPromise = null;
  let disposed = false;
  let generation = 0;
  let daemon = null;

  function snapshot() {
    return {
      available: socket?.readyState === 1 && !disposed,
      threads: [...threads.values()].map(thread => ({ ...thread, status: { ...thread.status, ...(thread.status.activeFlags ? { activeFlags: [...thread.status.activeFlags] } : {}) } })),
      loadedThreadIds: [...loadedIds],
    };
  }

  function failPending(error) {
    for (const request of pending.values()) {
      clock.clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function cleanup(error) {
    const current = socket;
    const currentTransport = transport;
    socket = null;
    transport = null;
    connectPromise = null;
    generation += 1;
    if (current) {
      current.removeAllListeners();
      if (typeof current.terminate === 'function' && current.readyState !== 3) current.terminate();
      else if (typeof current.close === 'function') current.close();
    }
    currentTransport?.close();
    failPending(error);
    emitter.emit('unavailable', error);
  }

  function rejectStale(currentGeneration) {
    if (currentGeneration !== generation || disposed) throw unavailable('Codex daemon connection closed');
  }

  function applyThread(thread) {
    const normalized = publicThread(thread, loadedIds, completedThreadIds);
    if (!normalized) return null;
    threads.set(normalized.id, normalized);
    return normalized;
  }

  function handleNotification(message) {
    if (message.method === 'thread/status/changed' && typeof message.params?.threadId === 'string') {
      const existing = threads.get(message.params.threadId);
      const status = normalizeStatus(message.params.status);
      if (existing) {
        existing.status = status;
        emitter.emit('thread', { ...existing, status: { ...status } });
      }
      emitter.emit('status', { threadId: message.params.threadId, status });
      return;
    }
    if (message.method === 'turn/completed' && (message.params?.turn?.status === 'completed' || message.params?.turn?.status === 'failed') && typeof message.params.threadId === 'string') {
      const turnStatus = message.params.turn.status;
      if (turnStatus === 'completed') completedThreadIds.add(message.params.threadId);
      const existing = threads.get(message.params.threadId);
      if (turnStatus === 'completed' && existing && existing.status.type !== 'active' && existing.status.type !== 'systemError') {
        existing.status = { type: 'completed' };
        emitter.emit('thread', { ...existing });
      }
      emitter.emit('turn', { threadId: message.params.threadId, status: turnStatus });
    }
  }

  function handleMessage(chunk) {
    let message;
    try {
      message = parseFrame(chunk);
    } catch (error) {
      cleanup(unavailable('Codex daemon returned invalid JSON', error));
      return;
    }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        emitter.emit('notification', message);
        return;
      }
      handleNotification(message);
      emitter.emit('notification', message);
      return;
    }
    if (Object.hasOwn(message, 'id') && message.id !== null) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clock.clearTimeout(request.timer);
      if (message.error) request.reject(unavailable(message.error.message || 'Codex daemon request failed'));
      else request.resolve(message.result);
      return;
    }
  }

  function request(method, params, currentGeneration) {
    rejectStale(currentGeneration);
    if (!READ_METHODS.has(method) && method !== 'initialize') throw unavailable(`Codex method is not available: ${method}`);
    if (!socket || socket.readyState !== 1) throw unavailable('Codex daemon is not connected');
    if (pending.size >= MAX_PENDING) throw unavailable('Codex daemon has too many pending requests');
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        pending.delete(id);
        reject(unavailable(`Codex daemon timed out during ${method}`));
        cleanup(unavailable('Codex daemon request timed out'));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.delete(id);
        clock.clearTimeout(timer);
        reject(unavailable('Codex daemon request could not be sent', error));
      }
    });
  }

  async function connect() {
    if (disposed) throw unavailable('Codex daemon adapter is closed');
    if (connectPromise) return connectPromise;
    const currentGeneration = generation;
    connectPromise = (async () => {
      let WebSocket = options.WebSocket;
      if (!WebSocket) {
        try { WebSocket = require('ws'); }
        catch (error) { throw unavailable('WebSocket client is not available', error); }
      }
      rejectStale(currentGeneration);
      const launchTarget = await resolveLaunch(options, clock, requestTimeoutMs);
      rejectStale(currentGeneration);
      transport = (options.createTransport || createProxyTransport)({
        ...options,
        command: launchTarget.command,
        socketPath: launchTarget.socketPath,
      });
      transport.onClose(error => {
        if (transport && generation === currentGeneration) cleanup(error);
      });
      socket = await createWebSocket({
        WebSocket,
        stream: transport.stream,
        handshakeTimeout: handshakeTimeoutMs,
        maxPayload: MAX_FRAME_BYTES,
      });
      rejectStale(currentGeneration);
      socket.on('message', handleMessage);
      socket.on('error', error => cleanup(unavailable('Codex daemon connection failed', error)));
      socket.on('close', () => cleanup(unavailable('Codex daemon connection closed')));
      await request('initialize', {
        clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: clientVersion },
        capabilities: { experimentalApi: true },
      }, currentGeneration);
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      emitter.emit('available');
    })().catch(error => {
      cleanup(error instanceof CodexDaemonError ? error : unavailable('Codex daemon connection failed', error));
      throw error;
    });
    return connectPromise;
  }

  async function refresh(query = {}) {
    await connect();
    const currentGeneration = generation;
    const limit = normalizeLimit(query.limit);
    const cwd = query.cwd == null ? undefined : Array.isArray(query.cwd) ? query.cwd : [query.cwd];
    if (cwd && cwd.some(value => typeof value !== 'string' || !value)) throw unavailable('Codex thread cwd filter is invalid');
    const [listed, loaded] = await Promise.all([
      request('thread/list', {
        limit,
        ...(cwd ? { cwd } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        useStateDbOnly: true,
      }, currentGeneration),
      request('thread/loaded/list', {}, currentGeneration),
    ]);
    rejectStale(currentGeneration);
    loadedIds.clear();
    for (const id of loaded?.data || []) if (typeof id === 'string') loadedIds.add(id);
    const page = [];
    for (const thread of listed?.data || []) {
      const normalized = applyThread(thread);
      if (normalized) page.push(normalized);
    }
    const state = snapshot();
    emitter.emit('threads', state);
    return { threads: page, nextCursor: listed?.nextCursor ?? null, loadedThreadIds: state.loadedThreadIds };
  }

  async function list(method, params = {}) {
    await connect();
    const currentGeneration = generation;
    const limit = params.limit == null ? undefined : normalizeLimit(params.limit);
    const result = await request(method, {
      ...(params.cwd == null ? {} : { cwd: params.cwd }),
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ...(limit == null ? {} : { limit }),
      ...(params.useStateDbOnly == null ? {} : { useStateDbOnly: params.useStateDbOnly === true }),
    }, currentGeneration);
    rejectStale(currentGeneration);
    const data = method === 'thread/list'
      ? (result?.data || []).map(thread => publicThread(thread, loadedIds, completedThreadIds)).filter(Boolean)
      : (result?.data || []).filter(id => typeof id === 'string');
    if (method === 'thread/loaded/list') {
      loadedIds.clear();
      for (const id of data) loadedIds.add(id);
      for (const thread of threads.values()) thread.loaded = loadedIds.has(thread.id);
    }
    if (method === 'thread/list') for (const thread of data) threads.set(thread.id, thread);
    return { data, nextCursor: result?.nextCursor ?? null };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cleanup(unavailable('Codex daemon adapter closed'));
    emitter.removeAllListeners();
  }

  function onNotification(listener) {
    emitter.on('notification', listener);
    return () => emitter.off('notification', listener);
  }

  daemon = {
    connect,
    refresh,
    listThreads: params => list('thread/list', params),
    listLoaded: params => list('thread/loaded/list', params),
    readState: () => snapshot(),
    onNotification,
    dispose,
    close: dispose,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    get connected() { return socket?.readyState === 1 && !disposed; },
  };
  return daemon;
}

function connectReadonly(options = {}) {
  const client = createCodexDaemon({ ...options, readOnly: true });
  return client.connect().then(() => client);
}

module.exports = {
  ACTIVE_FLAGS,
  CodexDaemonError,
  MAX_FRAME_BYTES,
  MAX_LIST_LIMIT,
  MAX_PENDING,
  connectReadonly,
  createCodexDaemon,
  normalizeStatus,
  parseDaemonVersion,
  publicThread,
};
