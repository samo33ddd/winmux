// Isolated protocol fixtures for the read-only Codex daemon adapter.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createController } = require('../electron/codex-integration.cjs');
const {
  connectReadonly,
  createCodexDaemon,
  normalizeStatus,
  parseDaemonVersion,
  publicThread,
} = require('../electron/codex-daemon.cjs');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.terminated = false;
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    queueMicrotask(() => this.respond(message));
  }

  respond(message) {
    if (message.method === 'initialize') {
      this.emit('message', JSON.stringify({
        id: message.id,
        result: { userAgent: 'codex/0.167.0', platformFamily: 'windows', platformOs: 'windows' },
      }));
      return;
    }
    if (message.method === 'thread/list') {
      this.emit('message', JSON.stringify({
        id: message.id,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      }));
      this.emit('message', JSON.stringify({
        id: message.id,
        result: {
          data: [{
            id: 'thread-1',
            sessionId: 'session-1',
            cwd: 'E:\\projects\\winmux',
            name: 'Winmux',
            preview: 'secret transcript',
            parentThreadId: null,
            source: 'vscode',
            status: { type: 'active', activeFlags: [] },
            turns: [{ id: 'turn-secret', items: [{ text: 'hidden' }] }],
          }, {
            id: 'thread-2',
            sessionId: 'session-2',
            cwd: 'E:\\projects\\hd-helper',
            name: null,
            source: 'cli',
            status: { type: 'idle' },
          }],
          nextCursor: 'page-2',
        },
      }));
      return;
    }
    if (message.method === 'thread/loaded/list') {
      this.emit('message', JSON.stringify({ id: message.id, result: { data: ['thread-1'], nextCursor: null } }));
    }
  }

  terminate() {
    this.readyState = 3;
    this.terminated = true;
    this.emit('close');
  }
}

function fixtureDaemon(respond) {
  let socket;
  const daemon = createCodexDaemon({
    command: 'codex',
    version: async () => ({ status: 'running', managedCodexPath: 'C:\\codex\\codex.exe', socketPath: 'C:\\codex\\control.sock' }),
    WebSocket: class {
      constructor(_url, options) {
        socket = new FakeSocket();
        if (respond) {
          socket.respond = message => {
            const result = respond(message);
            if (result === undefined) FakeSocket.prototype.respond.call(socket, message);
            else socket.emit('message', JSON.stringify({ id: message.id, result }));
          };
        }
        options.createConnection();
        queueMicrotask(() => socket.emit('open'));
        return socket;
      }
    },
    createTransport: () => ({ stream: {}, close() {}, onClose() {} }),
    requestTimeoutMs: 50,
  });
  return { daemon, socket: () => socket };
}

const fixtureCwd = 'E:\\fixture\\project';
function rootThread(id) {
  return { id, sessionId: `session-${id}`, cwd: fixtureCwd, parentThreadId: null, status: { type: 'idle' } };
}

function nativeController(t, respond, panes = [{ id: 'pane', pid: 100, status: 'running', cwd: fixtureCwd, agentState: 'unknown' }]) {
  const fixture = fixtureDaemon(respond);
  const controller = createController({
    createDaemon: () => fixture.daemon,
    listProcesses: async () => [{ pid: 101, ppid: 100, name: 'codex.exe', commandLine: 'codex' }],
    panes: () => panes,
    apply(id, identity) {
      const pane = panes.find(item => item.id === id);
      if (!pane) return;
      Object.assign(pane, identity);
      for (const key of ['agentThreadId', 'agentSessionId', 'agentBinding']) if (pane[key] === '') delete pane[key];
    },
  });
  t.after(() => controller.stop());
  return { ...fixture, controller, panes };
}

function twoPageResponse(message) {
  if (message.method === 'thread/list') {
    return message.params.cursor
      ? { data: [rootThread('root-b')], nextCursor: null }
      : { data: [rootThread('root-a')], nextCursor: 'threads-page-2' };
  }
  if (message.method === 'thread/loaded/list') {
    return message.params.cursor
      ? { data: ['root-b'], nextCursor: null }
      : { data: ['root-a'], nextCursor: 'loaded-page-2' };
  }
}

