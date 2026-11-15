'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'local-file-preview-'));
const projectDir = path.join(dataDir, 'project');
fs.mkdirSync(projectDir);
const validPath = path.join(projectDir, 'valid-preview.txt');
fs.writeFileSync(validPath, 'Local preview recovered\n');

const missingPath = 'C:\\root\\collision_verdict3';
assert.equal(fs.existsSync(missingPath), false, 'The collision_verdict3 repro path must remain absent, not remapped or created.');

const env = { ...process.env, WINMUX_DATA_DIR:dataDir, WINMUX_NO_PROFILE:'1', WINMUX_TEST_MODE:'1' };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
let page;
const errors = [];

function cli(command) {
  return spawnSync(require('electron'), [path.join(root, 'cli.cjs'), command], {
    cwd:root,
    env:{ ...env, ELECTRON_RUN_AS_NODE:'1' },
    encoding:'utf8',
    timeout:20000,
  });
}

async function rpc(method, params = {}) {
  return page.evaluate(({ method, params }) => window.winmux.call(method, params), { method, params });
}

async function waitScreen(paneId, text) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const screen = await rpc('pane.screen', { paneId });
    if (screen.text.includes(text)) return screen;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Terminal did not show ${text}`);
}

async function screenPoint(paneId, needle) {
  const screen = await rpc('pane.screen', { paneId });
  const lines = screen.text.split(/\r?\n/);
  const row = lines.findIndex(line => line.includes(needle));
  assert.notEqual(row, -1, `Terminal screen did not contain ${needle}`);
  const column = lines[row].indexOf(needle);
  const state = await rpc('state');
  const pane = state.workspaces.flatMap(workspace => workspace.panes).find(item => item.id === paneId);
  assert(pane, `Missing terminal pane ${paneId}`);
  let box;
  let previousBox;
  for (let attempt = 0; attempt < 40; attempt++) {
    box = await page.locator(`[data-pane-id="${paneId}"] .xterm-screen`).boundingBox();
    if (box && previousBox
      && Math.abs(box.x - previousBox.x) < 0.5
      && Math.abs(box.y - previousBox.y) < 0.5
      && Math.abs(box.width - previousBox.width) < 0.5
      && Math.abs(box.height - previousBox.height) < 0.5) {
      break;
    }
    previousBox = box;
    await page.waitForTimeout(50);
  }
  assert(box, 'Terminal screen has no layout box');
  const rows = Math.max(1, lines.length);
  return {
    x:box.x + (column + 1) * (box.width / pane.cols),
    y:box.y + (row + 0.5) * (box.height / rows),
    cellWidth:box.width / pane.cols,
    cellHeight:box.height / rows,
  };
}

async function assertNoPreviewOrError(stage) {
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.error-banner').count(), 0, `Unexpected preview error after ${stage}`);
  assert.equal(await page.locator('[data-testid="local-file-preview-modal"]').count(), 0, `Unexpected preview modal after ${stage}`);
}

async function hoverRegisteredLink(paneId, needle) {
  const base = await screenPoint(paneId, needle);
  const attempts = [];
  await page.mouse.move(5, 5);
  await page.waitForTimeout(25);
  for (const rowOffset of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
    const point = { ...base, y:base.y + rowOffset * base.cellHeight };
    attempts.push({ rowOffset, x:point.x, y:point.y });
    await page.mouse.move(point.x, point.y);
    try {
      await page.locator('.local-file-link-tooltip').waitFor({ timeout:300 });
      const label = await page.locator('.local-file-link-tooltip').innerText();
      if (label.includes(needle)) return point;
    } catch {
      // Try the adjacent rendered row; headless snapshot and clipped browser rows can differ after layout changes.
    }
  }
  const screen = await rpc('pane.screen', { paneId });
  const screenshot = path.join(artifacts, 'local-file-preview-debug.png');
  await page.screenshot({ path:screenshot });
  throw new Error(JSON.stringify({ needle, attempts, screen:screen.text, screenshot }, null, 2));
}

async function closeDesktop() {
  if (!desktop) return;
  try {
    await Promise.race([
      desktop.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Desktop close exceeded 10 seconds')), 10000)),
    ]);
  } finally {
    desktop = null;
  }
}

async function removeFixture() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      fs.rmSync(dataDir, { recursive:true, force:true, maxRetries:1, retryDelay:100 });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 29) {
        console.error(`Fixture cleanup failed: ${error.message}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function installPendingPreviewGate() {
  await desktop.evaluate(({ ipcMain }, gatePath) => {
    if (!(ipcMain._invokeHandlers instanceof Map)) throw new Error('Electron IPC handler map is unavailable');
    const original = ipcMain._invokeHandlers.get('winmux:call');
    if (typeof original !== 'function') throw new Error('winmux:call handler is unavailable');
    globalThis.__winmuxPreviewGate = { gatePath, armed:false, pending:0, release:null };
    ipcMain.removeHandler('winmux:call');
    ipcMain.handle('winmux:call', async (event, method, params) => {
      const gate = globalThis.__winmuxPreviewGate;
      if (method === 'file.open' && params?.path === gate.gatePath && gate.armed) {
        gate.armed = false;
        gate.pending += 1;
        await new Promise(resolve => { gate.release = resolve; });
        gate.pending -= 1;
        gate.release = null;
        throw new Error(`File not found: ${params.path}`);
      }
      return original(event, method, params);
    });
  }, missingPath);
}

