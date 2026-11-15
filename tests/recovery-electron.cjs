'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'recovery-desktop-'));
const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_NO_PROFILE: '1', WINMUX_TEST_MODE: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'WINMUX_PIPE_NAME', 'WINMUX_DEV_URL']) delete env[key];
let desktop, page;
const errors = [];

function runningWsl() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('wsl.exe', ['--list', '--running', '--quiet'], { encoding: 'buffer', windowsHide: true, timeout: 10000 });
  // Hosted Windows may have no usable WSL installation.
  if (result.status !== 0) return [];
  const output = result.stdout.includes(0) ? result.stdout.toString('utf16le') : result.stdout.toString('utf8');
  return output.replace(/^\uFEFF/, '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).sort();
}
function cli(command) {
  return spawnSync(require('electron'), [path.join(root, 'cli.cjs'), '--data-dir', dataDir, command], {
    cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 25000,
  });
}
function rpc(method, params = {}) {
  return page.evaluate(({ method, params }) => window.winmux.call(method, params), { method, params });
}

async function main() {
  const before = runningWsl();
  const started = cli('start');
  assert.equal(started.status, 0, started.stderr || started.error?.message || started.stdout);
  assert.equal(JSON.parse(started.stdout).alreadyRunning, undefined);
  desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow({ timeout: 30000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.winmux);
  const environment = await rpc('environment');
  assert.deepEqual(runningWsl(), before, 'Windows desktop startup must not start a stopped distribution');

  const workspace = await rpc('workspace.create', { name: 'Recovery fixture', profileId: 'powershell', cwd: dataDir });
  await rpc('settings.update', { activeWorkspaceId: workspace.id });
  const pane = workspace.panes[0];
  await page.waitForSelector('.xterm');
  await page.waitForFunction(async paneId => {
    const state = await window.winmux.call('state');
    return state.workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneId)?.shellReady;
  }, pane.id);

  const deferred = environment.agents.filter(agent => agent.available === null);
  for (const agent of deferred) {
    assert.equal(agent.environment, 'wsl');
    const option = page.getByTestId('launch-agent').locator(`option[value="${agent.id}"]`);
    assert.equal(await option.isEnabled(), true);
    assert.match(await option.textContent(), /check on launch/);
  }
  // Verify the second selector without selecting or starting a WSL profile.
  if (deferred.length) {
    await page.getByTestId('new-workspace').click();
    await page.getByTestId('workspace-profile-select').selectOption(deferred[0].profileId);
    const option = page.getByTestId('workspace-agent-select').locator(`option[value="${deferred[0].id}"]`);
    assert.equal(await option.isEnabled(), true);
    assert.match(await option.textContent(), /check on launch/);
    await page.keyboard.press('Escape');
  }

  const pieces = Array.from({ length: 80 }, (_, i) => `${i},`);
  await rpc('pane.input', { paneId: pane.id, data: "$winmuxBurst = '" });
  const results = await page.evaluate(async ({ paneId, pieces }) => Promise.allSettled(pieces.map(data => window.winmux.call('pane.input', { paneId, data }))), { paneId: pane.id, pieces });
  assert.ok(results.every(result => result.status === 'fulfilled'), '80 concurrent desktop inputs must all reach the PTY');
  await rpc('pane.input', { paneId: pane.id, data: "'; Write-Output ('BURST_RESULT_' + $winmuxBurst.Length)\r" });
  await page.waitForFunction(async ({ paneId, expected }) => (await window.winmux.call('pane.screen', { paneId })).text.includes(expected), { paneId: pane.id, expected: `BURST_RESULT_${pieces.join('').length}` });

  const sizes = Array.from({ length: 80 }, (_, i) => ({ cols: 80 + i, rows: 25 + i % 10 }));
  const resized = await page.evaluate(async ({ paneId, sizes }) => Promise.allSettled(sizes.map(size => window.winmux.call('pane.resize', { paneId, ...size }))), { paneId: pane.id, sizes });
  assert.ok(resized.every(result => result.status === 'fulfilled'), '80 desktop resizes must finish without pending-request overflow');
  const snapshot = await rpc('pane.snapshot', { paneId: pane.id });
  assert.equal(snapshot.cols, sizes.at(-1).cols);
  assert.equal(snapshot.rows, sizes.at(-1).rows);
  assert.equal(await page.locator('.error-banner').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(runningWsl(), before, 'agent options and Windows PTY operations must leave WSL state intact');
  await page.screenshot({ path: path.join(artifacts, 'recovery-desktop.png') });
  console.log(JSON.stringify({ passed: true, inputs: 80, resizes: 80, deferredAgents: deferred.length, runningWslUnchanged: true }));
}

async function run() {
  try { await main(); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
  finally {
    if (desktop) await desktop.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    if (fs.existsSync(path.join(dataDir, 'ipc-token'))) {
      const stopped = cli('shutdown');
      if (stopped.status !== 0) { console.error(stopped.stderr || stopped.error?.message); process.exitCode = 1; }
    }
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
