'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = Object.freeze({ request: 256 * 1024, response: 8 * 1024 * 1024, socket: 12 * 1024 * 1024,
  input: 64 * 1024, chunk: 16 * 1024, pending: 4 * 1024 * 1024, clients: 32, inflight: 32,
  panes: 64, notifications: 200, scrollback: 1000 });
function locations(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.WINMUX_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Winmux'));
  const identity = `${os.userInfo().username}:${os.homedir()}:${dataDir.toLowerCase()}`;
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const pipeName = options.pipeName || process.env.WINMUX_PIPE_NAME || (process.platform === 'win32'
    ? `\\\\.\\pipe\\winmux-${suffix}` : path.join(os.tmpdir(), `winmux-${suffix}.sock`));
  return { dataDir, pipeName, tokenFile: path.join(dataDir, 'ipc-token'), stateFile: path.join(dataDir, 'state.json'), lockFile: path.join(dataDir, 'daemon.lock') };
}
function readToken(tokenFile) {
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Invalid Winmux capability token: ${tokenFile}`);
  return token;
}
function createToken(tokenFile) {
  try { fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readToken(tokenFile);
}
function authenticated(value, token) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function string(value, name, max = 512, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || value.includes('\0')) fail('INVALID_ARGUMENT', `${name} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters`);
  return value;
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}`);
  return value;
}
module.exports = { LIMITS, locations, readToken, createToken, authenticated, fail, string, integer };