async function armPreviewGate() {
  await desktop.evaluate(() => {
    const gate = globalThis.__winmuxPreviewGate;
    if (!gate || gate.pending) throw new Error('Preview gate is not idle');
    gate.armed = true;
    gate.release = null;
  });
}

async function waitPreviewGatePending() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await desktop.evaluate(() => globalThis.__winmuxPreviewGate?.pending === 1)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Controlled file.open rejection did not reach the main-process gate');
}

async function releasePreviewGate() {
  await desktop.evaluate(() => {
    const gate = globalThis.__winmuxPreviewGate;
    if (!gate?.release) throw new Error('Controlled file.open rejection is not pending');
    gate.release();
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await desktop.evaluate(() => globalThis.__winmuxPreviewGate?.pending === 0)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Controlled file.open rejection did not finish');
}

async function waitPaneVisibility(paneId, visible) {
  await page.waitForFunction(({ paneId, visible }) => {
    const pane = document.querySelector(`[data-pane-id="${paneId}"]`);
    return Boolean(pane) && (getComputedStyle(pane).display !== 'none') === visible;
  }, { paneId, visible }, { timeout:10000 });
}

async function openUi() {
  desktop = await electron.launch({ args:[root], cwd:root, env, timeout:30000 });
  page = await desktop.firstWindow({ timeout:30000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.winmux, { timeout:20000 });
  await page.waitForSelector('#root > *', { timeout:20000 });
}

async function main() {
  const start = cli('start');
  assert.equal(start.status, 0, start.stderr || start.error?.message || start.stdout);
  await openUi();

  const workspace = await rpc('workspace.create', { name:'Local links', cwd:projectDir, profileId:'powershell' });
  const pane = workspace.panes[0];
  await rpc('settings.update', { activeWorkspaceId:workspace.id });
  await page.waitForSelector(`[data-pane-id="${pane.id}"] .xterm-screen`, { timeout:15000 });

  const script = [
    'Clear-Host',
    "1..50 | ForEach-Object { Write-Output ('filler-' + $_) }",
    `Write-Output '${missingPath}'`,
    "Write-Output 'valid-preview.txt'",
    "Write-Output ('LOCAL_LINK_' + 'READY')",
  ].join('; ');
  await rpc('pane.input', { paneId:pane.id, data:`${script}\r` });
  await waitScreen(pane.id, 'LOCAL_LINK_READY');

  await assertNoPreviewOrError('terminal output');
  const missingPoint = await hoverRegisteredLink(pane.id, missingPath);
  await assertNoPreviewOrError('hover and link-provider rendering');

  await page.mouse.move(missingPoint.x, missingPoint.y);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(150);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(150);
  await assertNoPreviewOrError('scroll and rerender');

  await page.mouse.move(missingPoint.x + missingPoint.cellWidth, missingPoint.y);
  await page.mouse.down();
  await page.mouse.move(
    missingPoint.x + missingPoint.cellWidth,
    missingPoint.y + missingPoint.cellHeight * 2,
    { steps:8 },
  );
  await page.mouse.up();
  await assertNoPreviewOrError('mouse selection ending outside the link');

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await page.waitForTimeout(200);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 880));
  await page.waitForTimeout(200);
  await assertNoPreviewOrError('resize');

  await page.reload();
  await page.waitForFunction(() => !!window.winmux, { timeout:20000 });
  await page.waitForSelector(`[data-pane-id="${pane.id}"] .xterm-screen`, { timeout:15000 });
  await waitScreen(pane.id, 'VISIBLE_SPLIT_READY');
  await assertNoPreviewOrError('snapshot reattach');

  await installPendingPreviewGate();
  const secondTab = await rpc('tab.create', { workspaceId:workspace.id, sourcePaneId:pane.id });
  let currentState = await rpc('state');
  let currentWorkspace = currentState.workspaces.find(item => item.id === workspace.id);
  const secondPane = currentWorkspace.panes.find(item => item.tabId === secondTab.id);
  assert(secondPane, 'New terminal tab did not create a pane');
  await rpc('tab.select', { workspaceId:workspace.id, tabId:workspace.activeTabId });
  await waitPaneVisibility(pane.id, true);
  await waitPaneVisibility(secondPane.id, false);

  await armPreviewGate();
  let point = await hoverRegisteredLink(pane.id, missingPath);
  await page.mouse.click(point.x, point.y);
  await waitPreviewGatePending();
  await rpc('tab.select', { workspaceId:workspace.id, tabId:secondTab.id });
  await waitPaneVisibility(pane.id, false);
  await waitPaneVisibility(secondPane.id, true);
  await releasePreviewGate();
  await assertNoPreviewOrError('switching away from a tab with a pending rejection');

  await rpc('pane.input', {
    paneId:secondPane.id,
    data:`Write-Output '${missingPath}'; Write-Output ('CLOSE_PENDING_' + 'READY')\r`,
  });
  await waitScreen(secondPane.id, 'CLOSE_PENDING_READY');
  await armPreviewGate();
  point = await hoverRegisteredLink(secondPane.id, missingPath);
  await page.mouse.click(point.x, point.y);
  await waitPreviewGatePending();
  await rpc('tab.close', { workspaceId:workspace.id, tabId:secondTab.id });
  await waitPaneVisibility(pane.id, true);
  await releasePreviewGate();
  await assertNoPreviewOrError('closing a tab with a pending rejection');

  const splitPane = await rpc('pane.split', { paneId:pane.id, direction:'horizontal' });
  await waitPaneVisibility(pane.id, true);
  await waitPaneVisibility(splitPane.id, true);
  await rpc('pane.input', {
    paneId:pane.id,
    data:`Clear-Host; Write-Output '${missingPath}'; Write-Output 'valid-preview.txt'; Write-Output ('VISIBLE_SPLIT_' + 'READY')\r`,
  });
  await waitScreen(pane.id, 'VISIBLE_SPLIT_READY');
  await armPreviewGate();
  point = await hoverRegisteredLink(pane.id, missingPath);
  await page.mouse.click(point.x, point.y);
  await waitPreviewGatePending();
  await releasePreviewGate();
  await page.waitForFunction(() => document.querySelector('.error-banner')?.textContent?.includes('File not found'));
  const englishError = await page.locator('.error-banner').innerText();
  assert.match(englishError, /File not found: C:\\root\\collision_verdict3/);
  assert.doesNotMatch(englishError, /Error invoking remote method|winmux:call/);

  await page.mouse.move(5, 5);
  await page.locator('.local-file-link-tooltip').waitFor({ state:'detached' });
  point = await hoverRegisteredLink(pane.id, 'valid-preview.txt');
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="local-file-text"]')
    || document.querySelector('.error-banner')
  ));
  const englishRecoveryError = await page.locator('.error-banner').innerText().catch(() => '');
  assert.equal(englishRecoveryError, '', 'A valid terminal link must open after a missing-file error');
  await page.getByTestId('local-file-text').waitFor();
  assert.equal(await page.locator('.error-banner').count(), 0, 'A valid open after failure must clear the stale error');
  await page.keyboard.press('Escape');

  await page.evaluate(() => localStorage.setItem('winmux.language', 'ru'));
  await page.reload();
  await page.waitForFunction(() => !!window.winmux, { timeout:20000 });
  await page.waitForSelector(`[data-pane-id="${pane.id}"] .xterm-screen`, { timeout:15000 });
  await waitScreen(pane.id, 'LOCAL_LINK_READY');

  point = await screenPoint(pane.id, missingPath);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => document.querySelector('.error-banner')?.textContent?.includes('Файл не найден'));
  const russianError = await page.locator('.error-banner').innerText();
  assert.match(russianError, /Файл не найден: C:\\root\\collision_verdict3/);
  assert.doesNotMatch(russianError, /Error invoking remote method|winmux:call/);

  await page.mouse.move(5, 5);
  await page.locator('.local-file-link-tooltip').waitFor({ state:'detached' });
  point = await hoverRegisteredLink(pane.id, 'valid-preview.txt');
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="local-file-text"]')
    || document.querySelector('.error-banner')
  ));
  const russianRecoveryError = await page.locator('.error-banner').innerText().catch(() => '');
  assert.equal(russianRecoveryError, '', 'A valid Russian terminal link must open after a missing-file error');
  await page.getByTestId('local-file-text').waitFor();
  assert.equal(await page.locator('.error-banner').count(), 0, 'Russian valid open after failure must clear the stale error');
  assert.equal(errors.length, 0, `Renderer errors: ${errors.join('; ')}`);

  console.log(JSON.stringify({
    status:'passed',
    dataDir,
    observations:[
      'Terminal output, provider hover, scrolling, selection, resize and snapshot reattach did not open a missing file.',
      'The exact missing path remained C:\\root\\collision_verdict3 and was never created or remapped.',
      'A pending rejection stayed hidden after switching away from or closing its owning tab, while the same failure remained visible with two visible split panes.',
      'English and Russian missing-file errors omit the raw Electron IPC wrapper.',
      'A later valid terminal link opens the preview and clears the prior error.',
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await closeDesktop().catch(error => console.error(`Desktop close failed: ${error.message}`));
  const stop = cli('shutdown');
  if (stop.status !== 0) console.error(`Isolated daemon shutdown: ${stop.stderr || stop.error?.message || stop.stdout}`);
  await removeFixture();
});
