'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { startRun, getRun, waitForRun } = require('../electron/automation-client.cjs');

const runId = '11111111-1111-1111-1111-111111111111';
const token = 'a'.repeat(64);
const screen = { text: 'terminal view', cols: 80, rows: 24 };
const view = (status, revision) => ({ runId, status, revision });
const response = (run, includeScreen, screenError = null) => ({
  run, screen: includeScreen && !screenError ? screen : null, screenError,
});

async function fixture(t, steps, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-automation-client-'));
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\winmux-automation-client-${randomUUID()}` : path.join(dataDir, 'daemon.sock');
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), token);
  const sockets = new Set();
  const calls = [];
  const callSockets = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        const reply = result => socket.write(JSON.stringify({ id: request.id, result }) + '\n');
        if (request.token !== token) { socket.destroy(); continue; }
        if (request.method === options.holdMethod) { options.onHold(socket); continue; }
        if (request.method === 'state') { reply({}); continue; }
        if (request.method === 'environment') { reply(options.environment ?? { capabilities: { automationRuns: true } }); continue; }
        calls.push(request);
        callSockets.push(socket);
        const step = steps.shift();
        if (request.method !== 'task.run.get' || !step || Boolean(request.params.includeScreen) !== step.includeScreen) {
          socket.write(JSON.stringify({ id: request.id, error: { code: 'UNEXPECTED_REQUEST', message: 'Unexpected fixture request' } }) + '\n');
        } else if (step.disconnect) {
          socket.destroy();
        } else if (step.hold) {
          step.hold();
        } else if (step.delay) {
          setTimeout(() => { if (!socket.destroyed) reply(response(step.run, step.includeScreen, step.screenError)); }, step.delay);
        } else {
          reply(response(step.run, step.includeScreen, step.screenError));
        }
      }
    });
  });
  server.listen(pipeName);
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { connection: { dataDir, pipeName }, calls, callSockets };
}

for (const [name, invoke] of [
  ['startRun', connection => startRun(connection, { runId })],
  ['getRun', connection => getRun(connection, runId)],
  ['waitForRun', connection => waitForRun(connection, runId, { timeoutMs: 1000 })],
]) {
  test(`${name} rejects an older daemon without issuing a task RPC`, async t => {
    const f = await fixture(t, [], { environment: { capabilities: {} } });
    await assert.rejects(invoke(f.connection), { code: 'AUTOMATION_UNAVAILABLE' });
    assert.deepEqual(f.calls, []);
  });
}

for (const method of ['state', 'environment']) {
  test(`abort closes the connection while ${method} is pending`, { timeout: 2000 }, async t => {
    let onHold;
    const held = new Promise(resolve => { onHold = resolve; });
    const f = await fixture(t, [], { holdMethod: method, onHold });
    const controller = new AbortController();
    const pending = waitForRun(f.connection, runId, { signal: controller.signal });
    const socket = await held;
    const closed = once(socket, 'close');
    controller.abort();
    await assert.rejects(pending, { code: 'ABORT_ERR' });
    await closed;
  });
}

test('a completion seen by the screen read replaces a stale waiting reason', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('waiting', 2) },
    { includeScreen: true, run: view('completed', 3) },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 1000 }), {
    reason: 'completed', ...response(view('completed', 3), true),
  });
});

test('a resumed run keeps polling until completion within the original deadline', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('waiting', 2) },
    { includeScreen: true, run: view('running', 3) },
    { includeScreen: false, run: view('completed', 4) },
    { includeScreen: true, run: view('completed', 4) },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 3000 }), {
    reason: 'completed', ...response(view('completed', 4), true),
  });
  assert.deepEqual(f.calls.map(call => Boolean(call.params.includeScreen)), [false, true, false, true]);
});

test('a stalled metadata poll cannot extend the deadline before the final capture', { timeout: 3000 }, async t => {
  let closed;
  const f = await fixture(t, [
    { includeScreen: false, hold: () => { closed = once(f.callSockets[0], 'close'); } },
    { includeScreen: true, run: view('running', 3) },
  ]);
  const started = Date.now();
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 120 }), {
    reason: 'timeout', ...response(view('running', 3), true),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 90 && elapsed < 2000, `deadline took ${elapsed}ms`);
  assert.deepEqual(f.calls.map(call => Boolean(call.params.includeScreen)), [false, true]);
  assert.equal(f.callSockets[0], f.callSockets[1]);
  await closed;
});

test('a cancelled metadata poll cannot time out the final capture', { timeout: 4000 }, async t => {
  const f = await fixture(t, [
    { includeScreen: false, hold: () => {} },
    { includeScreen: true, delay: 600, run: view('completed', 4) },
  ]);
  assert.deepEqual(await waitForRun({ ...f.connection, requestTimeout: 800 }, runId, { timeoutMs: 300 }), {
    reason: 'completed', ...response(view('completed', 4), true),
  });
  assert.deepEqual(f.calls.map(call => Boolean(call.params.includeScreen)), [false, true]);
  assert.equal(f.callSockets[0], f.callSockets[1]);
});

test('abort closes a connection with a stalled metadata poll', { timeout: 3000 }, async t => {
  const controller = new AbortController();
  let closed;
  const f = await fixture(t, [
    { includeScreen: false, hold: () => {
      closed = once(f.callSockets[0], 'close');
      controller.abort();
    } },
  ]);
  await assert.rejects(waitForRun(f.connection, runId, { timeoutMs: 1000, signal: controller.signal }), { code: 'ABORT_ERR' });
  await closed;
  assert.equal(f.calls.length, 1);
});

test('invalid wait boundaries are rejected before connecting', async () => {
  for (const timeoutMs of [-1, 0.5, 86400001, Infinity, NaN, '1']) {
    await assert.rejects(waitForRun({}, runId, { timeoutMs }), { code: 'INVALID_ARGUMENT' });
  }
  for (const afterRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1']) {
    await assert.rejects(waitForRun({}, runId, { afterRevision }), { code: 'INVALID_ARGUMENT' });
  }
});

test('a completion seen during the timeout capture takes precedence over timeout', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('running', 1) },
    { includeScreen: true, run: view('completed', 2) },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 0 }), {
    reason: 'completed', ...response(view('completed', 2), true),
  });
});

test('a qualifying wait seen during the timeout capture takes precedence over timeout', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('running', 1) },
    { includeScreen: true, run: view('waiting', 2) },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 0, afterRevision: 1 }), {
    reason: 'waiting', ...response(view('waiting', 2), true),
  });
});

test('a resumed run returns timeout after its deadline, not the old waiting state', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('waiting', 2) },
    { includeScreen: true, run: view('running', 3) },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 0 }), {
    reason: 'timeout', ...response(view('running', 3), true),
  });
});

test('a previously observed waiting revision does not satisfy a timeout capture', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('running', 1) },
    { includeScreen: true, run: view('waiting', 2) },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 0, afterRevision: 2 }), {
    reason: 'timeout', ...response(view('waiting', 2), true),
  });
});

test('a normal waiting state returns its latest screen and revision', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('waiting', 2) },
    { includeScreen: true, run: view('waiting', 2) },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 1000, afterRevision: 1 }), {
    reason: 'waiting', ...response(view('waiting', 2), true),
  });
});

test('a daemon-reported screen error preserves the latest run outcome', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('waiting', 2) },
    { includeScreen: true, run: view('failed', 3), screenError: 'PANE_CLOSED' },
  ]);
  assert.deepEqual(await waitForRun(f.connection, runId, { timeoutMs: 1000 }), {
    reason: 'failed', ...response(view('failed', 3), true, 'PANE_CLOSED'),
  });
});

test('a disconnected transport during screen capture rejects the wait', async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('waiting', 2) },
    { includeScreen: true, disconnect: true },
  ]);
  await assert.rejects(waitForRun(f.connection, runId, { timeoutMs: 1000 }), { code: 'CONNECTION_CLOSED' });
});

test('a disconnected pending wait can recover the same run on a fresh connection', { timeout: 3000 }, async t => {
  const f = await fixture(t, [
    { includeScreen: false, run: view('running', 1) },
    { includeScreen: false, disconnect: true },
    { includeScreen: false, run: view('completed', 2) },
  ]);
  await assert.rejects(waitForRun(f.connection, runId, { timeoutMs: 2000 }), { code: 'CONNECTION_CLOSED' });
  assert.deepEqual(await getRun(f.connection, runId), response(view('completed', 2), false));
  assert.deepEqual(f.calls.map(call => [call.method, call.params.runId]), [
    ['task.run.get', runId], ['task.run.get', runId], ['task.run.get', runId],
  ]);
  assert.equal(f.callSockets[0], f.callSockets[1]);
  assert.notEqual(f.callSockets[1], f.callSockets[2]);
});

test('an abort during screen capture rejects with ABORT_ERR', async t => {
  const controller = new AbortController();
  const f = await fixture(t, [
    { includeScreen: false, run: view('waiting', 2) },
    { includeScreen: true, hold: () => controller.abort() },
  ]);
  await assert.rejects(waitForRun(f.connection, runId, { timeoutMs: 1000, signal: controller.signal }), { code: 'ABORT_ERR' });
});
