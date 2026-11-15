'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { connect } = require('../electron/client.cjs');
const { planBindings, agentStateFor, findCodexDescendants, windowsProcessTable } = require('../electron/codex-integration.cjs');

const scratch = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hermes', 'cache', 'scratch');
fs.mkdirSync(scratch, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(scratch, 'winmux-title-mode-'));
const project = path.join(dataDir, 'project');
fs.mkdirSync(project, { recursive: true });
const pipeName = `\\\\.\\pipe\\winmux-title-${randomUUID()}`;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName, WINMUX_NO_PROFILE: '1' };
let daemon, client, logs = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(action, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await action()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
function mapping() {
  const processes = [
    { pid: 18464, ppid: 1, name: 'pwsh.exe', executable: 'C:/pwsh.exe', commandLine: 'pwsh' },
    { pid: 32944, ppid: 18464, name: 'cmd.exe', executable: 'C:/cmd.exe', commandLine: 'cmd' },
    { pid: 40000, ppid: 32944, name: 'codex.exe', executable: 'C:/Users/krach/.codex/bin/codex.exe', commandLine: 'codex' },
    { pid: 26684, ppid: 1, name: 'pwsh.exe', executable: 'C:/pwsh.exe', commandLine: 'pwsh' },
    { pid: 36332, ppid: 26684, name: 'cmd.exe', executable: 'C:/cmd.exe', commandLine: 'cmd' },
    { pid: 41000, ppid: 36332, name: 'codex.exe', executable: 'C:/Users/krach/.codex/bin/codex.exe', commandLine: 'codex' },
    { pid: 50000, ppid: 18464, name: 'codex.exe', executable: 'C:/Users/krach/.codex/bin/codex.exe', commandLine: 'codex app-server proxy' },
  ];
  assert.deepEqual(findCodexDescendants(18464, processes), [40000]);
  assert.deepEqual(findCodexDescendants(26684, processes), [41000]);
  const cwd = 'E:/projects/winmux';
  const threads = [
    { id: 'one', cwd, parentThreadId: null, sessionId: 's1', status: { type: 'active', activeFlags: [] } },
    { id: 'two', cwd, parentThreadId: null, sessionId: 's2', status: { type: 'idle' } },
    { id: 'child', cwd, parentThreadId: 'one', sessionId: 's1', status: { type: 'active', activeFlags: [] } },
  ];
  const panes = [
    { id: 'a', pid: 18464, status: 'running', cwd, codexPid: 40000 },
    { id: 'b', pid: 26684, status: 'running', cwd, codexPid: 41000 },
  ];
  const plans = planBindings({ panes, threads, loadedIds: ['one', 'two', 'child'] });
  assert(plans.every(plan => plan.action === 'ambiguous'), 'two loaded roots must not be guessed');
  const unique = planBindings({ panes: [panes[0]], threads: [threads[0], threads[2]], loadedIds: ['one', 'child'] });
  assert.equal(unique[0].action, 'auto'); assert.equal(unique[0].thread.id, 'one');
  assert.equal(agentStateFor('completed', { type: 'idle' }), 'completed');
  assert.equal(agentStateFor('running', { type: 'idle' }), 'idle');
  assert.equal(agentStateFor('running', { type: 'active', activeFlags: ['waitingOnUserInput'] }), 'waiting');
}
async function main() {
  mapping();
  daemon = spawn(process.execPath, [path.join(__dirname, '..', 'electron', 'backend.cjs')], { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', data => { logs += data; }); daemon.stderr.on('data', data => { logs += data; });
  await eventually(async () => {
    if (daemon.exitCode !== null) throw new Error(logs);
    try { client = await connect({ dataDir, pipeName, connectTimeout: 300 }); return true; } catch { return false; }
  }, 'daemon');
  const workspace = await client.request('workspace.create', { cwd: project, profileId: 'powershell' });
  assert.equal(workspace.tabs[0].titleMode, 'auto');
  const custom = await client.request('tab.create', { workspaceId: workspace.id, title: 'PowerShell 7', titleMode: 'custom' });
  assert.equal(custom.titleMode, 'custom'); assert.equal(custom.title, 'PowerShell 7');
  const generated = await client.request('tab.create', { workspaceId: workspace.id, title: 'Codex', titleMode: 'auto' });
  assert.equal(generated.titleMode, 'auto');
  await assert.rejects(client.request('tab.create', { workspaceId: workspace.id, titleMode: 'custom' }), error => error.code === 'INVALID_ARGUMENT');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert(saved.state.workspaces[0].tabs.some(tab => tab.title === 'PowerShell 7' && tab.titleMode === 'custom'));
  const table = await windowsProcessTable();
  const current = table.find(proc => proc.pid === process.pid);
  assert(current && current.ppid > 0, 'real CIM process table includes this test');
  console.log('PASS title modes persist and Codex mapping refuses an ambiguous cwd.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await client?.request('daemon.shutdown'); } catch {}
  client?.close();
  if (daemon && daemon.exitCode === null) await Promise.race([once(daemon, 'exit'), sleep(5000)]);
});
