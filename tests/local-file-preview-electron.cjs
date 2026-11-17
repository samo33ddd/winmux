'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'local-file-preview-'));
const projectDir = fs.mkdtempSync(path.join(artifacts, 'preview-project-'));

const validPath = path.join(projectDir, 'valid-preview.txt');
fs.writeFileSync(validPath, 'Local preview recovered\n');

const missingPath = 'C:\\root\\collision_verdict3';
assert.equal(fs.existsSync(missingPath), false, 'The collision_verdict3 repro path must remain absent, not remapped or created.');

const env = { ...process.env, WINMUX_DATA_DIR:dataDir, WINMUX_NO_PROFILE:'1', WINMUX_TEST_MODE:'1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'WINMUX_PIPE_NAME', 'WINMUX_PANE_ID', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER', 'WINMUX_AGENT_LAUNCH_ID', 'WINMUX_TASK_ID', 'WINMUX_DEV_URL']) delete env[key];
let desktop;
let page;
let rendererServer;
let linkServer;
const errors = [];

function cli(command) {
  return spawnSync(require('electron'), [path.join(root, 'cli.cjs'), command], {
    cwd:root,
    env:{ ...env, ELECTRON_RUN_AS_NODE:'1' },
    encoding:'utf8',
    timeout:20000,
  });
}

function cliOpen(file, paneId) {
  return spawnSync(require('electron'), [path.join(root, 'cli.cjs'), 'open', file, '--pane', paneId], {
    cwd:root,
    env:{ ...env, ELECTRON_RUN_AS_NODE:'1' },
    encoding:'utf8',
    timeout:20000,
  });
}

async function startRendererServer() {
  const rendererDir = process.env.WINMUX_PREVIEW_DIST_DIR;
  if (!rendererDir) return;
  const dist = path.resolve(rendererDir);
  assert.equal(fs.existsSync(path.join(dist, 'index.html')), true, `Missing preview renderer build: ${dist}`);
  rendererServer = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const target = path.resolve(dist, relative);
      if (!target.startsWith(dist + path.sep)) throw new Error('Invalid renderer path');
      const type = target.endsWith('.js') ? 'text/javascript'
        : target.endsWith('.css') ? 'text/css'
          : target.endsWith('.html') ? 'text/html; charset=utf-8'
            : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type':type });
      response.end(fs.readFileSync(target));
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    rendererServer.once('error', reject);
    rendererServer.listen(0, '127.0.0.1', resolve);
  });
  env.WINMUX_DEV_URL = `http://127.0.0.1:${rendererServer.address().port}`;
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

async function ctrlClick(x, y) {
  await page.keyboard.down('Control');
  try { await page.mouse.click(x, y); } finally { await page.keyboard.up('Control'); }
}
async function screenPoint(paneId, needle) {
  let box;
  let previousBox;
  let stable = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    box = await page.locator(`[data-pane-id="${paneId}"] .xterm-screen`).boundingBox();
    if (box && previousBox
      && Math.abs(box.x - previousBox.x) < 0.5
      && Math.abs(box.y - previousBox.y) < 0.5
      && Math.abs(box.width - previousBox.width) < 0.5
      && Math.abs(box.height - previousBox.height) < 0.5) {
      if (++stable >= 2) break;
    } else stable = 0;
    previousBox = box;
    await page.waitForTimeout(50);
  }
  assert(box, 'Terminal screen has no layout box');
  const screen = await rpc('pane.screen', { paneId });
  const lines = screen.text.split(/\r?\n/);
  const row = lines.findIndex(line => line.includes(needle));
  assert.notEqual(row, -1, `Terminal screen did not contain ${needle}`);
  const column = lines[row].indexOf(needle);
  return {
    x:box.x + (column + 1) * (box.width / screen.cols),
    y:box.y + (row + 0.5) * (box.height / screen.rows),
    cellWidth:box.width / screen.cols,
    cellHeight:box.height / screen.rows,
  };
}

async function assertNoPreviewOrError(stage) {
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.error-banner').count(), 0, `Unexpected preview error after ${stage}`);
  assert.equal(await page.locator('.local-file-preview-modal').count(), 0, `Unexpected preview modal after ${stage}`);
}

