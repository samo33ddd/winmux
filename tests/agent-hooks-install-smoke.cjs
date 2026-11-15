'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { installAgentHooks, OWNED_STATUS } = require('../electron/agent-hooks-install.cjs');
const { locations } = require('../electron/backend/shared.cjs');

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixture(cwd) {
  return {
    async request(method) {
      if (method === 'state') return { workspaces: [{ id: 'workspace-1', cwd, profileId: 'powershell', panes: [{ id: 'pane-1' }] }] };
      if (method === 'environment') return { profiles: [{ id: 'powershell', environment: 'windows', available: true }] };
      throw new Error(`unexpected ${method}`);
    },
  };
}

function readHooks(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));
}

test('merges, backups, and repeats without losing foreign hooks', async t => {
  const root = temp('winmux-hooks-project-');
  const dataDir = temp('winmux-hooks-data-');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.codex'));
  const original = {
    description: 'keep me',
    hooks: {
      Stop: [{ matcher: 'keep', hooks: [{ type: 'command', command: 'foreign' }] }],
    },
  };
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), JSON.stringify(original));
  const nodePath = process.execPath;
  const first = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'codex', paneId: 'pane-1' }, { dataDir, nodePath });
  assert.equal(first.status, 'updated');
  assert.equal(first.requiresTrustReview, true);
  assert.equal(fs.existsSync(first.backupPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.backupPath, 'utf8')), original);
  const merged = readHooks(root);
  assert.equal(merged.description, 'keep me');
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'foreign');
  assert.equal(merged.hooks.Stop[1].hooks[0].statusMessage, OWNED_STATUS);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].commandWindows, merged.hooks.SessionStart[0].hooks[0].command);
  const second = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'codex' }, { dataDir, nodePath });
  assert.equal(second.status, 'unchanged');
  assert.equal(second.backupPath, undefined);
  assert.deepEqual(readHooks(root), merged);
});

test('rejects a symlink, bad JSON, and a non-Windows profile without writing', async t => {
  const root = temp('winmux-hooks-reject-');
  const dataDir = temp('winmux-hooks-data-');
  const outside = temp('winmux-hooks-outside-');
  t.after(() => {
    for (const directory of [root, dataDir, outside]) fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.codex'));
  const link = path.join(root, '.codex', 'hooks.json');
  try {
    fs.symlinkSync(outside, link, 'file');
    if (fs.lstatSync(link).isSymbolicLink()) {
      await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'codex' }, { dataDir, nodePath: process.execPath }), { code: 'CONFIG_UNSAFE' });
    }
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  }
  fs.rmSync(link, { force: true });
  fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), '{');
  await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'codex' }, { dataDir, nodePath: process.execPath }), { code: 'CONFIG_INVALID' });
  assert.equal(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'), '{');
  const wsl = {
    async request(method) {
      if (method === 'state') return { workspaces: [{ id: 'workspace-1', cwd: root, profileId: 'wsl:Ubuntu', panes: [] }] };
      if (method === 'environment') return { profiles: [{ id: 'wsl:Ubuntu', environment: 'wsl', available: true }] };
      throw new Error(method);
    },
  };
  await assert.rejects(() => installAgentHooks(wsl, { workspaceId: 'workspace-1', agent: 'codex' }, { dataDir, nodePath: process.execPath }), { code: 'UNSUPPORTED_ENVIRONMENT' });
  await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'claude' }, { dataDir, nodePath: process.execPath }), { code: 'UNSUPPORTED_AGENT' });
});

