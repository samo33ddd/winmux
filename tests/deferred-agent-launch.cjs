'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.artifacts'), { recursive: true });
const dataDir = fs.mkdtempSync(path.join(root, '.artifacts', 'deferred-launch-'));
const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\winmux-deferred-${randomUUID()}` : path.join(dataDir, 'daemon.sock');
const token = 'b'.repeat(64);
fs.writeFileSync(path.join(dataDir, 'ipc-token'), token);
const pane = { id: 'pane', title: 'PowerShell', profileId: 'powershell', cwd: dataDir, pid: 1, status: 'running', cols: 80, rows: 24, tabId: 'tab', shellReady: true };
const leaf = { type: 'leaf', paneId: pane.id };
const state = { workspaces: [{ id: 'workspace', name: 'Launch fixture', cwd: dataDir, profileId: 'powershell', root: leaf, panes: [pane], tabs: [{ id: 'tab', title: 'Terminal', root: leaf }], activeTabId: 'tab' }], notifications: [], settings: { theme: 'dark', fontSize: 14, activeWorkspaceId: 'workspace' } };
const environment = {
  platform: process.platform, defaultCwd: dataDir,
  profiles: [{ id: 'powershell', label: 'PowerShell', environment: 'windows', command: 'pwsh.exe', args: [], cwd: dataDir }, { id: 'wsl:Stopped', label: 'Stopped', environment: 'wsl', command: 'wsl.exe', args: ['--distribution', 'Stopped'], distro: 'Stopped', running: false }],
  agents: [{ id: 'wsl:Stopped:codex', label: 'Codex', profileId: 'wsl:Stopped', environment: 'wsl', distro: 'Stopped', available: null, command: null }],
  capabilities: { terminalTabs: true, agentLaunch: true },
};
const calls = [], sockets = new Set();
let desktop;
// Fake only the daemon boundary. Real Electron preload, IPC routing, client and
// renderer handlers run unchanged; no WSL executable or signed-in agent runs.
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  socket.setEncoding('utf8'); let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      assert.equal(request.token, token);
      calls.push(request);
      let result = { ok: true }, error;
      if (request.method === 'state') result = state;
      else if (request.method === 'environment') result = environment;
      else if (request.method === 'pane.snapshot') result = { data: '', seq: 0, cols: 80, rows: 24 };
      else if (['tab.create', 'workspace.create'].includes(request.method)) error = { code: 'AGENT_UNAVAILABLE', message: 'Launch intercepted by isolated test daemon' };
      socket.write(JSON.stringify({ id: request.id, result, error }) + '\n');
    }
  });
});

async function expectRequest(method) {
  const deadline = Date.now() + 2500;
  while (!calls.some(call => call.method === method) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
  const request = calls.find(call => call.method === method);
  assert.ok(request, `selecting an available:null agent must issue ${method}`);
  assert.equal(request.params.agentId, 'wsl:Stopped:codex');
  assert.equal(request.params.profileId, 'wsl:Stopped');
  assert.equal(request.params.cwd, '~');
}
async function run() {
  try {
    server.listen(pipeName); await once(server, 'listening');
    const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName, WINMUX_TEST_MODE: '1' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.WINMUX_DEV_URL;
    desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await desktop.firstWindow({ timeout: 30000 });
    await page.waitForSelector('.xterm');
    await page.getByTestId('launch-agent').selectOption('wsl:Stopped:codex');
    await expectRequest('tab.create');
    await page.getByTestId('new-workspace').click();
    await page.getByTestId('workspace-profile-select').selectOption('wsl:Stopped');
    await page.getByTestId('workspace-agent-select').selectOption('wsl:Stopped:codex');
    await page.getByTestId('create-workspace-submit').click();
    await expectRequest('workspace.create');
    assert.equal(calls.filter(call => call.method === 'tab.create').length, 1);
    assert.equal(calls.filter(call => call.method === 'workspace.create').length, 1);
    console.log('PASS real Electron nullable-agent selection sends tab/workspace launch requests without starting WSL.');
  } finally {
    if (desktop) await desktop.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
