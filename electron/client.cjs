'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { LIMITS, locations, readToken } = require('./backend/shared.cjs');

// A run read is a bounded screen capture over an already-authenticated socket;
// it must never wait behind a long task mutation.
function requestTimeoutFor(method) {
  return method === 'task.run.get' ? 20000 : method.startsWith('task.delivery.') ? 300000 : method.startsWith('task.') || method === 'project.inspect' ? 120000 : 20000;
}

async function connect(options = {}) {
  const loc = locations(options);
  let token;
  try { token = readToken(loc.tokenFile); }
  catch (cause) { throw Object.assign(new Error(`Cannot read Winmux IPC token (${loc.tokenFile}); start Winmux first`, { cause }), { code: cause.code || 'ENOAUTH' }); }
  const client = new EventEmitter();
  // Consumers may subscribe to errors, but a dropped daemon must never become an
  // uncaught EventEmitter exception in Electron main or a CLI process.
  client.on('error', () => {});
  const socket = net.createConnection(loc.pipeName);
  socket.setEncoding('utf8');
  let buffer = '', closed = false, failed = false;
  const active = new Map();
  const waiting = [];
  let waitingBytes = 0;
  const maxWaiting = LIMITS.inflight * 4;
  function clearEntry(entry) { clearTimeout(entry.timer); }
  function failAll(error) {
    if (failed) return;
    failed = true; closed = true;
    for (const entry of active.values()) { clearEntry(entry); entry.reject(error); }
    active.clear();
    while (waiting.length) { const entry = waiting.shift(); waitingBytes -= entry.bytes; clearEntry(entry); entry.reject(error); }
    waitingBytes = 0;
  }
  function pump() {
    while (!failed && !closed && !socket.destroyed && active.size < LIMITS.inflight && waiting.length) {
      const entry = waiting[0];
      if (socket.writableLength + entry.bytes > LIMITS.socket) break;
      waiting.shift(); waitingBytes -= entry.bytes;
      active.set(entry.id, entry);
      socket.write(entry.frame);
    }
  }
  socket.on('drain', pump);
  socket.on('error', error => { failAll(error); client.emit('error', error); });
  socket.on('close', () => {
    closed = true;
    failAll(Object.assign(new Error('Winmux daemon connection closed'), { code: 'CONNECTION_CLOSED' }));
    client.emit('close');
  });
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > LIMITS.response) { socket.destroy(new Error('Winmux response exceeds the frame limit')); return; }
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(new Error('Invalid Winmux IPC response')); return; }
      if (message.event) { client.emit('event', message.event); continue; }
      const entry = active.get(message.id);
      if (!entry) continue;
      active.delete(message.id); clearEntry(entry);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else entry.resolve(message.result);
      pump();
    }
    if (Buffer.byteLength(buffer) > LIMITS.response) socket.destroy(new Error('Winmux response exceeds the frame limit'));
  });
  client.request = (method, params = {}) => {
    if (failed || closed || socket.destroyed) return Promise.reject(Object.assign(new Error('Winmux daemon connection closed'), { code: 'CONNECTION_CLOSED' }));
    if (waiting.length >= maxWaiting) return Promise.reject(Object.assign(new Error('Too many pending Winmux requests'), { code: 'LIMIT_REACHED' }));
    let frame; const id = randomUUID();
    try { frame = JSON.stringify({ id, token, method, params }) + '\n'; }
    catch (error) { return Promise.reject(error); }
    const bytes = Buffer.byteLength(frame);
    if (bytes > LIMITS.request || bytes > LIMITS.socket || waitingBytes + bytes > LIMITS.pending) return Promise.reject(Object.assign(new Error('Winmux request exceeds the buffer limit'), { code: 'LIMIT_REACHED' }));
    return new Promise((resolve, reject) => {
      const entry = { id, method, frame, bytes, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const timeout = Object.assign(new Error(`Winmux request timed out: ${entry.method}`), { code: 'ETIMEDOUT' });
        if (active.has(entry.id)) {
          socket.destroy(timeout);
          failAll(timeout);
          return;
        }
        const index = waiting.indexOf(entry);
        if (index !== -1) {
          waiting.splice(index, 1); waitingBytes -= entry.bytes; clearEntry(entry); entry.reject(timeout);
        }
      }, options.requestTimeout ?? requestTimeoutFor(method));
      waiting.push(entry); waitingBytes += bytes; pump();
    });
  };
  client.close = () => { closed = true; socket.destroy(); };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Winmux connect timed out'), { code: 'ETIMEDOUT' })), options.connectTimeout ?? 3000);
    const cleanup = () => { clearTimeout(timer); socket.removeListener('connect', onConnect); socket.removeListener('error', onError); };
    const onConnect = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    socket.once('connect', onConnect); socket.once('error', onError);
  });
  // Authenticate before resolving; events are never delivered to an unauthenticated socket.
  try { await client.request('state'); } catch (error) { client.close(); throw error; }
  return client;
}
module.exports = { connect, requestTimeoutFor };
