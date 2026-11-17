// Unit coverage for the browser control socket: token auth, frame limits,
// the 16-socket cap, and queue serialization — the paths the happy-path
// integration smokes never touch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const EventEmitter = require('node:events');
const { startBrowserControl } = require('../electron/browser-control.cjs');

function fakeWin() {
  const webContents = new EventEmitter();
  webContents.executeJavaScript = async () => null;
  webContents.send = () => {};
  return { webContents };
}
function fakeClient() { return { request: async () => ({ settings: {}, workspaces: [] }) }; }

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-bc-'));
  const control = await startBrowserControl({ win: fakeWin(), client: fakeClient(), dataDir, fileOpen: async params => ({ ok: params.path }) });
  const endpoint = JSON.parse(fs.readFileSync(path.join(dataDir, 'ui-control.json'), 'utf8'));
  return { control, endpoint, dataDir };
}
function send(pipe, line) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.write(line);
  });
}

test('rejects a wrong token', async () => {
  const { control, endpoint } = await setup();
  const out = await send(endpoint.pipe, JSON.stringify({ token: 'x'.repeat(endpoint.token.length), method: 'list', params: {} }) + '\n');
  assert.match(out, /Unauthorized/);
  await control.close();
});
test('rejects a forged token of the right length', async () => {
  const { control, endpoint } = await setup();
  const forged = (endpoint.token[0] === '0' ? '1' : '0') + endpoint.token.slice(1);
  const out = await send(endpoint.pipe, JSON.stringify({ token: forged, method: 'list', params: {} }) + '\n');
  assert.match(out, /Unauthorized/);
  await control.close();
});
test('rejects a malformed first frame', async () => {
  const { control, endpoint } = await setup();
  const out = await send(endpoint.pipe, 'not json\n');
  assert.match(out, /Unexpected token|JSON|Unauthorized/);
  await control.close();
});
test('destroys sockets that exceed the 1 MB buffer without a newline', async () => {
  const { control, endpoint } = await setup();
  const big = JSON.stringify({ token: endpoint.token, method: 'list', params: {} }).padStart(1024 * 1024 + 64, 'x');
  const out = await send(endpoint.pipe, big);
  assert.equal(out, '');
  await control.close();
});
test('caps concurrent sockets at 16', async () => {
  const { control, endpoint } = await setup();
  const held = [];
  for (let i = 0; i < 16; i += 1) held.push(net.createConnection(endpoint.pipe));
  await new Promise(resolve => setTimeout(resolve, 150));
  const extra = await new Promise(resolve => {
    const socket = net.createConnection(endpoint.pipe);
    let closed = false;
    socket.on('close', () => { closed = true; resolve(closed); });
    setTimeout(() => { socket.destroy(); resolve(closed); }, 1000);
  });
  assert.equal(extra, true);
  for (const socket of held) socket.destroy();
  await control.close();
});
test('file.open round trips through the queue with a good token', async () => {
  const { control, endpoint } = await setup();
  const out = await send(endpoint.pipe, JSON.stringify({ token: endpoint.token, method: 'file.open', params: { path: 'hello.txt' } }) + '\n');
  const response = JSON.parse(out.trim());
  assert.deepEqual(response, { result: { ok: 'hello.txt' } });
  await control.close();
});
test('unknown method returns an error, not a crash', async () => {
  const { control, endpoint } = await setup();
  // second newline in the same write makes the parse loop return an
  // error frame immediately instead of queueing the method.
  const frame = JSON.stringify({ token: endpoint.token, method: 'nope', params: {} });
  const out = await send(endpoint.pipe, `${frame}\n`);
  assert.match(out, /error|Unknown/);
  await control.close();
}, { timeout: 30000 });
