'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { connect, requestTimeoutFor } = require('../electron/client.cjs');
const { LIMITS } = require('../electron/backend/shared.cjs');

test('run metadata keeps its bounded timeout before the general task prefix', () => {
  assert.equal(requestTimeoutFor('task.run.get'), 20000);
  assert.equal(requestTimeoutFor('task.run.start'), 120000);
  assert.equal(requestTimeoutFor('task.delivery.merge'), 300000);
});

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-pressure-'));
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\winmux-pressure-${randomUUID()}` : path.join(dataDir, 'daemon.sock');
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), 'a'.repeat(64));
  const sockets = new Set(), calls = [];
  let inflight = 0, peak = 0, handler = () => {};
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        assert.equal(request.token, 'a'.repeat(64));
        if (request.method === 'state') { socket.write(JSON.stringify({ id: request.id, result: {} }) + '\n'); continue; }
        calls.push(request); peak = Math.max(peak, ++inflight);
        handler(request, (result, error) => {
          inflight--;
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, result, error }) + '\n');
        });
      }
    });
  });
  server.listen(pipeName); await once(server, 'listening');
  let client;
  t.after(async () => {
    client?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  client = await connect({ dataDir, pipeName, requestTimeout: 1000, ...options });
  return { client, calls, peak: () => peak, handle: next => { handler = next; } };
}

test('80 terminal inputs retain order and Unicode bytes across delayed daemon responses', async t => {
  const f = await fixture(t);
  f.handle((request, reply) => setTimeout(() => reply({ received: request.params.data }), 15));
  const values = Array.from({ length: 80 }, (_, i) => `${i}:Привет 😀\r`);
  const results = await Promise.allSettled(values.map(data => f.client.request('pane.input', { paneId: 'p', data })));
  assert.equal(results.filter(item => item.status === 'rejected').length, 0, 'a legitimate input burst must not be discarded at request 33');
  assert.deepEqual(f.calls.map(request => request.params.data), values);
  assert.deepEqual(results.map(item => item.value.received), values);
  assert.ok(f.peak() <= LIMITS.inflight, 'server concurrency must remain bounded');
  assert.deepEqual(await f.client.request('state'), {});
});

test('queued requests are rejected on close and never sent after it', async t => {
  const f = await fixture(t);
  const requests = Array.from({ length: 80 }, () => f.client.request('pane.input', { paneId: 'p', data: 'x' }));
  const results = Promise.allSettled(requests);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.calls.length, LIMITS.inflight);
  f.client.close();
  const settled = await results;
  assert.ok(settled.every(item => item.status === 'rejected' && item.reason.code === 'CONNECTION_CLOSED'));
  assert.equal(f.calls.length, LIMITS.inflight, 'queued input must not replay after close');
});

test('cancelling requests preserves server capacity and keeps the socket open', { timeout: 4000 }, async t => {
  const f = await fixture(t, { requestTimeout: 3000 });
  const replies = new Map();
  let allActive, replacementReceived;
  const activeReceived = new Promise(resolve => { allActive = resolve; });
  const replacementSeen = new Promise(resolve => { replacementReceived = resolve; });
  f.handle((request, reply) => {
    replies.set(request.params.data, reply);
    if (replies.size === LIMITS.inflight) allActive();
    if (request.params.data === 'replacement') replacementReceived();
  });

  const activeController = new AbortController();
  const requests = Array.from({ length: LIMITS.inflight }, (_, i) =>
    f.client.request('probe', { data: `active-${i}` }, i === 0 ? activeController.signal : null));
  const settled = Promise.allSettled(requests);
  await activeReceived;
  const queuedController = new AbortController();
  const queued = f.client.request('probe', { data: 'cancelled-queue' }, queuedController.signal);
  const queuedRejected = assert.rejects(queued, { code: 'ABORT_ERR' });
  queuedController.abort();
  await queuedRejected;
  const replacement = f.client.request('probe', { data: 'replacement' });
  activeController.abort();
  const sentEarly = await Promise.race([replacementSeen.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))]);
  assert.equal(sentEarly, false, 'a sent cancellation retains its server-side inflight slot until the late reply');
  replies.get('active-0')({ late: true });
  await replacementSeen;
  replies.get('replacement')({ ok: true });
  assert.deepEqual(await replacement, { ok: true });
  for (let i = 1; i < LIMITS.inflight; i++) replies.get(`active-${i}`)({ ok: true });
  const results = await settled;
  assert.equal(results[0].reason.code, 'ABORT_ERR');
  assert.ok(results.slice(1).every(result => result.status === 'fulfilled'));
  assert.ok(!f.calls.some(request => request.params.data === 'cancelled-queue'));
  assert.deepEqual(await f.client.request('state'), {});
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(f.client.request('probe', {}, alreadyAborted.signal), { code: 'ABORT_ERR' });
});

test('an unanswered active request fails the connection without sending queued input', async t => {
  const f = await fixture(t, { requestTimeout: 90 });
  const results = await Promise.allSettled(Array.from({ length: 80 }, () => f.client.request('pane.input', { paneId: 'p', data: 'x' })));
  assert.ok(results.every(item => item.status === 'rejected' && item.reason.code === 'ETIMEDOUT'));
  assert.equal(f.calls.length, LIMITS.inflight);
  await assert.rejects(f.client.request('state'), { code: 'CONNECTION_CLOSED' });
});

test('waiting count and byte limits reject overload without writing excess requests', async t => {
  const f = await fixture(t);
  const waiting = [];
  for (let i = 0; i < LIMITS.inflight * 5; i++) waiting.push(f.client.request('pane.input', { paneId: 'p', data: 'x' }));
  const settled = Promise.allSettled(waiting);
  await assert.rejects(f.client.request('pane.input', { paneId: 'p', data: 'excess' }), { code: 'LIMIT_REACHED' });
  f.client.close(); await settled;
  assert.ok(f.peak() <= LIMITS.inflight);

  const g = await fixture(t);
  const bytes = [];
  // Each frame is legal on its own, but a waiting queue must have a byte bound too.
  for (let i = 0; i < LIMITS.inflight + 20; i++) bytes.push(g.client.request('probe', { data: 'x'.repeat(240 * 1024) }));
  const byteResults = Promise.allSettled(bytes);
  await assert.rejects(g.client.request('probe', { data: 'x'.repeat(240 * 1024) }), { code: 'LIMIT_REACHED' });
  g.client.close(); await byteResults;
});

test('daemon errors release a slot and queued work still completes', async t => {
  const f = await fixture(t);
  f.handle((request, reply) => setTimeout(() => request.params.fail ? reply(undefined, { code: 'INVALID_ARGUMENT', message: 'Fixture error' }) : reply({ ok: true }), 5));
  const results = await Promise.allSettled(Array.from({ length: 48 }, (_, i) => f.client.request('probe', { fail: i === 0 })));
  assert.equal(results[0].reason.code, 'INVALID_ARGUMENT');
  assert.ok(results.slice(1).every(item => item.status === 'fulfilled'));
  assert.equal(f.calls.length, 48);
});
