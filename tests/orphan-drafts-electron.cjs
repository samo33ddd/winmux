'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'orphan-drafts-'));
const project = path.join(dataDir, 'project');
fs.mkdirSync(project);
const fileName = 'orphaned-note.txt';
const filePath = path.join(project, fileName);
fs.writeFileSync(filePath, 'original text\n');

const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_NO_PROFILE: '1', WINMUX_TEST_MODE: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'WINMUX_PIPE_NAME', 'WINMUX_PANE_ID', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER', 'WINMUX_AGENT_LAUNCH_ID', 'WINMUX_TASK_ID', 'WINMUX_DEV_URL']) delete env[key];
let desktop, page;
const errors = [];

function cli(command) {
  return spawnSync(require('electron'), [path.join(root, 'cli.cjs'), command], {
    cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 25000,
  });
}
function rpc(method, params = {}) {
  return page.evaluate(({ method, params }) => window.winmux.call(method, params), { method, params });
}
async function waitPaneGone(paneId) {
  await page.waitForFunction(async id => {
    const current = await window.winmux.call('state');
    return !current.workspaces.some(workspace => workspace.panes.some(pane => pane.id === id));
  }, paneId, { timeout: 15000 });
}

async function main() {
  const started = cli('start');
  assert.equal(started.status, 0, started.stderr || started.error?.message || started.stdout);
  desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow({ timeout: 30000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.winmux, { timeout: 20000 });
  await page.waitForSelector('#root > *', { timeout: 20000 });

  const workspace = await rpc('workspace.create', { name: 'Orphan fixture', cwd: project, profileId: 'powershell' });
  const pane = workspace.panes[0];
  await rpc('settings.update', { activeWorkspaceId: workspace.id });
  await page.waitForSelector(`[data-pane-id="${pane.id}"] .xterm-screen`, { timeout: 15000 });

  // Open the file and leave an unsaved edit.
  await page.getByTestId('files-toggle').click();
  await page.locator(`[data-testid="file-entry"][data-path="${fileName}"]`).waitFor();
  await page.locator(`[data-testid="file-entry"][data-path="${fileName}"]`).click();
  await page.getByTestId('text-preview').waitFor();
  await page.getByTestId('text-preview').fill('orphaned unsaved content');

  // The daemon removes the pane directly (no UI confirm): the dirty draft must
  // be marked orphaned instead of silently dropped.
  await rpc('pane.close', { paneId: pane.id });
  await waitPaneGone(pane.id);
  await page.getByTestId('orphan-banner').waitFor({ timeout: 15000 });

  // Open recovery: the draft text survives, the file on disk is untouched.
  await page.getByTestId('orphan-open').click();
  await page.getByTestId('orphan-text').waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('orphan-text').inputValue(), 'orphaned unsaved content');
  assert(fs.readFileSync(filePath, 'utf8').includes('original text'), 'file on disk must not be overwritten by the orphan');

  // Discard is two-step: arm, then confirm; modal and banner both clear.
  await page.getByTestId('orphan-discard').click();
  await page.getByTestId('orphan-discard-confirm').click();
  await page.getByTestId('orphan-text').waitFor({ state: 'detached', timeout: 10000 });
  assert.equal(await page.getByTestId('orphan-banner').count(), 0, 'discarded orphan must hide the banner');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS orphan draft recovery: dirty draft survives pane removal, banner opens modal, two-step discard clears it');
}

async function shutdown() {
  try { if (desktop) await desktop.close(); } catch {}
  try { spawnSync(require('electron'), [path.join(root, 'cli.cjs'), 'shutdown'], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 20000 }); } catch {}
}

main().then(async () => { await shutdown(); process.exit(0); }, async error => { console.error(error); await shutdown(); process.exit(1); });