test('helper delivers a bounded authenticated agent.hook and drops prompt content', async t => {
  const dataDir = temp('winmux-hooks-ipc-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const token = fs.readFileSync(path.join(dataDir, 'ipc-token'), 'utf8').trim();
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\winmux-hook-test-${crypto.randomBytes(6).toString('hex')}`
    : path.join(dataDir, 'hook.sock');
  const received = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const line = buffer.slice(0, buffer.indexOf('\n'));
      const request = JSON.parse(line);
      received.push(request);
      const ok = request.token === token && request.method === 'agent.hook';
      socket.end(`${JSON.stringify({ id: request.id, ...(ok ? { result: { applied: true } } : { error: { code: 'UNAUTHORIZED', message: 'no' } }) })}\n`);
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  t.after(() => server.close());
  const helper = path.resolve(__dirname, '..', 'electron', 'hooks', 'winmux-agent-hook.cjs');
  const child = spawn(process.execPath, [helper, '--data-dir', dataDir, '--pipe', pipe], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(JSON.stringify({
    session_id: 'thr_123',
    cwd: 'E:\\Проект\\workspace',
    hook_event_name: 'Stop',
    prompt: 'secret prompt',
    tool_input: { command: 'secret command' },
    transcript_path: 'C:\\secret\\transcript.jsonl',
  }));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].params.agentId, 'codex');
  assert.equal(received[0].params.event, 'Stop');
  assert.equal(received[0].params.sessionId, 'thr_123');
  assert.equal(received[0].params.cwd, 'E:\\Проект\\workspace');
  assert.equal(Object.hasOwn(received[0].params, 'paneId'), false);
  assert.equal(JSON.stringify(received[0]).includes('secret'), false);
});

test('native helper ignores a stale WINMUX_PANE_ID from the shared daemon', async t => {
  const dataDir = temp('winmux-hooks-stale-pane-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\winmux-hook-stale-${crypto.randomBytes(6).toString('hex')}`
    : path.join(dataDir, 'hook.sock');
  const received = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      received.push(request);
      socket.end(`${JSON.stringify({ id: request.id, result: { applied: true } })}\n`);
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  t.after(() => server.close());
  const helper = path.resolve(__dirname, '..', 'electron', 'hooks', 'winmux-agent-hook.cjs');
  const child = spawn(process.execPath, [helper, '--data-dir', dataDir, '--pipe', pipe], {
    windowsHide: true,
    env: { ...process.env, WINMUX_PANE_ID: 'stale-pane' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify({
    session_id: 'thr_other',
    cwd: 'E:\\other\\workspace',
    hook_event_name: 'Stop',
  }));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.deepEqual(received[0].params, {
    agentId: 'codex',
    event: 'Stop',
    sessionId: 'thr_other',
    cwd: 'E:\\other\\workspace',
  });
});

test('generated command survives cmd.exe quoting, spaces, Unicode, and metacharacters', async t => {
  const root = temp('winmux-hooks-quote-');
  const project = path.join(root, "pro ject & '%VAR%'");
  const dataDir = path.join(root, 'data dir & %NOT_A_VAR% юникод');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(project);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const token = fs.readFileSync(path.join(dataDir, 'ipc-token'), 'utf8').trim();
  const pipe = locations({ dataDir }).pipeName;
  const received = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const line = buffer.slice(0, buffer.indexOf('\n'));
      const request = JSON.parse(line);
      received.push(request);
      socket.end(`${JSON.stringify({ id: request.id, result: { applied: request.token === token } })}\n`);
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  t.after(() => server.close());
  const installed = await installAgentHooks(fixture(project), { workspaceId: 'workspace-1', agent: 'codex' }, {
    dataDir,
    nodePath: process.execPath,
  });
  const command = readHooks(project).hooks.Stop[0].hooks[0].commandWindows;
  assert.equal(command.includes('--pipe'), false);
  assert.equal(installed.helperPath.includes(dataDir), true);
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: project,
    env: { ...process.env, VAR: 'expanded-sentinel', NOT_A_VAR: 'expanded-sentinel' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.stdin.end(JSON.stringify({ session_id: 'thr_quoted', cwd: project, hook_event_name: 'SessionStart' }));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `generated commandWindows failed under cmd.exe: ${command}\n${stderr}`);
  assert.equal(received[0].params.sessionId, 'thr_quoted');
  assert.equal(received[0].params.cwd, project);
  assert.equal(received[0].token, token);

  fs.writeFileSync(installed.helperPath, 'user owned helper\n');
  await assert.rejects(() => installAgentHooks(fixture(project), { workspaceId: 'workspace-1', agent: 'codex' }, {
    dataDir,
    nodePath: process.execPath,
  }), { code: 'HELPER_UNOWNED' });
  assert.equal(fs.readFileSync(installed.helperPath, 'utf8'), 'user owned helper\n');
});
