'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { request: browserRequest } = require('../scripts/browser.cjs');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive:true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'files-context-'));
const project = path.join(dataDir, 'project space Ж');
const childDir = path.join(project, 'child');
fs.mkdirSync(childDir, { recursive:true });
fs.writeFileSync(path.join(project, 'root.txt'), 'Root content\n');
fs.writeFileSync(path.join(childDir, 'child.txt'), 'Child content\n');
const env = { ...process.env, WINMUX_DATA_DIR:dataDir, WINMUX_NO_PROFILE:'1', WINMUX_TEST_MODE:'1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'WINMUX_DEV_URL', 'WINMUX_PIPE_NAME']) delete env[key];
let desktop, page;
const errors = [];
const server = http.createServer((_request, response) => response.end('<!doctype html><input id="retained" value="initial">'));
const cli = command => spawnSync(require('electron'), [path.join(root, 'cli.cjs'), command], {
  cwd:root, env:{ ...env, ELECTRON_RUN_AS_NODE:'1' }, encoding:'utf8', timeout:20000, windowsHide:true,
});
const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.winmux.call(method, params), { method, params });
const browser = (method, params) => browserRequest(method, params, { dataDir });

async function assertContext(paneId, cwd) {
  await page.waitForFunction(({ paneId, cwd }) => [...document.querySelectorAll('[data-testid="files-root"]')]
    .some(element => element.dataset.paneId === paneId && element.dataset.cwd === cwd), { paneId, cwd });
  assert.equal(await page.locator('[data-testid="files-root"]').count(), 1, 'Exactly one root exists, including hidden DOM');
  assert.equal(await page.locator('.files-panel').count(), 1, 'Exactly one Files panel exists');
  assert.equal(await page.locator('.git-panel').count(), 1, 'Exactly one Git panel exists');
  assert.equal(await page.locator('[data-testid="files-root"]:visible').count(), 1, 'Only the current Files root is visible');
}

async function run() {
  const started = cli('start');
  assert.equal(started.status, 0, started.stderr || started.error?.message);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  desktop = await electron.launch({ args:[root], cwd:root, env, timeout:30000 });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.winmux);
  const workspace = await rpc('workspace.create', { name:'Files context', cwd:project, profileId:'powershell' });
  const first = workspace.panes[0];
  const firstTab = workspace.activeTabId;
  await rpc('settings.update', { activeWorkspaceId:workspace.id });
  await page.getByTestId('files-toggle').click();
  await page.locator('[data-testid="file-entry"][data-path="root.txt"]').waitFor();
  await page.getByTestId('tool-tab-git').click();
  await page.getByTestId('tool-tab-browser').click();
  const guest = await browser('open', { workspaceId:workspace.id, url:`http://127.0.0.1:${server.address().port}` });
  await browser('fill', { id:guest.id, selector:'#retained', value:'Browser retained' });
  await page.getByTestId('tool-tab-files').click();
  await assertContext(first.id, project);
  await page.locator('[data-testid="file-entry"][data-path="root.txt"]').click();
  await page.getByTestId('text-preview').fill('Unsaved draft retained');
  const secondTab = await rpc('tab.create', { workspaceId:workspace.id, sourcePaneId:first.id });
  const secondId = secondTab.root.paneId;
  await assertContext(secondId, project);
  for (let index = 0; index < 3; index++) {
    await rpc('tab.select', { workspaceId:workspace.id, tabId:firstTab });
    await assertContext(first.id, project);
    await page.locator('[data-testid="file-entry"][data-path="root.txt"]').click();
    assert.equal(await page.getByTestId('text-preview').inputValue(), 'Unsaved draft retained');
    await page.getByTestId('tool-tab-git').click();
    assert.equal(await page.locator('.git-panel:visible').count(), 1);
    await page.getByTestId('tool-tab-files').click();
    await rpc('tab.select', { workspaceId:workspace.id, tabId:secondTab.id });
    await assertContext(secondId, project);
    await rpc('pane.input', { paneId:secondId, data:`Set-Location -LiteralPath '${childDir.replace(/'/g, "''")}'\r` });
    await assertContext(secondId, childDir);
    await page.locator('[data-testid="file-entry"][data-path="child.txt"]').waitFor();
    await rpc('pane.input', { paneId:secondId, data:`Set-Location -LiteralPath '${project.replace(/'/g, "''")}'\r` });
    await assertContext(secondId, project);
  }
  await page.getByTestId('tool-tab-browser').click();
  assert.equal(await browser('evaluate', { id:guest.id, expression:'document.querySelector("#retained").value' }), 'Browser retained');
  await page.getByTestId('tool-tab-files').click();
  await assertContext(secondId, project);
  await page.locator('[data-testid="file-entry"][data-path="child"]').click();
  await page.locator('[data-testid="file-entry"][data-path="child/child.txt"]').waitFor();
  assert.equal(fs.readFileSync(path.join(project, 'root.txt'), 'utf8'), 'Root content\n', 'Unsaved draft never overwrites disk');
  assert.deepEqual(errors, []);
  await page.screenshot({ path:path.join(artifacts, 'files-context-fixed.png') });
  console.log('PASS Files/Git have one root across pane/cwd switches; drafts, expansion and browser guest state survive.');
}
run().catch(async error => {
  if (page) await page.screenshot({ path:path.join(artifacts, 'files-context-failure.png') }).catch(() => {});
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  if (desktop) {
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await desktop.close().catch(error => { console.error(error); process.exitCode = 1; });
  }
  cli('shutdown');
  server.closeAllConnections(); server.close();
});
