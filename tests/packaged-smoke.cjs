// Packaged-app smoke: launch the unpacked Winmux.exe and assert one IPC round
// trip plus a real workspace over the packaged binary. Catches packaging-only
// failures (missing files entries, ASAR-unpacked helpers, node-pty prebuild
// gaps) that the test matrix cannot see. Runs after `release:build` in CI.
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const root = path.resolve(__dirname, '..');
const exe = process.env.WINMUX_PACKAGED_EXE || path.join(root, 'release', 'win-unpacked', 'Winmux.exe');
const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'winmux-packaged-'));
const project = path.join(dataDir, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'hello.md'), '# Packaged preview\n');
const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_NO_PROFILE: '1', WINMUX_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, wrapper;
(async () => {
  assert(fs.existsSync(exe), `packaged executable missing: ${exe} (run npm run release:build first)`);
  desktop = await _electron.launch({ executablePath: exe, cwd: dataDir, env });
  const page = await desktop.firstWindow();
  const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.winmux.call(method, params), { method, params });
  await page.waitForFunction(() => !!window.winmux);
  const state = await rpc('state');
  assert.ok(state && Array.isArray(state.workspaces), 'packaged IPC state round trip failed');
  const workspace = await rpc('workspace.create', { name: 'Packaged verification', cwd: project, profileId: 'powershell' });
  assert.ok(workspace?.id, 'workspace.create returned no id');
  await rpc('skills.install', { workspaceId: workspace.id, agent: 'codex' });
  wrapper = path.join(project, '.agents', 'skills', 'winmux-terminal', 'scripts', 'winmux-client.cjs');
  const result = await execFile(process.execPath, [wrapper, 'list'], { cwd: dataDir, env, windowsHide: true, timeout: 20000 });
  assert(JSON.parse(result.stdout).workspaces.some(item => item.id === workspace.id), 'installed client cannot reach the packaged daemon');
  console.log('PASS packaged smoke: exe launches, IPC state round trips, workspace + installed client work.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (desktop) await desktop.close().catch(() => {});
  if (wrapper) await execFile(process.execPath, [wrapper, 'shutdown'], { cwd: dataDir, env, windowsHide: true, timeout: 20000 }).catch(() => {});
});
