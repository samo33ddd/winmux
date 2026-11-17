'use strict';
// Real ConPTY/WSL integration. Everything is isolated; only this test's daemon is stopped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Terminal } = require('@xterm/headless');
const { connect } = require('../electron/client.cjs');
const execFileAsync = promisify(execFile); // Run the CLI directly with argument arrays.
const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'winmux-smoke-'));
const stateFile = path.join(dataDir, 'state.json');
const reviewRepo = path.join(dataDir, 'review-repository');
const stateMaxBytes = 4 * 1024 * 1024;
const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\winmux-smoke-${randomUUID()}` : path.join(dataDir, 'ipc.sock');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WINMUX_NO_PROFILE: '1', WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName };
const options = { dataDir, pipeName };
let daemon, client, logs = '', shuttingDown = false;
const sockets = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const psQuote = text => `'${text.replace(/'/g, "''")}'`;
function clearReadOnly(target) {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) clearReadOnly(path.join(target, name));
  if ((stat.mode & 0o200) === 0) fs.chmodSync(target, stat.mode | 0o200);
}
function removeFixture(directory) {
  const gitObjects = path.join(directory, 'review-repository', '.git', 'objects');
  // Windows Git marks loose object files read-only; clear only this fixture's object tree before recursive removal.
  if (fs.existsSync(gitObjects)) clearReadOnly(gitObjects);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
function log(label, details = '') { console.log(`PASS ${label}${details ? ` — ${details}` : ''}`); }
async function eventually(action, label, timeout = 12000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const result = await action(); if (result) return result; } catch (error) { last = error; } await sleep(80); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}\nDaemon log:\n${logs.slice(-8000)}`);
}
async function launch() {
  daemon = spawn(process.execPath, [path.join(root, 'electron/backend.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', data => { logs = (logs + data).slice(-100000); });
  daemon.stderr.on('data', data => { logs = (logs + data).slice(-100000); });
  daemon.on('error', error => { logs += error.stack; });
  client = await eventually(async () => {
    if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${daemon.exitCode}`);
    try { return await connect({ ...options, connectTimeout: 500 }); } catch { return false; }
  }, 'daemon startup', 20000);
}
async function stop() {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit');
  try {
    const control = client || await connect(options);
    await control.request('daemon.shutdown'); control.close();
  } catch {}
  client?.close(); client = null;
  const graceful = await Promise.race([exited.then(() => true), sleep(4000).then(() => false)]);
  if (!graceful) { daemon.kill(); await Promise.race([exited, sleep(1500)]); }
  if (!shuttingDown) assert.ok(graceful, 'daemon must terminate after explicit shutdown');
}
async function cli(...args) {
  const result = await execFileAsync(process.execPath, [path.join(root, 'cli.cjs'), ...args], { cwd: root, env, timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
async function screenContains(paneId, marker) {
  return eventually(async () => { const screen = await client.request('pane.screen', { paneId }); return screen.text.includes(marker) && screen; }, `screen contains ${marker}`);
}
async function readPtyByte(paneId, byte, marker) {
  const command = `node -e "process.stdin.setRawMode(true); process.stdout.write('${marker}_' + 'READY\\n'); process.stdin.once('data', b => { console.log('${marker}_BYTE_' + b[0]); process.exit(0); })"\r`;
  await client.request('pane.input', { paneId, data: command });
  await screenContains(paneId, `${marker}_READY`);
  await client.request('pane.input', { paneId, data: byte });
  await screenContains(paneId, `${marker}_BYTE_${byte.charCodeAt(0)}`);
}
async function raw(frame) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName); sockets.add(socket); let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Raw socket timed out')); }, 4000);
    socket.setEncoding('utf8'); socket.on('connect', () => socket.write(frame)); socket.on('data', chunk => { text += chunk; });
    socket.on('error', () => {}); socket.on('close', () => { clearTimeout(timer); sockets.delete(socket); resolve(text); });
  });
}
async function run() {
  fs.mkdirSync(reviewRepo);
  await execFileAsync('git', ['init', reviewRepo], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['-C', reviewRepo, 'checkout', '-b', 'winmux/review-test'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['-C', reviewRepo, 'config', 'user.email', 'review@example.invalid'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['-C', reviewRepo, 'config', 'user.name', 'Winmux Review'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['-C', reviewRepo, 'commit', '--allow-empty', '-m', 'Initial review fixture'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['-C', reviewRepo, 'remote', 'add', 'origin', 'https://github.com/samo33ddd/winmux.git'], { cwd: root, windowsHide: true });
  const reviewSha = (await execFileAsync('git', ['-C', reviewRepo, 'rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 3,
    state: {
      workspaces: [],
      projects: [{ id: 'review-project', name: 'Winmux review', root: reviewRepo, profileId: 'powershell', primaryBranch: 'main' }],
      tasks: [{
        id: 'review-task', name: 'Review task', projectId: 'review-project', cwd: reviewRepo, branch: 'winmux/review-test',
        base: 'main', agentId: 'codex', managed: true, archived: false, phase: 'ready', deliverySupport: 'hooks',
        review: { sha: '0'.repeat(40), reviewer: 'Seed reviewer', summary: 'Seed evidence', outcome: 'approved', reviewedAt: 1 },
      }],
      notifications: [],
      settings: { fontSize: 14, theme: 'dark' },
    },
  }));
  await launch();
  const environment = await client.request('environment');
  assert.ok(environment.profiles.some(p => p.id === 'powershell'));
  assert.ok(environment.agents.some(agent => agent.id === 'claude' && typeof agent.available === 'boolean'));
  assert.equal((await client.request('state')).workspaces.length, 0);
  log('daemon startup + environment', `${process.versions.electron ? 'Electron ' + process.versions.electron : 'Node ' + process.version}; ${environment.profiles.map(p => p.id).join(', ')}`);

  await assert.rejects(client.request('task.delivery.review', {
    taskId: 'review-task', sha: reviewSha, reviewer: ' ', summary: 'Independent review', outcome: 'approved',
  }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.request('task.delivery.review', {
    taskId: 'review-task', sha: '1'.repeat(40), reviewer: 'Sol', summary: 'Stale review', outcome: 'approved',
  }), { code: 'STALE_HEAD' });
  await client.request('task.delivery.review', {
    taskId: 'review-task', sha: reviewSha, reviewer: 'Sol', summary: 'Changes requested', outcome: 'changes_requested',
  });
  await client.request('task.delivery.review', {
    taskId: 'review-task', sha: reviewSha, reviewer: 'Sol', summary: 'Independent approval', outcome: 'approved',
  });
  const recordedReview = (await client.request('task.delivery.context', { taskId: 'review-task' })).review;
  assert.equal(recordedReview.sha, reviewSha);
  assert.equal(recordedReview.outcome, 'approved');
  await stop();
  await launch();
  const restoredReview = (await client.request('task.delivery.context', { taskId: 'review-task' })).review;
  assert.deepEqual(restoredReview, recordedReview);
  log('task delivery review RPC validates current HEAD and survives daemon restart');

  for (const token of ['wrong', 'Ж'.repeat(64)]) {
    const reply = await raw(JSON.stringify({ id: 1, token, method: 'state' }) + '\n');
    assert.equal(JSON.parse(reply).error.code, 'UNAUTHORIZED');
  }
  const oversized = await raw('x'.repeat(300 * 1024)); assert.equal(oversized, '');
  await client.request('state'); log('unauthorized / malformed Unicode token / oversized frame isolation');
  await assert.rejects(client.request('workspace.create', { cwd: path.join(dataDir, 'missing') }), { code: 'INVALID_CWD' });
  await assert.rejects(client.request('workspace.create', { profileId: 'nonexistent' }), { code: 'PROFILE_UNAVAILABLE' });
  const longCwd = path.join(dataDir, 'b'.repeat(121));
  fs.mkdirSync(longCwd);
  const longWorkspace = await client.request('workspace.create', { cwd: longCwd });
  assert.equal(longWorkspace.name, 'b'.repeat(120));
  const whitespaceCwd = path.join(dataDir, `${' '.repeat(121)}Tail`);
  fs.mkdirSync(whitespaceCwd);
  const whitespaceWorkspace = await client.request('workspace.create', { cwd: whitespaceCwd });
  assert.equal(whitespaceWorkspace.name, 'Tail');
  await client.request('workspace.close', { workspaceId: whitespaceWorkspace.id });
  log('actual cwd and profile validation + bounded automatic workspace names');

  const workspace = JSON.parse(await cli('new', '--name', 'Backend smoke', '--cwd', dataDir));
  const pane = workspace.panes[0], pid = pane.pid;
  assert.equal(pane.status, 'running'); assert.ok(pid > 0);
  const prefix = randomUUID().slice(0, 8), marker = `WINMUX_READY_${prefix}`;
  const windows = process.platform === 'win32';
  await cli('send', pane.id, windows ? `Write-Output ('WINMUX_' + 'READY_${prefix}')` : `printf '%s%s\\n' WINMUX_ READY_${prefix}`);
  await cli('key', pane.id, 'Enter');
  await screenContains(pane.id, marker);
  assert.ok((await cli('read', pane.id)).includes(marker));
  log('real PTY + CLI new/send/key/read', `shell PID ${pid}`);

  await client.request('pane.resize', { paneId: pane.id, cols: 91, rows: 27 });
  const resized = await client.request('pane.snapshot', { paneId: pane.id });
  assert.equal(resized.cols, 91); assert.equal(resized.rows, 27);
  await assert.rejects(client.request('pane.resize', { paneId: pane.id, cols: 999, rows: 27 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.request('pane.input', { paneId: pane.id, data: 'x'.repeat(65537) }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(client.request('pane.input', { paneId: pane.id, data: '🙂'.repeat(16385) }), { code: 'LIMIT_REACHED' });
  log('resize + input bounds');

  // Cursor movement, Unicode and alternate screen must be interpreted, not replayed as text.
  if (windows) {
    await client.request('pane.input', { paneId: pane.id, data: "Write-Output ('NUL_KEY_' + 'READY'); $k=[Console]::ReadKey($true); Write-Output ('NUL_KEY_' + [int]$k.KeyChar)\r" });
    await screenContains(pane.id, 'NUL_KEY_READY');
    await client.request('pane.input', { paneId: pane.id, data: '\0' });
    await screenContains(pane.id, 'NUL_KEY_0');
    await readPtyByte(pane.id, '\x01', 'SOH');
    log('real ConPTY NUL console-key event and SOH byte delivery');
    await client.request('pane.input', { paneId: pane.id, data: '[Console]::Write("`e[?1049h`e[2J`e[HOLD`e[HNEW`e[2;1H" + [char]0x0416 + [char]0x6F22 + [char]::ConvertFromUtf32(0x1F642) + "`r`n")\r' });
    await screenContains(pane.id, 'Ж漢🙂');
    const alternate = await client.request('pane.screen', { paneId: pane.id }); assert.ok(alternate.text.includes('NEW')); assert.ok(!alternate.text.includes('OLD'));
    const alternateSnapshot = await client.request('pane.snapshot', { paneId: pane.id });
    const terminal = new Terminal({ cols: 91, rows: 27, allowProposedApi: true });
    await new Promise(resolve => terminal.write(alternateSnapshot.data, resolve));
    assert.equal(terminal.buffer.active.type, 'alternate'); terminal.dispose();
    await client.request('pane.input', { paneId: pane.id, data: '[Console]::Write("`e[?1049l")\r' });
    await eventually(async () => !(await client.request('pane.snapshot', { paneId: pane.id })).data.includes('\x1b[?1049h'), 'leave alternate screen');
    log('VT cursor updates + Unicode + serialized alternate screen');
  }

  const events = []; const record = event => { if (event.type === 'output' && event.paneId === pane.id) events.push(event); };
  client.on('event', record);
  const floodEnd = `STREAM_DONE_${prefix}`;
  await client.request('pane.input', { paneId: pane.id, data: windows ? `1..90 | ForEach-Object { [Console]::WriteLine(('row-' + $_)); Start-Sleep -Milliseconds 8 }; Write-Output ('STREAM_' + 'DONE_${prefix}')\r` : `for i in $(seq 1 90); do printf 'row-%s\\n' "$i"; sleep .008; done; printf '%s%s\\n' STREAM_ DONE_${prefix}\r` });
  await sleep(160);
  const snapshot = await client.request('pane.snapshot', { paneId: pane.id });
  await screenContains(pane.id, floodEnd); await sleep(250);
  const finalSnapshot = await client.request('pane.snapshot', { paneId: pane.id });
  const actualScreen = await client.request('pane.screen', { paneId: pane.id });
  client.removeListener('event', record);
  const replay = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 1000, allowProposedApi: true });
  await new Promise(resolve => replay.write(snapshot.data, resolve));
  const remaining = events.filter(event => event.seq > snapshot.seq && event.seq <= finalSnapshot.seq);
  assert.ok(remaining.length > 0, 'snapshot must be taken during live stream');
  for (let i = 0; i < remaining.length; i++) { assert.equal(remaining[i].seq, snapshot.seq + i + 1); await new Promise(resolve => replay.write(remaining[i].data, resolve)); }
  assert.equal(remaining.at(-1).seq, finalSnapshot.seq);
  const buffer = replay.buffer.active, lines = [];
  for (let y = 0; y < replay.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '');
  assert.equal(lines.join('\n'), actualScreen.text); replay.dispose();
  log('live snapshot fence + contiguous output sequence + exact reconstructed screen', `${remaining.length} post-snapshot chunks`);

  if (windows) {
    await client.request('pane.input', { paneId: pane.id, data: "Start-Sleep -Seconds 20; Write-Output ('UNEXPECTED_' + 'COMPLETION')\r" });
    await sleep(250); await cli('key', pane.id, 'Ctrl+C');
    await eventually(async () => (await client.request('pane.screen', { paneId: pane.id })).text.trimEnd().endsWith('>'), 'prompt after Ctrl+C');
    await client.request('pane.input', { paneId: pane.id, data: "Write-Output ('INTERRUPT_' + 'OK')\r" });
    await screenContains(pane.id, 'INTERRUPT_OK');
    assert.ok(!(await client.request('pane.screen', { paneId: pane.id })).text.includes('UNEXPECTED_COMPLETION'));
    log('Ctrl+C interrupts running work and returns to an interactive shell');
  }

  let closeEmitted = false; client.once('close', () => { closeEmitted = true; }); client.close();
  await sleep(150); assert.ok(closeEmitted); client = await connect(options);
  const reattached = JSON.parse(await cli('list')).workspaces.find(w => w.id === workspace.id).panes[0];
  assert.equal(reattached.pid, pid); assert.equal(reattached.status, 'running');
  await screenContains(pane.id, floodEnd); log('client disconnect/reconnect preserves PID + screen; close event');

  const second = JSON.parse(await cli('split', pane.id, 'vertical'));
  let current = (await client.request('state')).workspaces.find(w => w.id === workspace.id);
  assert.equal(current.root.direction, 'vertical');
  const movingTab = await client.request('tab.create', { workspaceId:workspace.id, sourcePaneId:pane.id });
  const movedPane = (await client.request('state')).workspaces.find(w => w.id === workspace.id).panes.find(p => p.id === movingTab.root.paneId);
  await client.request('pane.input', { paneId:movedPane.id, data:windows ? "Write-Output ('MOVE_' + 'READY')\r" : "printf 'MOVE_%s\\n' READY\r" });
  await screenContains(movedPane.id, 'MOVE_READY');
  const layoutBeforeInvalid = JSON.stringify((await client.request('state')).workspaces.map(w => w.tabs));
  for (const params of [
    { paneId:pane.id, targetPaneId:pane.id, side:'left' },
    { paneId:pane.id, targetPaneId:longWorkspace.panes[0].id, side:'left' },
    { paneId:pane.id, targetPaneId:second.id, side:'middle' },
    { paneId:pane.id, targetPaneId:'missing', side:'right' },
  ]) await assert.rejects(client.request('pane.move', params));
  assert.equal(JSON.stringify((await client.request('state')).workspaces.map(w => w.tabs)), layoutBeforeInvalid);
  const moved = await client.request('pane.move', { paneId:movedPane.id, targetPaneId:second.id, side:'right' });
  assert.equal(moved.workspaceId, workspace.id);
  current = (await client.request('state')).workspaces.find(w => w.id === workspace.id);
  assert.equal(current.tabs.length, 1);
  assert.equal(current.panes.find(p => p.id === movedPane.id).pid, movedPane.pid);
  await client.request('pane.move', { paneId:movedPane.id, targetPaneId:pane.id, side:'top' });
  current = (await client.request('state')).workspaces.find(w => w.id === workspace.id);
  assert.equal(current.root.first.first.paneId, movedPane.id);
  assert.equal(current.panes.find(p => p.id === pane.id).pid, pid);
  assert.equal(current.panes.find(p => p.id === second.id).pid, second.pid);
  await screenContains(movedPane.id, 'MOVE_READY');
  log('same-tab and cross-tab pane.move preserve IDs, PIDs and output; invalid moves leave layouts unchanged');
  await client.request('layout.ratio', { workspaceId: workspace.id, splitId: current.root.id, ratio: 0.62 });
  await cli('rpc', 'workspace.rename', JSON.stringify({ workspaceId: workspace.id, name: 'Restored workspace' }));
  await client.request('settings.update', { theme: 'light', fontSize: 16, activeWorkspaceId: workspace.id });
  let notification = JSON.parse(await cli('notify', pane.id, '--title', 'CLI notification', '--body', 'Ready'));
  await client.request('notifications.read', { id: notification.id });
  assert.ok((await client.request('state')).notifications.find(n => n.id === notification.id).read);
  if (windows) {
    await client.request('pane.input', { paneId: pane.id, data: '[Console]::Write("`e]777;notify;OSC smoke;Ready`a")\r' });
    await eventually(async () => (await client.request('state')).notifications.some(n => n.title === 'OSC smoke'), 'OSC notification');
  }
  log('split/layout/rename/settings/CLI notifications/OSC');

  const escapedBody = '\x01'.repeat(4096);
  for (let index = 0; index < 200; index++) {
    await client.request('notify', { paneId: pane.id, title: `Escaped ${index}`, body: escapedBody });
  }
  const escapedNotifications = (await client.request('state')).notifications;
  assert.ok(escapedNotifications.length > 0 && escapedNotifications.length < 200);
  assert.ok(escapedNotifications.every(notification => notification.body.length <= 4096));
  assert.ok(fs.statSync(stateFile).size <= stateMaxBytes);
  log('escaped notification history retained within serialized byte budget', `${escapedNotifications.length} notifications`);
  notification = await client.request('notify', { paneId:pane.id, title:'Retained after budget', body:'Ready' });
  await client.request('notifications.read', { id:notification.id });

  const wsl = environment.profiles.find(p => p.environment === 'wsl');
  if (wsl) {
    const linux = await client.request('workspace.create', { name: 'WSL smoke', profileId: wsl.id, cwd: '~' });
    const linuxPane = linux.panes[0]; assert.ok(linuxPane.cwd.startsWith('/'));
    await client.request('pane.input', { paneId: linuxPane.id, data: `printf '%s%s\\n' WINMUX_ WSL_${prefix}\r` });
    await screenContains(linuxPane.id, `WINMUX_WSL_${prefix}`);
    await client.request('pane.input', { paneId: linuxPane.id, data: "printf '\\033]9;WSL notification\\007'\r" });
    await eventually(async () => (await client.request('state')).notifications.some(n => n.paneId === linuxPane.id && n.body === 'WSL notification'), 'WSL OSC 9 notification');
    await assert.rejects(client.request('workspace.create', { profileId: wsl.id, cwd: '/winmux-nonexistent-directory' }), { code: 'INVALID_CWD' });
    await client.request('workspace.close', { workspaceId: linux.id });
    log('real WSL PTY + Linux cwd validation + OSC 9 notification', `${wsl.id}, ${linuxPane.cwd}`);
  } else console.log('SKIP WSL — no installed distribution discovered');

  const vanished = path.join(dataDir, 'vanished'); fs.mkdirSync(vanished);
  const missingWorkspace = await client.request('workspace.create', { name: 'Missing on restore', cwd: vanished });
  const oldSecondPid = second.pid;
  await stop();
  const legacyState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  legacyState.state.workspaces.find(workspace => workspace.id === longWorkspace.id).name = 'b'.repeat(121);
  for (let index = 0; index < 200; index++) {
    legacyState.state.notifications.push({
      id: randomUUID(), paneId: pane.id, workspaceId: workspace.id, title: `Legacy escaped ${index}`,
      body: escapedBody, createdAt: Date.now() + index, read: false,
    });
  }
  legacyState.state.notifications.push({ ...notification, read:true });
  fs.writeFileSync(stateFile, JSON.stringify(legacyState), 'utf8');
  assert.ok(fs.statSync(stateFile).size > stateMaxBytes);
  fs.rmdirSync(vanished);
  await launch();
  const restored = await client.request('state');
  current = restored.workspaces.find(w => w.id === workspace.id);
  const recoveredLongWorkspace = restored.workspaces.find(w => w.id === longWorkspace.id);
  assert.equal(recoveredLongWorkspace.name, 'b'.repeat(120));
  assert.ok(fs.statSync(stateFile).size <= stateMaxBytes);
  assert.ok(fs.readdirSync(dataDir).some(name => name.startsWith('state.json.recovery-')));
  assert.equal(current.name, 'Restored workspace'); assert.equal(current.panes.length, 3); assert.equal(current.root.ratio, 0.62);
  assert.equal(current.root.first.first.paneId, movedPane.id);
  assert.notEqual(current.panes.find(p => p.id === movedPane.id).pid, movedPane.pid);
  assert.equal(current.panes[0].id, pane.id); assert.notEqual(current.panes[0].pid, pid); assert.notEqual(current.panes[1].pid, oldSecondPid);
  assert.equal(restored.settings.theme, 'light'); assert.equal(restored.settings.fontSize, 16);
  assert.ok(restored.notifications.some(n => n.id === notification.id && n.read));
  const missingPane = restored.workspaces.find(w => w.id === missingWorkspace.id).panes[0];
  assert.equal(missingPane.status, 'exited'); assert.equal(missingPane.pid, null);
  assert.ok(restored.notifications.some(n => n.paneId === missingPane.id && n.title === 'Terminal could not be restored'));
  assert.ok(!(await client.request('pane.screen', { paneId: pane.id })).text.includes(floodEnd));
  log('daemon restart restores IDs/layout/settings/notifications with fresh shells; invalid cwd is visible');

  await client.request('pane.close', { paneId:movedPane.id });
  await client.request('pane.input', { paneId: second.id, data: 'exit 7\r' });
  await eventually(async () => (await client.request('state')).workspaces.find(w => w.id === workspace.id).panes.find(p => p.id === second.id).status === 'exited', 'process exit');
  const exitedPane = (await client.request('state')).workspaces.find(w => w.id === workspace.id).panes.find(p => p.id === second.id);
  assert.equal(exitedPane.exitCode, 7);
  await assert.rejects(client.request('pane.input', { paneId: second.id, data: 'x' }), { code: 'PANE_EXITED' });
  await client.request('pane.close', { paneId: second.id });
  assert.equal((await client.request('state')).workspaces.find(w => w.id === workspace.id).root.type, 'leaf');
  await client.request('pane.close', { paneId: pane.id });
  await client.request('workspace.close', { workspaceId: longWorkspace.id });
  await client.request('workspace.close', { workspaceId: missingWorkspace.id });
  assert.equal((await client.request('state')).workspaces.length, 0);
  log('exit code + closed-input rejection + split collapse + last pane removes workspace');
  await stop(); log('explicit shutdown exits the daemon');

  // #72: a stale daemon.lock whose PID is alive but has a different creation
  // time is PID reuse, not a live daemon — startup must proceed and never
  // signal the unrelated process. A matching creation time still blocks.
  const lockFile = path.join(dataDir, 'daemon.lock');
  const probe = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide:true });
  try {
    const fakeCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(lockFile, JSON.stringify({ pid:probe.pid, nonce:'stale', processCreatedAt:fakeCreatedAt }), { flag:'wx', mode:0o600 });
    await launch();
    assert.ok(probe.exitCode === null && !probe.killed, 'the reused-PID process must not be signalled');
    assert.match(fs.readFileSync(lockFile, 'utf8'), /processCreatedAt/, 'fresh lock records owner identity');
    log('stale lock with different creation time clears for reused PID; unrelated process untouched', `probe ${probe.pid}`);
    await stop();

    // Same recorded creation time as the live process still blocks startup.
    const selfCreatedAt = await new Promise(resolve => {
      const ps = spawn('powershell.exe', ['-NoLogo','-NoProfile','-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${probe.pid}").CreationDate.ToUniversalTime().ToString('o')`], { windowsHide:true });
      let out = ''; ps.stdout.on('data', chunk => out += chunk); ps.on('close', () => resolve(out.trim()));
    });
    if (selfCreatedAt && Number.isFinite(Date.parse(selfCreatedAt))) {
      fs.writeFileSync(lockFile, JSON.stringify({ pid:probe.pid, nonce:'stale', processCreatedAt:new Date(selfCreatedAt).toISOString() }), { flag:'wx', mode:0o600 });
      const blocked = spawn(process.execPath, [path.join(root, 'electron/backend.cjs')], { cwd:root, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
      const blockedExit = once(blocked, 'exit');
      const result = await Promise.race([blockedExit.then(code => `exit:${code}`), sleep(6000).then(() => 'running')]);
      if (result === 'running') blocked.kill();
      assert.ok(probe.exitCode === null, 'the owner process is never signalled');
      fs.unlinkSync(lockFile);
      log('matching creation time keeps DAEMON_RUNNING and never signals the owner');
    } else console.log('SKIP matching-identity check — process table unavailable');
  } finally { probe.kill(); }
}
const deadline = setTimeout(() => { console.error('FAIL backend smoke exceeded 150 seconds'); shuttingDown = true; client?.close(); for (const socket of sockets) socket.destroy(); daemon?.kill(); process.exit(1); }, 150000);
run().then(async () => {
  clearTimeout(deadline); removeFixture(dataDir);
  console.log('BACKEND_SMOKE_OK'); process.exit(0);
}).catch(async error => {
  console.error(error.stack); if (logs.trim()) console.error('Daemon output:\n' + logs.slice(-12000));
  shuttingDown = true; for (const socket of sockets) socket.destroy(); await stop().catch(() => {});
  clearTimeout(deadline); console.error(`Isolated evidence directory: ${dataDir}`); process.exit(1);
});
