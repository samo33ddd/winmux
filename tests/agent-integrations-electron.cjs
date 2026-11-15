'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'agent-integrations-test-'));
const projectDir = path.join(dataDir, 'Disposable project Привет');
fs.mkdirSync(projectDir);
const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_NO_PROFILE: '1', WINMUX_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.WINMUX_PIPE_NAME;
delete env.WINMUX_DEV_URL;
const rendererErrors = [];
let desktop;
let page;

function cli(command) {
  return spawnSync(require('electron'), [path.join(root, 'cli.cjs'), '--data-dir', dataDir, command], {
    cwd: root,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
}

async function rpc(method, params = {}) {
  return page.evaluate(({ method, params }) => window.winmux.call(method, params), { method, params });
}

async function installFromUi(expectedStatus) {
  await page.getByTestId('agent-hooks-install').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-hooks-result"]')
    || document.querySelector('[data-testid="agent-hooks-error"]'), null, { timeout: 15000 });
  const errorBox = page.getByTestId('agent-hooks-error');
  const error = await errorBox.count() ? await errorBox.innerText() : '';
  assert.equal(error, '', `Production Codex hook installation failed: ${error}`);
  const result = page.getByTestId('agent-hooks-result');
  assert.equal(await result.getAttribute('role'), 'status');
  assert.equal(await result.locator('strong').innerText(), expectedStatus);
  assert.match(await result.innerText(), /Open \/hooks in Codex and trust this project hook before it can run\./);
  assert.equal(await page.getByTestId('agent-hooks-install').isEnabled(), true);
  return result;
}

async function closeDesktop() {
  if (!desktop) return;
  let timer;
  try {
    await Promise.race([
      desktop.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture desktop close exceeded 10 seconds')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    desktop = null;
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This acceptance test requires the real Windows desktop and Node lookup.');
  assert.equal(fs.existsSync(path.join(projectDir, '.codex')), false);
  const started = cli('start');
  assert.equal(started.status, 0, started.stderr || started.error?.message || started.stdout);
  assert.equal(JSON.parse(started.stdout).alreadyRunning, undefined, 'The disposable daemon must be newly created.');

  desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') rendererErrors.push(message.text());
  });
  await page.waitForFunction(() => !!window.winmux, null, { timeout: 20000 });
  await page.waitForSelector('#root > *', { timeout: 20000 });
  const initial = await rpc('state');
  assert.deepEqual(initial.workspaces, [], 'A disposable instance must not contain existing user workspaces.');
  const environment = await rpc('environment');
  assert.ok(environment.profiles.some(profile => profile.id === 'powershell'
    && profile.environment === 'windows' && profile.available !== false));
  const workspace = await rpc('workspace.create', {
    name: 'Disposable UI acceptance', cwd: projectDir, profileId: 'powershell',
  });
  const pane = workspace.panes[0];
  assert.ok(pane?.id, 'The fixture workspace must have a real Windows pane.');
  await rpc('settings.update', { activeWorkspaceId: workspace.id });
  await page.waitForSelector(`[data-pane-id="${pane.id}"] .xterm`);

  await page.getByTestId('settings-open').click();
  await page.getByTestId('language-en').click();
  await page.getByTestId('settings-tab-behavior').click();
  await page.getByTestId('agent-hooks-settings').waitFor();
  assert.equal(await page.getByTestId('agent-hooks-workspace').inputValue(), workspace.id);
  assert.equal(await page.getByTestId('agent-hooks-agent').inputValue(), 'codex');
  const configPath = path.join(projectDir, '.codex', 'hooks.json');
  assert.equal(await page.getByTestId('agent-hooks-destination').locator('code').innerText(), configPath);

  const installed = await installFromUi('Codex hook installed');
  assert.ok((await installed.innerText()).includes(configPath));
  const helperPath = path.join(dataDir, 'hooks', 'winmux-agent-hook.cjs');
  assert.equal(fs.lstatSync(configPath).isFile(), true);
  assert.equal(fs.lstatSync(helperPath).isFile(), true);
  const configBytes = fs.readFileSync(configPath);
  const helperBytes = fs.readFileSync(helperPath);
  assert.deepEqual(helperBytes, fs.readFileSync(path.join(root, 'electron', 'hooks', 'winmux-agent-hook.cjs')));
  const hooks = JSON.parse(configBytes).hooks;
  for (const event of ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd']) {
    assert.equal(hooks[event].length, 1, `${event} must have exactly one installed handler group.`);
    assert.equal(hooks[event][0].hooks[0].statusMessage, 'Winmux Codex activity [winmux-owned]');
  }
  const command = hooks.SessionStart[0].hooks[0].commandWindows;
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
  assert.ok(encoded, 'The installed Windows hook must use an encoded PowerShell argument.');
  const invocation = Buffer.from(encoded[1], 'base64').toString('utf16le');
  const selectedNode = /& '((?:[^']|'')+)'/.exec(invocation)?.[1].replace(/''/g, "'");
  assert.ok(selectedNode && path.isAbsolute(selectedNode), 'Production lookup must select an absolute system Node path.');
  assert.equal(path.basename(selectedNode).toLowerCase(), 'node.exe');
  assert.doesNotMatch(selectedNode, /\\(?:electron[^\\]*|temp|tmp)\\/i);
  assert.equal(fs.statSync(selectedNode).isFile(), true);
  assert.ok(invocation.includes(helperPath));
  assert.ok(invocation.includes(dataDir));
  const configModified = fs.statSync(configPath).mtimeMs;
  const helperModified = fs.statSync(helperPath).mtimeMs;

  const repeated = await installFromUi('Codex hook already installed');
  assert.deepEqual(fs.readFileSync(configPath), configBytes);
  assert.deepEqual(fs.readFileSync(helperPath), helperBytes);
  assert.equal(fs.statSync(configPath).mtimeMs, configModified);
  assert.equal(fs.statSync(helperPath).mtimeMs, helperModified);
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['hooks.json']);
  await repeated.scrollIntoViewIfNeeded();
  const integrationsImage = path.join(artifacts, 'agent-integrations.png');
  await page.screenshot({
    path: integrationsImage,
    style: '.xterm { visibility: hidden !important; }',
    mask: [page.getByTestId('agent-hooks-destination').locator('code'), repeated.locator('p').first()],
    maskColor: '#30363d',
  });

  await page.keyboard.press('Escape');
  await page.locator('.preferences-modal').waitFor({ state: 'detached' });
  const imagePath = path.join(root, 'build', 'icon.png');
  const preview = await rpc('file.open', { paneId: pane.id, path: imagePath });
  assert.equal(preview.kind, 'image');
  assert.equal(preview.name, 'icon.png');
  assert.equal(preview.paneId, pane.id);
  assert.equal(preview.workspaceId, workspace.id);
  const modal = page.locator('.local-file-preview-modal');
  await modal.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector('.local-file-preview-modal img');
    return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  });
  const dimensions = await modal.getByTestId('local-file-image').evaluate(image => ({
    width: image.naturalWidth, height: image.naturalHeight,
  }));
  const previewImage = path.join(artifacts, 'file-preview.png');
  await page.screenshot({
    path: previewImage,
    style: '.xterm { visibility: hidden !important; }',
    mask: [modal.locator('.local-file-preview-meta code')],
    maskColor: '#30363d',
  });
  assert.deepEqual(rendererErrors, [], `Renderer errors: ${rendererErrors.join('; ')}`);
  assert.equal(await page.locator('.error-banner').count(), 0);
  for (const image of [integrationsImage, previewImage]) assert.ok(fs.statSync(image).size > 0);
  return {
    status: 'passed',
    hookInstallation: 'installed, then unchanged through the real Settings button and main-process IPC',
    trustReview: 'Codex /hooks hint shown; no trust approval or hook execution performed',
    stableNode: selectedNode,
    imagePreview: dimensions,
    rendererErrors,
    screenshots: ['.artifacts/agent-integrations.png', '.artifacts/file-preview.png'],
  };
}

async function run() {
  let report;
  try {
    report = await main();
  } catch (error) {
    console.error(error.stack || error);
    console.error(`Disposable evidence: ${dataDir}`);
    process.exitCode = 1;
  } finally {
    await closeDesktop().catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
    if (fs.existsSync(path.join(dataDir, 'ipc-token'))) {
      const stopped = cli('shutdown');
      if (stopped.status !== 0) {
        console.error(`Disposable daemon shutdown failed: ${stopped.stderr || stopped.error?.message || stopped.stdout}`);
        process.exitCode = 1;
      }
    }
  }
  if (report && !process.exitCode) console.log(JSON.stringify(report, null, 2));
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
