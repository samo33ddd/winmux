'use strict';
// winmux-omp-hook
// Receives one bounded lifecycle record from the project extension and sends it
// to Winmux. The capability token is read at runtime and never embedded.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_STDIN = 16 * 1024;
const MAX_FRAME = 16 * 1024;
const EVENTS = new Set([
  'session_start', 'session_switch', 'session_shutdown',
  'agent_start', 'agent_end',
  'tool_execution_start', 'tool_execution_end',
  'tool_approval_requested', 'tool_approval_resolved',
]);
const STATES = new Set(['idle', 'running', 'waiting', 'completed', 'failed']);

function fail(message, code = 'HOOK_INVALID') {
  throw Object.assign(new Error(message), { code });
}

function bounded(value, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) return undefined;
  return value;
}

function eventPayload(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('OMP hook input is not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('OMP hook input is not an object');
  const event = bounded(parsed.event, 64);
  const sessionId = bounded(parsed.sessionId, 128);
  const cwd = bounded(parsed.cwd, 4096);
  const state = bounded(parsed.state, 16);
  const paneId = bounded(parsed.paneId, 128, true);
  const stamp = bounded(parsed.stamp, 30);
  const emittedAt = parsed.emittedAt;
  const toolName = bounded(parsed.toolName, 128, true);
  const toolId = bounded(parsed.toolId, 256, true);
  const phase = bounded(parsed.phase, 5, true);
  const isToolEvent = event === 'tool_execution_start' || event === 'tool_execution_end';
  if (parsed.agentId !== 'omp' || !EVENTS.has(event) || !sessionId || !cwd || !STATES.has(state)
    || (parsed.paneId !== undefined && paneId === undefined)
    || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || !/^\d+$/.test(stamp || '')
    || (emittedAt !== undefined && (!Number.isSafeInteger(emittedAt) || emittedAt <= 0))
    || (isToolEvent && (!toolName || !toolId || !['start', 'end'].includes(phase)
      || phase !== (event === 'tool_execution_start' ? 'start' : 'end')))) {
    fail('OMP hook input is missing a supported lifecycle field');
  }
  return {
    agentId: 'omp',
    ...(emittedAt !== undefined ? { emittedAt } : {}),
    event,
    sessionId,
    cwd,
    ...(paneId ? { paneId } : {}),
    pid: parsed.pid,
    stamp,
    state,
    ...(isToolEvent ? { toolName, toolId, phase } : {}),
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_STDIN) {
        reject(Object.assign(new Error('OMP hook input exceeds 16 KiB'), { code: 'HOOK_TOO_LARGE' }));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function tokenFor(dataDir) {
  const file = path.join(dataDir, 'ipc-token');
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); }
  catch (cause) { throw Object.assign(new Error('Winmux capability token is unavailable'), { code: cause.code || 'ENOAUTH', cause }); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw Object.assign(new Error('Winmux capability token is invalid'), { code: 'ENOAUTH' });
  return token;
}

function pipeName(dataDir, explicit) {
  if (explicit) {
    if (explicit.length > 260 || explicit.includes('\0')) fail('Winmux pipe name is invalid');
    return explicit;
  }
  const identity = `${os.userInfo().username}:${os.homedir()}:${path.resolve(dataDir).toLowerCase()}`;
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\winmux-${suffix}`
    : path.join(os.tmpdir(), `winmux-${suffix}.sock`);
}

function deliver(pipe, token, params) {
  const id = crypto.randomUUID();
  const frame = JSON.stringify({
    id,
    token,
    method: 'agent.hook',
    params,
  }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME) fail('Winmux hook frame is too large');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = '', done = false;
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Winmux hook delivery timed out'), { code: 'ETIMEDOUT' })), 1200);
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.on('error', finish);
    socket.on('close', () => { if (!done) finish(new Error('Winmux hook connection closed')); });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return finish(Object.assign(new Error('Winmux hook response is too large'), { code: 'HOOK_TOO_LARGE' }));
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { return finish(Object.assign(new Error('Winmux hook response is invalid'), { code: 'HOOK_INVALID' })); }
        if (message.id !== id) continue;
        return finish(message.error ? Object.assign(new Error('Winmux rejected the hook'), { code: message.error.code || 'HOOK_REJECTED' }) : undefined);
      }
    });
    socket.write(frame);
  });
}

async function main(argv = process.argv) {
  const dataIndex = argv.indexOf('--data-dir');
  const selected = dataIndex === -1 ? undefined : argv[dataIndex + 1];
  if (!selected || selected.includes('\0') || selected.length > 1024) fail('OMP hook requires --data-dir');
  const pipeIndex = argv.indexOf('--pipe');
  const pipe = pipeIndex === -1 ? undefined : argv[pipeIndex + 1];
  const params = eventPayload(await readStdin());
  await deliver(pipeName(selected, pipe), tokenFor(selected), params);
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = { eventPayload, main };
