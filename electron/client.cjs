'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { LIMITS, locations, readToken } = require('./backend/shared.cjs');

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
  let buffer = '', closed = false;
  const pending = new Map();
  function rejectPending(error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  socket.on('error', error => { rejectPending(error); client.emit('error', error); });
  socket.on('close', () => {
    closed = true;
    rejectPending(Object.assign(new Error('Winmux daemon connection closed'), { code: 'CONNECTION_CLOSED' }));
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
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else entry.resolve(message.result);
    }
    if (Buffer.byteLength(buffer) > LIMITS.response) socket.destroy(new Error('Winmux response exceeds the frame limit'));
  });
  client.request = (method, params = {}) => {
    if (closed || socket.destroyed) return Promise.reject(Object.assign(new Error('Winmux daemon connection closed'), { code: 'CONNECTION_CLOSED' }));
    if (pending.size >= LIMITS.inflight) return Promise.reject(Object.assign(new Error('Too many pending Winmux requests'), { code: 'LIMIT_REACHED' }));
    let frame; const id = randomUUID();
    try { frame = JSON.stringify({ id, token, method, params }) + '\n'; }
    catch (error) { return Promise.reject(error); }
    if (Buffer.byteLength(frame) > LIMITS.request || socket.writableLength + Buffer.byteLength(frame) > LIMITS.socket) return Promise.reject(Object.assign(new Error('Winmux request exceeds the buffer limit'), { code: 'LIMIT_REACHED' }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`Winmux request timed out: ${method}`), { code: 'ETIMEDOUT' })); }, options.requestTimeout ?? 20000);
      pending.set(id, { resolve, reject, timer }); socket.write(frame);
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
module.exports = { connect };