test('status normalization preserves runtime states and does not invent completion', () => {
  assert.deepEqual(normalizeStatus({ type: 'notLoaded' }), { type: 'notLoaded' });
  assert.deepEqual(normalizeStatus({ type: 'idle' }), { type: 'idle' });
  assert.deepEqual(normalizeStatus({ type: 'systemError' }), { type: 'systemError' });
  assert.deepEqual(
    normalizeStatus({ type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnApproval', 'foreign'] }),
    { type: 'active', activeFlags: ['waitingOnApproval'] },
  );
  assert.deepEqual(normalizeStatus({ type: 'completed' }), { type: 'unknown' });
  assert.equal(JSON.stringify(publicThread({
    id: 'thread-1', sessionId: 'session-1', preview: 'hidden', turns: [{ items: ['hidden'] }], status: { type: 'idle' },
  }, new Set(), new Set())).includes('hidden'), false);
});

test('read-only client handshakes, ignores server requests, and returns sanitized pages', async () => {
  const { daemon, socket } = fixtureDaemon();
  const client = await daemon.connect().then(() => daemon);
  const notifications = [];
  const unsubscribe = client.onNotification(message => notifications.push(message.method));
  const loaded = await client.listLoaded();
  const threads = await client.listThreads({ cwd: ['E:\\projects\\winmux'], limit: 20, useStateDbOnly: true });

  assert.deepEqual(socket().sent.map(message => message.method), [
    'initialize', 'initialized', 'thread/loaded/list', 'thread/list',
  ]);
  assert.equal(socket().sent.some(message => message.method === 'initialized' && Object.hasOwn(message, 'id')), false);
  assert.deepEqual(threads.data.map(thread => thread.id), ['thread-1', 'thread-2']);
  assert.equal(threads.data[0].sessionId, 'session-1');
  assert.equal(threads.data[0].loaded, true);
  assert.deepEqual(threads.data[1].status, { type: 'idle' });
  assert.equal(JSON.stringify(threads).includes('secret'), false);
  assert.equal(JSON.stringify(threads).includes('hidden'), false);
  assert.deepEqual(loaded, { data: ['thread-1'], nextCursor: null });
  assert.deepEqual(notifications, ['item/commandExecution/requestApproval']);
  assert.equal(socket().sent.some(message => String(message.method).includes('Approval')), false);

  socket().emit('message', JSON.stringify({
    method: 'turn/completed', params: { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed', items: [] } },
  }));
  assert.equal(client.readState().threads.find(thread => thread.id === 'thread-2').status.type, 'completed');
  unsubscribe();
  client.close();
  assert.equal(socket().terminated, true);
});

test('transport and protocol failures become explicit unavailable errors', async () => {
  const failing = createCodexDaemon({
    command: 'codex',
    version: async () => ({ status: 'running', managedCodexPath: 'C:\\codex\\codex.exe', socketPath: 'C:\\codex\\control.sock' }),
    WebSocket: class extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit('error', new Error('refused')));
      }
    },
    createTransport: () => ({ stream: {}, close() {}, onClose() {} }),
  });
  await assert.rejects(failing.connect(), error => error.code === 'unavailable');

  const { daemon, socket } = fixtureDaemon();
  const client = await daemon.connect().then(() => daemon);
  const pending = client.listThreads({ cwd: 'E:\\projects\\winmux' });
  socket().emit('message', '{');
  await assert.rejects(pending, error => error.code === 'unavailable');
  client.close();
});

test('an explicit executable confirms the daemon is running before opening the proxy', async () => {
  const spawned = [];
  const transports = [];
  const version = {
    status: 'notRunning',
    managedCodexPath: 'C:\\codex\\codex.exe',
    socketPath: 'C:\\codex\\control.sock',
  };
  await assert.rejects(connectReadonly({
    command: 'C:\\codex\\codex.exe',
    spawnProcess(command, args) {
      spawned.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify(version));
        child.emit('exit', 0);
      });
      return child;
    },
    createTransport(target) {
      transports.push(target);
      return { stream: {}, close() {}, onClose() {} };
    },
    WebSocket: class {},
  }), error => error.code === 'unavailable');
  assert.deepEqual(spawned, [{ command: 'C:\\codex\\codex.exe', args: ['app-server', 'daemon', 'version'] }]);
  assert.equal(transports.length, 0);
});

test('a batch shim resolves the managed executable without spawning the proxy directly', async () => {
  const calls = [];
  const version = {
    status: 'running',
    managedCodexPath: 'C:\\codex\\bin\\codex.exe',
    socketPath: 'C:\\codex\\app-server-control.sock',
  };
  const client = await connectReadonly({
    command: 'C:\\npm\\codex.cmd',
    version: async () => version,
    WebSocket: class {
      constructor(_url, options) {
        const socket = new FakeSocket();
        options.createConnection();
        queueMicrotask(() => socket.emit('open'));
        return socket;
      }
    },
    createTransport(target) {
      calls.push(target);
      return { stream: {}, close() {}, onClose() {} };
    },
  });
  assert.equal(calls[0].command, version.managedCodexPath);
  assert.equal(calls[0].socketPath, version.socketPath);
  assert.deepEqual(parseDaemonVersion('noise\n' + JSON.stringify(version) + '\n'), version);
  assert.throws(() => parseDaemonVersion({ status: 'stopped', managedCodexPath: version.managedCodexPath }), error => error.code === 'unavailable');
  client.close();
});

