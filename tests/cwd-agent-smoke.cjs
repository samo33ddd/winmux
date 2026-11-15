'use strict';
// Real isolated daemon + ConPTY; substitute only the discovery catalog with safe executables.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { connect } = require('../electron/client.cjs');
const { workspaceRequest } = require('../electron/workspace.cjs');
const { cwdFromOsc } = require('../electron/backend/shell-integration.cjs');
const root = path.resolve(__dirname, '..');
const linuxPath = value => '/mnt/' + value[0].toLowerCase() + value.slice(2).replace(/\\/g, '/');
const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const shQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--fixture-daemon')) {
  const discovery = require('../electron/backend/environment.cjs');
  const realDiscover = discovery.discover;
  discovery.discover = async () => {
    const environment = await realDiscover();
    environment.agents = environment.profiles.map(profile => ({
      id: `fixture:${profile.id}`, label: 'Safe fixture', profileId: profile.id, environment: profile.environment,
      available: true, command: profile.environment === 'wsl' ? linuxPath(path.join(process.env.WINMUX_FIXTURE_DIR, 'fixture.sh')) : path.join(process.env.WINMUX_FIXTURE_DIR, 'fixture.cmd'),
    }));
    environment.agents.push({ id: 'fixture:unavailable', available: false, profileId: 'powershell', environment: 'windows', command: null });
    for (const profile of environment.profiles) for (const adapter of ['claude', 'codex']) environment.agents.push({
      id: `hook:${profile.id}:${adapter}`, label: adapter, profileId: profile.id, environment: profile.environment,
      available: true, hookAdapter: adapter,
      command: profile.environment === 'wsl' ? linuxPath(path.join(process.env.WINMUX_FIXTURE_DIR, 'hooks.sh')) : path.join(process.env.WINMUX_FIXTURE_DIR, 'hooks.cmd'),
    });
    environment.agents.push({ id: 'fixture:missing', label: 'missing', available: true, profileId: 'powershell', environment: 'windows', command: path.join(process.env.WINMUX_FIXTURE_DIR, 'missing.exe') });
    return environment;
  };
  require('../electron/backend.cjs').startServer().then(daemon => {
    daemon.server.once('close', () => setTimeout(() => process.exit(0), 150).unref());
    console.log('FIXTURE_DAEMON_READY');
  }).catch(error => { console.error(error); process.exit(1); });
} else {
  const scratch = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch') : process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(scratch, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(scratch, 'winmux-cwd-agent-'));
  const fixture = path.join(dataDir, "agent's space Ж");
  const project = path.join(dataDir, 'project');
  const childDir = path.join(project, "child's space Ж漢 #%");
  const outside = path.join(dataDir, 'outside');
  for (const dir of [fixture, childDir, outside]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'fixture.cmd'), '@echo off\r\necho run>>"%~dp0windows-runs.txt"\r\necho SAFE_AGENT_STARTED\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(fixture, 'fixture.sh'), '#!/bin/bash\nprintf "run\\n" >> "$(dirname -- "$0")/wsl-runs.txt"\nprintf "SAFE_AGENT_STARTED\\n"\n');
  fs.writeFileSync(path.join(fixture, 'hooks.cmd'), `@echo off\r\nif defined ELECTRON_RUN_AS_NODE exit /b 91\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "%~dp0hooks.cjs" %*\r\nexit /b %errorlevel%\r\n`);
  fs.writeFileSync(path.join(fixture, 'hooks.sh'), `#!/bin/bash\nif [ "\${ELECTRON_RUN_AS_NODE+x}" = x ]; then exit 91; fi\nELECTRON_RUN_AS_NODE=1 WSLENV="\${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE" ${shQuote(linuxPath(process.execPath))} ${shQuote(path.join(fixture, 'hooks.cjs'))} "$@"\n`);
  fs.writeFileSync(path.join(fixture, 'hooks.cjs'), String.raw`
const fs = require('node:fs'), path = require('node:path');
const base = path.join(process.env.WINMUX_DATA_DIR, 'hook-' + process.env.WINMUX_PANE_ID);
const env = Object.fromEntries(['WINMUX_DATA_DIR', 'WINMUX_PIPE_NAME', 'WINMUX_PANE_ID', 'WINMUX_AGENT_LAUNCH_ID', 'ELECTRON_RUN_AS_NODE', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER'].map(key => [key, process.env[key]]));
fs.writeFileSync(base + '.json', JSON.stringify({ args: process.argv.slice(2), env }));
console.log('SAFE_HOOK_FIXTURE');
setInterval(() => { if (fs.existsSync(base + '.exit')) process.exit(Number(fs.readFileSync(base + '.exit', 'utf8'))); }, 50);
`);
  const electronFixture = path.join(fixture, 'electron-app');
  fs.mkdirSync(electronFixture);
  fs.writeFileSync(path.join(electronFixture, 'package.json'), JSON.stringify({ name: 'winmux-electron-fixture', main: 'main.cjs' }));
  fs.writeFileSync(path.join(electronFixture, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path');
app.setPath('userData', path.join(__dirname, 'user-data'));
app.whenReady().then(() => {
  fs.writeFileSync(path.join(__dirname, 'ready.json'), JSON.stringify({ ready: app.isReady(), electron: process.versions.electron, runAsNode: process.env.ELECTRON_RUN_AS_NODE }));
  console.log('WINMUX_ELECTRON_APP_READY');
  app.quit();
});
`);
  fs.writeFileSync(path.join(project, 'root-only.txt'), 'root');
  fs.writeFileSync(path.join(childDir, 'inside.txt'), 'before\n');
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
  execFileSync('git', ['-C', project, 'init', '-b', 'main'], { windowsHide: true });
  execFileSync('git', ['-C', project, 'add', '.'], { windowsHide: true });
  fs.writeFileSync(path.join(childDir, 'inside.txt'), 'after Ж\n');
  fs.writeFileSync(path.join(childDir, 'new.txt'), 'untracked inside\n');
  fs.writeFileSync(path.join(project, 'root-only.txt'), 'root changed');
  fs.symlinkSync(outside, path.join(childDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\winmux-cwd-agent-${randomUUID()}` : path.join(dataDir, 'ipc.sock');
  const options = { dataDir, pipeName };
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName, WINMUX_FIXTURE_DIR: fixture, WINMUX_NO_PROFILE: '1',
    WSLENV: [process.env.WSLENV, 'eLeCtRoN_rUn_As_NoDe'].filter(Boolean).join(':') };
  // Windows environment lookup is case-insensitive, but object keys need not be.
  if (process.platform === 'win32') { delete env.ELECTRON_RUN_AS_NODE; env.eLeCtRoN_rUn_As_NoDe = '1'; }
  let daemon, client, logs = '';
  const events = [];
  async function eventually(action, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await action()) return; await sleep(100); }
    throw new Error(`Timed out: ${label}\n${logs}`);
  }
  async function launch() {
    daemon = spawn(process.execPath, [__filename, '--fixture-daemon'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout.on('data', data => { logs += data; }); daemon.stderr.on('data', data => { logs += data; });
    await eventually(async () => {
      if (daemon.exitCode !== null) throw new Error(`Daemon exited ${daemon.exitCode}: ${logs}`);
      try { client = await connect({ ...options, connectTimeout: 300 }); return true; } catch { return false; }
    }, 'startup', 40000);
    client.on('event', event => { if (event.type === 'state') events.push(event); });
  }
  async function stop() {
    if (!daemon || daemon.exitCode !== null) return;
    const exited = once(daemon, 'exit');
    try { await client.request('daemon.shutdown'); } finally { client?.close(); }
    await Promise.race([exited, sleep(5000).then(() => { throw new Error('Isolated daemon did not stop'); })]);
  }
  const paneState = async id => (await client.request('state')).workspaces.flatMap(w => w.panes).find(p => p.id === id);
  const screen = async (id, marker) => eventually(async () => (await client.request('pane.screen', { paneId: id })).text.includes(marker), marker);
  const runs = name => fs.existsSync(path.join(fixture, name)) ? fs.readFileSync(path.join(fixture, name), 'utf8').trim().split(/\r?\n/).length : 0;
  async function checkHook(workspace, profile, adapter) {
    const isWsl = profile.environment === 'wsl';
    const tab = await client.request('tab.create', { workspaceId: workspace.id, profileId: profile.id,
      cwd: isWsl ? linuxPath(project) : project, agentId: `hook:${profile.id}:${adapter}`, agentHooks: true });
    const paneId = tab.root.paneId, base = path.join(dataDir, 'hook-' + paneId);
    await eventually(async () => {
      if (fs.existsSync(base + '.json')) return true;
      if ((await paneState(paneId)).agentState === 'failed') throw new Error((await client.request('pane.screen', { paneId })).text);
      return false;
    }, `${adapter} ${profile.id} launch args`);
    const captured = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    assert.equal(captured.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(captured.env.WINMUX_PIPE_NAME, pipeName);
    assert.equal((await paneState(paneId)).agentState, 'unknown', 'a live process is not evidence of agent activity');
    let commandFor;
    if (adapter === 'claude') {
      assert.equal(captured.args[0], '--settings');
      const config = JSON.parse(captured.args[1]);
      assert.deepEqual(config.hooks.Notification.map(item => item.matcher), ['permission_prompt', 'idle_prompt']);
      commandFor = event => config.hooks[event][0].hooks[0].command;
    } else {
      const { codexHookArgs } = require('../electron/backend/agent-hooks.cjs');
      assert.deepEqual(captured.args, codexHookArgs(profile), 'npm .cmd must preserve the complete TOML argument vector');
      assert(!captured.args.some(arg => /notify\s*=/.test(arg)));
      commandFor = event => {
        const arg = captured.args.find(arg => arg.startsWith(`hooks.${event}=`));
        const key = isWsl ? 'command=' : 'commandWindows=';
        return JSON.parse(arg.slice(arg.indexOf(key) + key.length).match(/^"(?:[^"\\]|\\.)*"/)[0]);
      };
    }
    const deliver = async (event, expected, extra = {}) => {
      const input = JSON.stringify({ hook_event_name: event, ...extra });
      let result;
      const helperEnv = { ...env, ...captured.env };
      for (const key of Object.keys(helperEnv)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete helperEnv[key];
      if (isWsl) {
        // Execute the generated Linux hook command, including real WSL->Windows interop.
        result = spawnSync(profile.command, [...profile.args, '--exec', '/bin/bash', '-c', commandFor(event)], {
          env: { ...helperEnv, WSLENV: ['WINMUX_DATA_DIR', 'WINMUX_PIPE_NAME', 'WINMUX_PANE_ID', 'WINMUX_AGENT_LAUNCH_ID', 'WINMUX_AGENT_NODE', 'WINMUX_AGENT_HELPER'].join(':') },
          input, encoding: 'utf8', timeout: 10000, windowsHide: true });
      } else result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(commandFor(event), 'utf16le').toString('base64')], {
        env: helperEnv, input, encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      await eventually(async () => (await paneState(paneId)).agentState === expected, `${profile.id} ${event}: ${expected}`);
    };
    await assert.rejects(client.request('agent.status', { paneId, state: 'running', launchId: 'stale' }), { code: 'STALE_AGENT_LAUNCH' });
    await assert.rejects(client.request('agent.status', { paneId, state: 'bogus', launchId: captured.env.WINMUX_AGENT_LAUNCH_ID }), { code: 'INVALID_ARGUMENT' });
    // The hook helper still requires the ordinary capability token on every request.
    const empty = path.join(dataDir, 'no-token'); fs.mkdirSync(empty, { recursive: true });
    const { report } = require('../electron/backend/agent-status.cjs');
    await assert.rejects(report('running', { ...captured.env, WINMUX_DATA_DIR: empty }), /IPC token/);
    assert.equal((await paneState(paneId)).agentState, 'unknown');
    await deliver('UserPromptSubmit', 'running'); await deliver('PermissionRequest', 'waiting');
    await deliver('PreToolUse', 'running'); await deliver('Stop', 'completed');
    // A completed turn does not end the launch; the next turn can run.
    await deliver('UserPromptSubmit', 'running');
    fs.writeFileSync(base + '.exit', '7');
    await eventually(async () => (await paneState(paneId)).agentExitCode === 7, 'actual agent exit code');
    assert.equal((await paneState(paneId)).agentState, 'failed'); assert.equal((await paneState(paneId)).status, 'running');
    await checkShellEnv(paneId, isWsl);
    await assert.rejects(client.request('agent.status', { paneId, state: 'running', launchId: captured.env.WINMUX_AGENT_LAUNCH_ID }), { code: 'AGENT_NOT_ACTIVE' });
    await client.request('tab.close', { workspaceId: workspace.id, tabId: tab.id });
    console.log(`PASS ${profile.id} ${adapter}: exact hook argv, authenticated running/waiting/completed, stale rejection, exit failure, shell survives`);
  }
  async function checkShellEnv(paneId, isWsl) {
    const command = isWsl
      ? `if [ "\${ELECTRON_RUN_AS_NODE+x}" = x ]; then printf '%s%s\\n' ELECTRON_ENV_ LEAK; else printf '%s%s\\n' ELECTRON_ENV_ CLEAR; fi`
      : "if (Test-Path Env:ELECTRON_RUN_AS_NODE) { Write-Output ('ELECTRON_ENV_' + 'LEAK') } else { Write-Output ('ELECTRON_ENV_' + 'CLEAR') }";
    await client.request('pane.input', { paneId, data: command + '\r' });
    await eventually(async () => /ELECTRON_ENV_(CLEAR|LEAK)/.test((await client.request('pane.screen', { paneId })).text), 'Electron shell environment check');
    assert((await client.request('pane.screen', { paneId })).text.includes('ELECTRON_ENV_CLEAR'), 'pane shell must not inherit ELECTRON_RUN_AS_NODE');
  }
  async function checkElectronApp(paneId) {
    assert(process.versions.electron, 'Run this test with scripts/run-electron-node.cjs to exercise Electron helpers and app mode');
    // A pipeline makes interactive PowerShell wait for the GUI executable to exit.
    await client.request('pane.input', { paneId, data: `Push-Location -LiteralPath ${psQuote(electronFixture)}; try { & ${psQuote(process.execPath)} . | Out-Null } finally { Pop-Location }; Write-Output ('ELECTRON_APP_' + 'EXITED')\r` });
    await screen(paneId, 'ELECTRON_APP_EXITED');
    assert(fs.existsSync(path.join(electronFixture, 'ready.json')), 'electron . must reach app.whenReady()');
    const result = JSON.parse(fs.readFileSync(path.join(electronFixture, 'ready.json'), 'utf8'));
    assert.equal(result.ready, true); assert.equal(result.electron, process.versions.electron); assert.equal(result.runAsNode, undefined);
    console.log('PASS Electron app mode: electron . reaches app.whenReady() and quits without creating a window');
  }
  async function checkFiles(workspace, pane, isWsl) {
    const rpc = (method, extra = {}) => workspaceRequest(client, method, { workspaceId: workspace.id, paneId: pane.id, ...extra });
    const listing = await rpc('files.list');
    assert(listing.entries.some(e => e.name === 'inside.txt'));
    assert(!listing.entries.some(e => e.name === 'root-only.txt'));
    assert((await rpc('files.read', { path: 'inside.txt' })).text.includes('after Ж'));
    await assert.rejects(rpc('files.read', { path: '../root-only.txt' }), /inside/);
    await assert.rejects(rpc('files.read', { path: 'escape/outside.txt' }), /outside/i);
    await assert.rejects(rpc('git.diff', { path: 'escape/outside.txt' }), /outside/i);
    await assert.rejects(rpc('git.status', { paneId: 'wrong-pane' }), /belong/);
    const status = await rpc('git.status');
    assert.equal(status.available, true, status.error);
    assert(status.entries.some(e => e.path === 'inside.txt'));
    assert(!status.entries.some(e => e.path.includes('root-only') || e.path.startsWith('../')));
    assert((await rpc('git.diff', { path: 'inside.txt' })).text.includes('+after Ж'));
    assert((await rpc('git.diff', { path: 'new.txt' })).text.includes('untracked inside'));
    assert(!(await rpc('git.diff')).text.includes('root changed'));
    if (!isWsl) assert((await workspaceRequest(client, 'files.list', { workspaceId: workspace.id })).entries.some(e => e.name === 'root-only.txt'));
  }
  async function run() {
    assert.equal(cwdFromOsc('https://example.invalid/x', 'wsl'), null);
    assert.equal(cwdFromOsc('file://evil.invalid/x', 'wsl'), null);
    assert.equal(cwdFromOsc('file:///tmp/%00', 'wsl'), null);
    assert.equal(cwdFromOsc('file:///tmp/%ZZ', 'wsl'), null);
    await launch();
    const environment = await client.request('environment');
    assert.equal(environment.capabilities.liveCwd, true); assert.equal(environment.capabilities.agentLaunch, true);
    assert.equal(environment.capabilities.terminalTabs, true); assert.equal(environment.capabilities.agentStatus, true);
    assert.equal(environment.capabilities.protocolVersion, 2);
    await assert.rejects(client.request('workspace.create', { cwd: project, agentId: 'unknown' }), { code: 'AGENT_UNAVAILABLE' });
    await assert.rejects(client.request('workspace.create', { cwd: project, agentId: 'fixture:unavailable' }), { code: 'AGENT_UNAVAILABLE' });
    await assert.rejects(client.request('workspace.create', { cwd: project, agentId: 'bad\ncommand' }), { code: 'AGENT_UNAVAILABLE' });
    const workspace = await client.request('workspace.create', { cwd: project, agentId: 'fixture:powershell' });
    const pane = workspace.panes[0];
    await screen(pane.id, 'SAFE_AGENT_STARTED'); assert.equal(runs('windows-runs.txt'), 1);
    await eventually(async () => (await paneState(pane.id)).agentState === 'completed', 'agent completion from OSC');
    assert.equal((await paneState(pane.id)).agentExitCode, 0); assert.equal((await paneState(pane.id)).agentLabel, 'Safe fixture');
    await client.request('pane.input', { paneId: pane.id, data: `Set-Location -LiteralPath ${psQuote(childDir)}\r` });
    await eventually(async () => (await paneState(pane.id)).cwd === childDir, 'PowerShell Unicode cwd');
    assert(events.some(e => e.state.workspaces.flatMap(w => w.panes).some(p => p.id === pane.id && p.cwd === childDir)));
    await checkFiles(workspace, pane, false);
    const split = await client.request('pane.split', { paneId: pane.id, direction: 'vertical', agentId: 'fixture:powershell' });
    await screen(split.id, 'SAFE_AGENT_STARTED'); assert.equal(runs('windows-runs.txt'), 2); assert.equal(split.cwd, childDir);
    const plain = await client.request('pane.split', { paneId: pane.id, direction: 'horizontal' });
    await client.request('pane.input', { paneId: plain.id, data: "Write-Output ('PLAIN_' + 'SHELL_OK')\r" });
    await screen(plain.id, 'PLAIN_SHELL_OK'); assert.equal(runs('windows-runs.txt'), 2);
    await checkShellEnv(plain.id, false);
    await checkElectronApp(plain.id);
    await client.request('pane.input', { paneId: plain.id, data: "Start-Sleep -Seconds 20; Write-Output ('UNEXPECTED_' + 'COMPLETION')\r" });
    await sleep(250);
    await client.request('pane.input', { paneId: plain.id, data: '\x03' });
    // PowerShell flushes queued console input while handling Ctrl+C; wait for its prompt.
    await eventually(async () => (await client.request('pane.screen', { paneId: plain.id })).text.trimEnd().endsWith('>'), 'prompt after Ctrl+C');
    await client.request('pane.input', { paneId: plain.id, data: "Write-Output ('INTERRUPT_' + 'OK')\r" });
    await screen(plain.id, 'INTERRUPT_OK');
    const other = await client.request('workspace.create', { cwd: outside });
    await assert.rejects(workspaceRequest(client, 'files.list', { workspaceId: other.id, paneId: pane.id }), /belong/);
    client.close(); client = await connect(options); assert.equal((await paneState(pane.id)).pid, pane.pid);
    console.log('PASS PowerShell: immediate fixture launch, shell remains, live Unicode cwd/state, pane-scoped files/Git, containment, split inheritance, reconnect PID');
    const firstTab = workspace.activeTabId;
    const tab = await client.request('tab.create', { workspaceId: workspace.id, sourcePaneId: pane.id });
    assert.equal((await paneState(tab.root.paneId)).cwd, childDir); assert.equal((await paneState(tab.root.paneId)).agentId, undefined);
    assert.notEqual(tab.title, workspace.tabs[0].title);
    const original = (await client.request('state')).workspaces.find(w => w.id === workspace.id).tabs.find(t => t.id === firstTab);
    await client.request('layout.ratio', { workspaceId: workspace.id, splitId: original.root.id, ratio: 0.63 });
    const inactiveSplit = await client.request('pane.split', { paneId: pane.id, direction: 'vertical' });
    assert.equal(inactiveSplit.tabId, firstTab);
    await client.request('pane.close', { paneId: inactiveSplit.id });
    let current = (await client.request('state')).workspaces.find(w => w.id === workspace.id);
    assert.equal(current.activeTabId, tab.id); assert.deepEqual(current.root, tab.root);
    assert.equal(current.tabs.find(t => t.id === firstTab).root.ratio, 0.63);
    await client.request('tab.select', { workspaceId: workspace.id, tabId: firstTab });
    await client.request('tab.close', { workspaceId: workspace.id, tabId: tab.id });
    assert.equal((await paneState(pane.id)).pid, pane.pid);
    await assert.rejects(client.request('tab.create', { workspaceId: workspace.id, sourcePaneId: other.panes[0].id }), { code: 'NOT_FOUND' });
    const missing = await client.request('tab.create', { workspaceId: workspace.id, agentId: 'fixture:missing' });
    await eventually(async () => (await paneState(missing.root.paneId)).agentState === 'failed', 'missing executable failure');
    assert.equal((await paneState(missing.root.paneId)).agentExitCode, 1);
    await client.request('tab.close', { workspaceId: workspace.id, tabId: missing.id });
    for (const adapter of ['claude', 'codex']) await checkHook(workspace, environment.profiles.find(p => p.id === 'powershell'), adapter);
    console.log('PASS tab ownership: inactive split/ratio/close, live cwd inheritance, stable alias, scoped close, missing executable failure');
    const wsl = environment.profiles.find(p => p.environment === 'wsl');
    if (wsl) {
      execFileSync('wsl.exe', ['-d', wsl.distro, '--', 'chmod', '+x', linuxPath(path.join(fixture, 'fixture.sh'))], { windowsHide: true, timeout: 10000 });
      execFileSync('wsl.exe', ['-d', wsl.distro, '--', 'chmod', '+x', linuxPath(path.join(fixture, 'hooks.sh'))], { windowsHide: true, timeout: 10000 });
      for (const adapter of ['claude', 'codex']) await checkHook(workspace, wsl, adapter);
      await assert.rejects(client.request('workspace.create', { profileId: wsl.id, agentId: 'fixture:powershell' }), { code: 'AGENT_PROFILE_MISMATCH' });
      // Mixed-profile workspace proves pane profile, rather than workspace profile, drives files/Git.
      const linux = await client.request('pane.split', { paneId: pane.id, direction: 'vertical', profileId: wsl.id, cwd: linuxPath(project), agentId: `fixture:${wsl.id}` });
      await screen(linux.id, 'SAFE_AGENT_STARTED'); assert.equal(runs('wsl-runs.txt'), 1);
      await checkShellEnv(linux.id, true);
      await client.request('pane.input', { paneId: linux.id, data: `cd -- ${shQuote(linuxPath(childDir))}\r` });
      await eventually(async () => (await paneState(linux.id)).cwd === linuxPath(childDir), 'WSL Unicode cwd');
      await checkFiles(workspace, linux, true);
      console.log(`PASS WSL ${wsl.id}: safe agent launch, live Unicode cwd, mixed-profile files/Git and containment`);
    } else console.log('SKIP WSL: no distribution available');
    const expectedWindows = runs('windows-runs.txt'), expectedWsl = runs('wsl-runs.txt');
    await stop(); await launch();
    await client.request('pane.input', { paneId: pane.id, data: "Write-Output ('RECOVERY_' + 'SHELL_OK')\r" });
    await screen(pane.id, 'RECOVERY_SHELL_OK');
    assert.equal((await paneState(pane.id)).cwd, childDir);
    assert.equal(runs('windows-runs.txt'), expectedWindows); assert.equal(runs('wsl-runs.txt'), expectedWsl);
    assert.notEqual((await paneState(pane.id)).pid, pane.pid);
    assert.equal((await paneState(pane.id)).agentState, 'unknown'); assert.equal((await paneState(pane.id)).agentExitCode, undefined);
    assert.equal((await paneState(pane.id)).agentId, undefined); assert.equal((await paneState(pane.id)).agentLabel, undefined);
    console.log('PASS isolated daemon recovery: latest cwd preserved, fresh shell, no agent replay');
    await stop();
  }
  async function cleanup() {
    // Git creates read-only object files on Windows; clear only our fixture attributes.
    function writable(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) fs.unlinkSync(target);
        else if (entry.isDirectory()) writable(target);
        else fs.chmodSync(target, 0o666);
      }
    }
    writable(dataDir);
    await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const deadline = setTimeout(() => { console.error('CWD_AGENT_SMOKE_TIMEOUT'); client?.close(); daemon?.kill(); process.exit(1); }, 180000);
  run().then(async () => { await cleanup(); clearTimeout(deadline); console.log('CWD_AGENT_SMOKE_OK'); process.exit(0); }).catch(async error => {
    console.error(error.stack); console.error(logs); await stop().catch(() => daemon?.kill()); clearTimeout(deadline); console.error(`Evidence: ${dataDir}`); process.exit(1);
  });
}
