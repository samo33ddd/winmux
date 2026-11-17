'use strict';
// winmux-codex-hook
// Project-local Codex hook. Reads the capability token at runtime; nothing secret is embedded.
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');

const MAX_STDIN = 64 * 1024;
const MAX_FRAME = 16 * 1024;
const EVENTS = new Set([
  'SessionStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit',
  'PreModelRequest', 'PostModelRequest', 'Stop', 'Interrupt', 'SessionEnd',
]);

function fail(message) {
  const error = new Error(message);
  error.code = 'HOOK_INVALID';
  throw error;
}

function bounded(value, max) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) return undefined;
  return value;
}

function eventPayload(raw, options = {}) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail('Codex hook input is not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Codex hook input is not an object');
  const event = bounded(parsed.hook_event_name, 64);
  const sessionId = bounded(parsed.session_id, 128);
  const cwd = parsed.cwd === undefined || parsed.cwd === null ? '' : bounded(parsed.cwd, 4096);
  const paneId = options.paneId === undefined ? undefined : bounded(options.paneId, 128);
  if (options.paneId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(paneId || '')) fail('Codex hook pane identity is invalid');
  if (!event || !EVENTS.has(event) || !sessionId || cwd === undefined) fail('Codex hook input is missing a supported event');
  return {
    agentId: 'codex',
    event,
    sessionId,
    cwd,
    ...(paneId ? { paneId } : {}),
    ...((parsed.hook_event_name === 'PreToolUse' || parsed.hook_event_name === 'PostToolUse') && bounded(parsed.tool_name, 256) && bounded(parsed.tool_use_id, 256) ? {
      ...(bounded(parsed.tool_name, 256) ? { toolName: bounded(parsed.tool_name, 256) } : {}),
      ...(bounded(parsed.tool_use_id, 256) ? { toolId: bounded(parsed.tool_use_id, 256) } : {}),
      phase: parsed.hook_event_name === 'PreToolUse' ? 'start' : 'end',
    } : {}),
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_STDIN) {
        reject(Object.assign(new Error('Codex hook input exceeds 64 KiB'), { code: 'HOOK_TOO_LARGE' }));
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
  const file = require('node:path').join(dataDir, 'ipc-token');
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
  const resolved = require('node:path').resolve(dataDir);
  const identity = `${require('node:os').userInfo().username}:${require('node:os').homedir()}:${resolved.toLowerCase()}`;
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  // The Unix fallback socket lives in the user-private data directory:
  // a predictable name under os.tmpdir() can be pre-bound to steal the token.
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\winmux-${suffix}`
    : require('node:path').join(resolved, `winmux-${suffix}.sock`);
}

function deliver(pipe, token, params) {
  const frame = JSON.stringify({ id: randomUUID(), token, method: 'agent.hook', v: 1, params }) + '\n';
  if (Buffer.byteLength(frame) > MAX_FRAME) fail('Winmux hook frame is too large');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let buffer = '';
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Winmux hook delivery timed out'), { code: 'ETIMEDOUT' })), 4000);
    const finish = error => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); };
    socket.on('error', finish);
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index === -1) {
        if (Buffer.byteLength(buffer) > MAX_FRAME) finish(Object.assign(new Error('Winmux hook response is too large'), { code: 'HOOK_TOO_LARGE' }));
        return;
      }
      let message;
      try { message = JSON.parse(buffer.slice(0, index)); }
      catch { finish(Object.assign(new Error('Winmux hook response is invalid'), { code: 'HOOK_INVALID' })); return; }
      if (message.error) finish(Object.assign(new Error(message.error.message || 'Winmux rejected the hook'), { code: message.error.code || 'HOOK_REJECTED' }));
      else finish();
    });
    socket.write(frame);
  });
}

async function main(argv = process.argv) {
  const dataIndex = argv.indexOf('--data-dir');
  const selected = dataIndex === -1 ? undefined : argv[dataIndex + 1];
  if (!selected || selected.includes('\0') || selected.length > 1024) fail('Codex hook requires --data-dir');
  const pipeIndex = argv.indexOf('--pipe');
  const pipe = pipeIndex === -1 ? undefined : argv[pipeIndex + 1];
  const paneIndex = argv.indexOf('--pane-id');
  const paneId = paneIndex === -1 ? undefined : argv[paneIndex + 1];
  const raw = await readStdin();
  const params = eventPayload(raw, { paneId });
  await deliver(pipeName(selected, pipe), tokenFor(selected), params);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { eventPayload, main };