test('R1-03 production refresh enumerates both thread pages and loaded pages', async t => {
  const { daemon, socket } = fixtureDaemon(twoPageResponse);
  t.after(() => daemon.dispose());
  const result = await daemon.refresh({ cwd: [fixtureCwd], limit: 100 });
  assert.equal(result.complete, true);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.threads.map(thread => thread.id), ['root-a', 'root-b']);
  assert.deepEqual(result.loadedThreadIds, ['root-a', 'root-b']);
  assert.equal(result.threads.every(thread => thread.loaded), true);
  const reads = socket().sent.filter(message => message.method !== 'initialize' && message.method !== 'initialized');
  assert.deepEqual(reads.map(message => [message.method, message.params.cursor || null]), [
    ['thread/list', null], ['thread/list', 'threads-page-2'],
    ['thread/loaded/list', null], ['thread/loaded/list', 'loaded-page-2'],
  ]);
  for (const message of reads) {
    assert.equal(message.params.limit, 100);
    if (message.method === 'thread/list') {
      assert.deepEqual(message.params.cwd, [fixtureCwd]);
      assert.equal(message.params.useStateDbOnly, true);
    }
  }
});

test('R1-02/03 production controller preserves later-page root ambiguity after a foreign hook', async t => {
  const { controller, panes } = nativeController(t, twoPageResponse);
  await controller.refresh();
  assert.equal(controller.status().connection, 'connected');
  assert.equal(controller.status().panes[0].action, 'ambiguous');
  assert.deepEqual(controller.status().panes[0].candidates, ['root-a', 'root-b']);
  assert.equal(panes[0].agentThreadId, undefined);
  const foreign = await controller.hook({ agentId: 'codex', event: 'Stop', sessionId: 'session-root-b', cwd: fixtureCwd });
  assert.equal(foreign.applied, false);
  assert.equal(panes[0].agentThreadId, undefined);
  assert.equal(panes[0].agentState, 'unknown');
  assert.equal((await controller.bind('pane', 'root-a')).ok, true);
  assert.equal((await controller.hook({ agentId: 'codex', event: 'Stop', sessionId: 'session-root-b', cwd: fixtureCwd })).applied, false);
  assert.equal((await controller.hook({ agentId: 'codex', event: 'Stop', sessionId: 'session-root-a', cwd: fixtureCwd })).applied, true);
  assert.equal(panes[0].agentThreadId, 'root-a');
  assert.equal(panes[0].agentState, 'completed');
});

for (const method of ['thread/list', 'thread/loaded/list']) {
  for (const failure of ['incomplete', 'cyclic', 'invalid-cursor', 'invalid-data']) {
    test(`R1-03 production ${method} ${failure} enumeration fails closed`, async t => {
      let pages = 0;
      const { controller, daemon, socket, panes } = nativeController(t, message => {
        if (message.method === method) {
          pages += 1;
          const data = method === 'thread/list' ? [rootThread('root-a')] : ['root-a'];
          if (failure === 'invalid-data') return { data: null, nextCursor: null };
          const nextCursor = failure === 'incomplete' ? `page-${pages}` : failure === 'cyclic' ? 'repeated-page' : { page: 2 };
          return { data, nextCursor };
        }
        if (message.method === 'thread/list') return { data: [rootThread('root-a')], nextCursor: null };
        if (message.method === 'thread/loaded/list') return { data: ['root-a'], nextCursor: null };
      });
      await controller.refresh();
      assert.equal(pages, failure === 'incomplete' ? 5 : failure === 'cyclic' ? 2 : 1);
      assert.equal(controller.status().connection, 'disconnected');
      assert.deepEqual(controller.status().threads, []);
      assert.equal(panes[0].agentThreadId, undefined);
      assert.equal(panes[0].agentState, 'unknown');
      assert.deepEqual(daemon.readState().loadedThreadIds, []);
      assert.equal(socket().sent.every(message => ['initialize', 'initialized', 'thread/list', 'thread/loaded/list'].includes(message.method)), true);
    });
  }
}

for (const panes of [[], [{ id: 'no-cwd', pid: 100, status: 'running', cwd: '', agentState: 'unknown' }]]) {
  test(`R1-08 native close is disconnected with ${panes.length ? 'no usable cwd' : 'no panes'}`, async t => {
    const { controller, socket } = nativeController(t, twoPageResponse, panes);
    await controller.refresh();
    assert.equal(controller.status().connection, 'connected');
    assert.equal(socket().sent.some(message => message.method.startsWith('thread/')), false);
    socket().terminate();
    assert.equal(controller.status().connection, 'disconnected');
    assert.deepEqual(controller.status().threads, []);
    assert.deepEqual(controller.status().panes, []);
    await controller.refresh();
    assert.equal(controller.status().connection, 'disconnected');
    assert.equal(socket().sent.some(message => message.method.startsWith('thread/')), false);
  });
}