async function hoverRegisteredLink(paneId, needle, tooltip = needle) {
  const base = await screenPoint(paneId, needle);
  const attempts = [];
  await page.mouse.move(5, 5);
  await page.waitForTimeout(25);
  for (const rowOffset of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
    for (const columnOffset of [0, 0.5, -0.5]) {
      const point = {
        ...base,
        x:base.x + columnOffset * base.cellWidth,
        y:base.y + rowOffset * base.cellHeight,
      };
      attempts.push({ rowOffset, columnOffset, x:point.x, y:point.y });
      await page.mouse.move(point.x, point.y);
      try {
        await page.locator('.local-file-link-tooltip').waitFor({ timeout:300 });
        const label = await page.locator('.local-file-link-tooltip').innerText();
        if (label.includes(tooltip)) return point;
      } catch {
        // Try adjacent rendered cells; headless snapshot and clipped browser rows can differ after layout changes.
      }
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
  await startRendererServer();
  const start = cli('start');
  assert.equal(start.status, 0, start.stderr || start.error?.message || start.stdout);
  await openUi();

  const workspace = await rpc('workspace.create', { name:'Local links', cwd:projectDir, profileId:'powershell' });
  const pane = workspace.panes[0];
  await rpc('settings.update', { activeWorkspaceId:workspace.id });
  await page.waitForSelector(`[data-pane-id="${pane.id}"] .xterm-screen`, { timeout:15000 });

  const script = [
    'Clear-Host',
    "1..20 | ForEach-Object { Write-Output ('filler-' + $_) }",
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
  await waitScreen(pane.id, 'LOCAL_LINK_READY');
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
  await ctrlClick(point.x, point.y);
  await waitPreviewGatePending();
  await rpc('tab.select', { workspaceId:workspace.id, tabId:secondTab.id });
  await waitPaneVisibility(pane.id, false);
  await waitPaneVisibility(secondPane.id, true);
  await releasePreviewGate();
  await assertNoPreviewOrError('switching away from a tab with a pending rejection');

  await rpc('tab.select', { workspaceId:workspace.id, tabId:workspace.activeTabId });
  await waitPaneVisibility(pane.id, true);
  await armPreviewGate();
  point = await hoverRegisteredLink(pane.id, missingPath);
  await ctrlClick(point.x, point.y);
  await waitPreviewGatePending();
  await rpc('tab.select', { workspaceId:workspace.id, tabId:secondTab.id });
  await waitPaneVisibility(pane.id, false);
  await rpc('tab.select', { workspaceId:workspace.id, tabId:workspace.activeTabId });
  await waitPaneVisibility(pane.id, true);
  await releasePreviewGate();
  await assertNoPreviewOrError('hiding and showing a tab before a pending rejection settles');

  await rpc('tab.select', { workspaceId:workspace.id, tabId:secondTab.id });
  await waitPaneVisibility(secondPane.id, true);
  await waitPaneVisibility(pane.id, false);
  await rpc('pane.input', {
    paneId:secondPane.id,
    data:`Write-Output '${missingPath}'; Write-Output ('CLOSE_PENDING_' + 'READY')\r`,
  });
  await waitScreen(secondPane.id, 'CLOSE_PENDING_READY');
  await armPreviewGate();
  point = await hoverRegisteredLink(secondPane.id, missingPath);
  await ctrlClick(point.x, point.y);
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
    data:`Clear-Host; Write-Output '${missingPath}'; Write-Output 'valid-preview.txt'; Write-Output ('SPLIT_FAILURE_' + 'READY')\r`,
  });
  await rpc('pane.input', {
    paneId:splitPane.id,
    data:`Clear-Host; Write-Output 'valid-preview.txt'; Write-Output ('SPLIT_SUCCESS_' + 'READY')\r`,
  });
  await waitScreen(pane.id, 'SPLIT_FAILURE_READY');
  await waitScreen(splitPane.id, 'SPLIT_SUCCESS_READY');

  await armPreviewGate();
  point = await hoverRegisteredLink(pane.id, missingPath);
  await ctrlClick(point.x, point.y);
  await waitPreviewGatePending();
  const successPoint = await hoverRegisteredLink(splitPane.id, 'valid-preview.txt');
  await ctrlClick(successPoint.x, successPoint.y);
  await page.locator('.local-file-preview-modal').waitFor();
  await releasePreviewGate();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.error-banner').count(), 0, 'An older split-pane rejection must not restore the banner after a newer successful preview');
  assert.equal(await page.locator('.local-file-preview-modal').count(), 1, 'The newer successful split-pane preview must remain open');
  await page.keyboard.press('Escape');

  await armPreviewGate();
  point = await hoverRegisteredLink(pane.id, missingPath);
  await ctrlClick(point.x, point.y);
  await waitPreviewGatePending();
  await page.getByTestId('files-toggle').click();
  await page.locator('[data-testid="file-entry"][data-path="valid-preview.txt"]').click();
  await page.getByTestId('text-preview').waitFor();
  await releasePreviewGate();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.error-banner').count(), 0, 'A newer successful Files preview must suppress an older pending terminal rejection');
  assert.equal(await page.getByTestId('text-preview').count(), 1, 'The newer Files preview must remain visible');
  await page.getByTestId('files-toggle').click();

  await armPreviewGate();
  point = await hoverRegisteredLink(pane.id, missingPath);
  await ctrlClick(point.x, point.y);
  await waitPreviewGatePending();
  await releasePreviewGate();
  await page.waitForFunction(() => document.querySelector('.error-banner')?.textContent?.includes('File not found'));
  const englishError = await page.locator('.error-banner').innerText();
  assert.match(englishError, /File not found: C:\\root\\collision_verdict3/);
  assert.doesNotMatch(englishError, /Error invoking remote method|winmux:call/);

  const externalPreview = cliOpen(validPath, pane.id);
  assert.equal(externalPreview.status, 0, externalPreview.stderr || externalPreview.stdout);
  await page.getByTestId('local-file-text').waitFor();
  assert.equal(await page.locator('.local-file-preview-modal').count(), 1, 'A successful CLI preview must open the real modal');
  assert.equal(await page.locator('.error-banner').count(), 0, 'A Files/CLI preview success must clear the stale terminal preview error');
  await page.keyboard.press('Escape');

  // #61: the selected instance's own data directory can never be previewed.
  const privateFiles = [
    path.join(dataDir, 'hooks', 'session', 'synthetic-hook.json'),
    path.join(dataDir, 'private', 'sentinel.txt'),
    path.join(dataDir, 'ui', 'sentinel-state.json'),
  ];
  for (const target of privateFiles) fs.mkdirSync(path.dirname(target), { recursive:true });
  for (const target of privateFiles) fs.writeFileSync(target, 'WINMUX_SENTINEL');
  for (const target of privateFiles) {
    const rejection = await page.evaluate(value => window.winmux.call('file.open', { path:value }).then(() => '').catch(error => String(error?.message || error)), target);
    assert.match(rejection, /private data/i, `private preview must be rejected: ${target}`);
    assert(!rejection.includes('SENTINEL'), 'rejection must not include contents');
  }
  const cliRejection = cliOpen(privateFiles[0], pane.id);
  assert.notEqual(cliRejection.status, 0, 'CLI open of a private file must fail');
  if (!/private data/i.test(cliRejection.stderr || '')) console.log('CLI-REJECT-DEBUG', JSON.stringify({status:cliRejection.status, stdout:cliRejection.stdout, stderr:cliRejection.stderr, error:String(cliRejection.error)}));
  assert.match(cliRejection.stderr || cliRejection.stdout || '', /private data/i);
  await assertNoPreviewOrError('private-data rejection');
  // The browser-control file.open path gets the same rejection, never contents.
  const { request:browserRequest } = require('../scripts/browser.cjs');
  const browserResult = await new Promise(resolve => {
    browserRequest('file.open', { path:privateFiles[1] }, { dataDir }).then(
      () => resolve('resolved'),
      error => resolve(String(error?.message || error)),
    );
  });
  assert.match(browserResult, /private data/i, 'browser file.open must reject private data');
  assert(!browserResult.includes('SENTINEL'), 'browser reply must not include contents');
  // Ordinary browser file.open stays metadata-only for an allowed file.
  const ordinaryBrowser = await browserRequest('file.open', { path:validPath }, { dataDir });
  assert.equal(ordinaryBrowser.text, undefined, 'metadata reply must not include contents');
  assert.equal(ordinaryBrowser.name, 'valid-preview.txt');
  console.log('PASS private-data preview rejected on every caller; ordinary browser metadata intact');

  await page.evaluate(() => localStorage.setItem('winmux.language', 'ru'));
  await page.reload();
  await page.waitForFunction(() => !!window.winmux, { timeout:20000 });
  await page.waitForSelector(`[data-pane-id="${pane.id}"] .xterm-screen`, { timeout:15000 });
  await waitScreen(pane.id, 'SPLIT_FAILURE_READY');

  point = await screenPoint(pane.id, missingPath);
  await ctrlClick(point.x, point.y);
  await page.waitForFunction(() => document.querySelector('.error-banner')?.textContent?.includes('Файл не найден'));
  const russianError = await page.locator('.error-banner').innerText();
  assert.match(russianError, /Файл не найден: C:\\root\\collision_verdict3/);
  assert.doesNotMatch(russianError, /Error invoking remote method|winmux:call/);

  await page.mouse.move(5, 5);
  await page.locator('.local-file-link-tooltip').waitFor({ state:'detached' });
  point = await hoverRegisteredLink(pane.id, 'valid-preview.txt');
  await ctrlClick(point.x, point.y);
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="local-file-text"]')
    || document.querySelector('.error-banner')
  ));
  const russianRecoveryError = await page.locator('.error-banner').innerText().catch(() => '');
  assert.equal(russianRecoveryError, '', 'A valid Russian terminal link must open after a missing-file error');
  await page.getByTestId('local-file-text').waitFor();
  assert.equal(await page.locator('.local-file-preview-modal').count(), 1, 'The real local preview modal selector must find the Russian preview');
  assert.equal(await page.locator('.error-banner').count(), 0, 'Russian valid open after failure must clear the stale error');
  await page.keyboard.press('Escape');
  await rpc('pane.close', { paneId:splitPane.id });
  await desktop.evaluate(({ shell, dialog }) => {
    globalThis.linkExternalCalls = 0;
    shell.openExternal = async () => { globalThis.linkExternalCalls++; };
    dialog.showMessageBox = async () => { globalThis.linkExternalCalls++; return { response:1 }; };
  });
  linkServer = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Terminal link fixture</title><h1>Embedded link reached</h1>');
  });
  await new Promise(resolve => linkServer.listen(0, '127.0.0.1', resolve));
  const linkBase = `http://127.0.0.1:${linkServer.address().port}`;
  for (const osc8 of [false, true]) {
    const url = `${linkBase}/${osc8 ? 'osc8' : 'plain'}`;
    const label = osc8 ? 'OSC8_LINK' : url;
    const output = osc8
      ? `([char]27 + ']8;;${url}' + [char]7 + '${label}' + [char]27 + ']8;;' + [char]7)`
      : `'${url}'`;
    const ready = `WEB_${osc8 ? 'OSC8' : 'PLAIN'}_READY`;
    await rpc('pane.input', { paneId:pane.id, data:`Clear-Host; Write-Output ${output}; Write-Output ('${ready.slice(0, -5)}' + 'READY')\r` });
    await waitScreen(pane.id, ready);
    point = await hoverRegisteredLink(pane.id, label, url);
    assert.match(await page.locator('.local-file-link-tooltip').innerText(), /Ctrl/);
    const browserURLs = () => page.evaluate(() => [...document.querySelectorAll('webview')].map(view => {
      try { return view.getURL(); } catch { return ''; }
    }));
    const beforeURLs = await browserURLs();
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(150);
    assert.deepEqual(await browserURLs(), beforeURLs, 'Ordinary clicks must not navigate');
    await ctrlClick(point.x, point.y);
    await page.waitForFunction(({ workspaceId, url }) => {
      const panel = document.querySelector(`[data-workspace-id="${workspaceId}"][data-testid="workspace-tools"]`);
      return [...(panel?.querySelectorAll('webview') || [])].some(view => {
        try { return view.getURL() === url && !view.isLoading(); } catch { return false; }
      });
    }, { workspaceId:workspace.id, url }, { timeout:15000 });
    assert.equal(await desktop.evaluate(() => globalThis.linkExternalCalls), 0, 'Terminal links must not request the OS browser');
    await page.screenshot({ path:path.join(artifacts, 'terminal-web-links.png') });
    await page.getByTestId('browser-toggle').click();
  }
  assert.equal(errors.length, 0, `Renderer errors: ${errors.join('; ')}`);

  console.log(JSON.stringify({
    status:'passed',
    dataDir,
    observations:[
      'Terminal output, provider hover, scrolling, selection, resize and snapshot reattach did not open a missing file.',
      'The exact missing path remained C:\\root\\collision_verdict3 and was never created or remapped.',
      'A pending rejection stayed hidden after switching away from or closing its owning tab, while the same failure remained visible with two visible split panes.',
      'A newer successful Files read and a CLI file-preview event both superseded older terminal preview failures.',
      'English and Russian missing-file errors omit the raw Electron IPC wrapper.',
      'A later valid terminal link opens the preview and clears the prior error.',
      'Plain and OSC 8 HTTP links require Ctrl+Click and load in the owning workspace embedded browser without invoking the OS browser.',
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
  rendererServer?.closeAllConnections();
  rendererServer?.close();
  linkServer?.closeAllConnections();
  linkServer?.close();
  await removeFixture();
});
