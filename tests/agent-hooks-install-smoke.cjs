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
const { withSessionHooks, codexHookArgs } = require('../electron/backend/agent-hooks.cjs');
const { readContextFile } = require('../electron/backend/agent-status.cjs');
const { shellArgs, windowsCommandLineLength } = require('../electron/backend/shell-integration.cjs');
const { codexUserPromptSubmitOutput } = require('../electron/backend/task-instructions.cjs');
const { validateLaunch } = require('../electron/backend/environment.cjs');

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

test('launch-time installation prepares a non-adapter agent without session hooks', { skip: process.platform !== 'win32' }, async t => {
  const root = temp('winmux-launch-hooks-');
  const dataDir = temp('winmux-launch-hooks-data-');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const environment = {
    profiles: [{ id: 'powershell', label: 'PowerShell', environment: 'windows', command: process.execPath, args: [] }],
    agents: [{ id: 'pi', label: 'pi', environment: 'windows', profileId: 'powershell', available: true, command: process.execPath }],
    defaultCwd: root,
  };
  const launch = await validateLaunch(environment, 'powershell', root, 'pi', true, {
    dataDir,
    pipeName: '\\\\.\\pipe\\winmux-launch-hooks-test',
  });
  assert.equal(launch.agentSessionHooks, false);
  assert.ok(fs.existsSync(path.join(root, '.pi', 'extensions', 'winmux-status.ts')));
});

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
  await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'unknown-agent' }, { dataDir, nodePath: process.execPath }), { code: 'UNSUPPORTED_AGENT' });
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

test('Codex UserPromptSubmit returns task context only for an authenticated root event', { skip: process.platform !== 'win32' }, async t => {
  const dataDir = temp('winmux-codex-task-context-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), token, { mode: 0o600 });
  const pipe = `\\\\.\\pipe\\winmux-codex-task-${crypto.randomBytes(6).toString('hex')}`;
  const received = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        received.push(request);
        const result = request.token === token
          ? { id: request.id, result: { applied: true } }
          : { id: request.id, error: { code: 'UNAUTHORIZED', message: 'no' } };
        socket.write(`${JSON.stringify(result)}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  t.after(() => server.close());
  const statusReports = () => received.filter(request => request.method === 'agent.status');

  const base = {
    version: 1,
    paneId: 'pane-context',
    launchId: 'launch-context',
    dataDir,
    pipeName: pipe,
  };
  const contextFile = path.join(dataDir, 'context.json');
  const helper = path.resolve(__dirname, '..', 'electron', 'backend', 'agent-status.cjs');
  async function run(event) {
    const child = spawn(process.execPath, [helper, '--codex', '--context-file', contextFile], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.resume();
    child.stdin.end(JSON.stringify(event));
    const [code] = await once(child, 'exit');
    return { code, stdout };
  }

  fs.writeFileSync(contextFile, JSON.stringify(base));
  const noTaskStart = await run({
    hook_event_name: 'SessionStart',
    prompt: 'secret prompt',
    transcript_path: 'C:\\secret\\transcript.jsonl',
  });
  assert.equal(noTaskStart.code, 0);
  assert.equal(noTaskStart.stdout, '');
  assert.equal(statusReports().length, 1);
  assert.equal(statusReports()[0].params.state, 'idle');
  assert.equal(JSON.stringify(statusReports()[0]).includes('secret'), false);

  const noTaskTurn = await run({ hook_event_name: 'UserPromptSubmit', prompt: 'secret prompt' });
  assert.equal(noTaskTurn.code, 0);
  assert.equal(noTaskTurn.stdout, '');
  assert.equal(statusReports().length, 2);
  assert.equal(statusReports()[1].params.state, 'running');

  fs.writeFileSync(contextFile, JSON.stringify({ ...base, taskId: 'task-context' }));
  const taskStart = await run({
    hook_event_name: 'SessionStart',
    prompt: 'secret prompt',
    transcript_path: 'C:\\secret\\transcript.jsonl',
  });
  assert.equal(taskStart.code, 0);
  assert.equal(taskStart.stdout, '');
  assert.equal(statusReports().length, 3);
  assert.equal(statusReports()[2].params.state, 'idle');

  const rootTurn = await run({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'secret prompt',
    transcript_path: 'C:\\secret\\transcript.jsonl',
  });
  assert.equal(rootTurn.code, 0);
  assert.deepEqual(JSON.parse(rootTurn.stdout), codexUserPromptSubmitOutput('task-context'));
  assert.match(JSON.parse(rootTurn.stdout).hookSpecificOutput.additionalContext, /task-context/);
  assert.equal(statusReports().length, 4);
  assert.equal(statusReports()[3].params.state, 'running');
  assert.equal(JSON.stringify(statusReports()[3]).includes('secret'), false);

  const repeatedTurn = await run({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(repeatedTurn.code, 0);
  assert.deepEqual(JSON.parse(repeatedTurn.stdout), codexUserPromptSubmitOutput('task-context'));
  assert.equal(statusReports().length, 5);

  const nested = await run({
    hook_event_name: 'UserPromptSubmit',
    parent_thread_id: 'parent-thread',
    prompt: 'secret nested prompt',
  });
  assert.equal(nested.code, 0);
  assert.equal(nested.stdout, '');
  assert.equal(statusReports().length, 5);

  const codexNested = await run({
    hook_event_name: 'UserPromptSubmit',
    agent_id: 'nested-agent',
    agent_type: 'worker',
    prompt: 'secret nested prompt',
  });
  assert.equal(codexNested.code, 0);
  assert.equal(codexNested.stdout, '');
  assert.equal(statusReports().length, 5);

  const stop = await run({ hook_event_name: 'Stop' });
  assert.equal(stop.code, 0);
  assert.equal(stop.stdout, '');
  assert.equal(statusReports().length, 6);
  assert.equal(statusReports()[5].params.state, 'completed');

  fs.writeFileSync(contextFile, JSON.stringify({ ...base, taskId: 'invalid task id' }));
  const malformed = await run({ hook_event_name: 'UserPromptSubmit' });
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stdout, '');
  assert.equal(statusReports().length, 6);
  assert.throws(() => readContextFile(contextFile), /context is invalid/);
});

test('Codex session hooks use bounded per-launch wrapper and context artifacts', { skip: process.platform !== 'win32' }, t => {
  const root = temp('winmux-hooks artifacts юникод ');
  const dataDir = path.join(root, 'data dir юникод');
  fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), 'capability-secret-sentinel');
  const context = {
    paneId: 'pane-explicit',
    launchId: 'launch-explicit',
    dataDir,
    pipeName: '\\\\.\\pipe\\winmux-fixture',
    taskId: 'task-explicit',
  };
  const profile = { environment: 'windows', command: process.execPath, args: ['-NoLogo', '-NoProfile', '-NoExit'] };
  const agent = withSessionHooks({ hookAdapter: 'codex', command: process.execPath, args: ['--existing', 'value with spaces'] }, profile, true, context);
  const args = shellArgs(profile, agent);
  const length = windowsCommandLineLength(profile.command, args);
  t.diagnostic(`Windows launch UTF-16 units: ${length}`);
  assert.ok(length < 30000, `Windows launch command line is ${length} UTF-16 units`);
  assert.deepEqual(agent.args.slice(0, 2), ['--existing', 'value with spaces']);
  assert.equal(agent.args.filter(value => value.startsWith('hooks.')).length, 7);
  assert(!agent.args.some(value => /developer_instructions|\bnotify\s*=/.test(value)));
  assert(fs.existsSync(agent.hookArtifacts.contextPath));
  assert(fs.existsSync(agent.hookArtifacts.wrapperPath));
  assert.deepEqual(readContextFile(agent.hookArtifacts.contextPath), { version: 1, ...context });
  assert.equal(fs.readFileSync(agent.hookArtifacts.contextPath, 'utf8').includes('capability-secret-sentinel'), false);
  const stop = agent.args.find(value => value.startsWith('hooks.Stop='));
  const command = JSON.parse(stop.slice(stop.indexOf('commandWindows=') + 'commandWindows='.length).match(/^"(?:[^"\\]|\\.)*"/)[0]);
  const encoded = command.slice(command.lastIndexOf(' ') + 1);
  assert(Buffer.from(encoded, 'base64').toString('utf16le').includes(agent.hookArtifacts.wrapperPath));
  agent.cleanupHooks();
  assert.equal(fs.existsSync(agent.hookArtifacts.contextPath), false);
  assert.equal(fs.existsSync(agent.hookArtifacts.wrapperPath), false);

  const wslProfile = { environment: 'wsl', command: 'wsl.exe', args: ['--distribution', 'Ubuntu'], distro: 'Ubuntu' };
  const wslContext = { ...context, launchId: 'launch-wsl-task' };
  const wslAgent = withSessionHooks({ hookAdapter: 'codex', command: '/usr/bin/codex', args: [] }, wslProfile, true, wslContext);
  assert.equal(wslAgent.hookArtifacts.wrapperPath, null);
  assert(fs.existsSync(wslAgent.hookArtifacts.contextPath));
  assert.deepEqual(readContextFile(wslAgent.hookArtifacts.contextPath), { version: 1, ...wslContext });
  const sessionStart = wslAgent.args.find(value => value.startsWith('hooks.SessionStart='));
  assert(sessionStart.includes('--context-file'));
  const wslCommand = JSON.parse(sessionStart.slice(sessionStart.indexOf('command=') + 'command='.length).match(/^"(?:[^"\\]|\\.)*"/)[0]);
  assert(wslCommand.includes(wslAgent.hookArtifacts.contextPath));
  wslAgent.cleanupHooks();
  assert.equal(fs.existsSync(wslAgent.hookArtifacts.contextPath), false);

  const noTaskAgent = withSessionHooks({ hookAdapter: 'codex', command: '/usr/bin/codex', args: [] }, wslProfile, true, {
    ...wslContext,
    launchId: 'launch-wsl-no-task',
    taskId: undefined,
  });
  assert.equal(noTaskAgent.hookArtifacts, null);
  assert.deepEqual(noTaskAgent.args, codexHookArgs(wslProfile));

  assert.throws(() => withSessionHooks(
    { hookAdapter: 'codex', command: process.execPath, args: [] },
    profile,
    true,
    { ...context, dataDir: `C:\\${'x'.repeat(1100)}` },
  ), { code: 'AGENT_HOOKS_CONTEXT' });
  assert.throws(() => withSessionHooks(
    { hookAdapter: 'codex', command: process.execPath, args: [] },
    profile,
    true,
    { ...context, taskId: 'invalid task id' },
  ), { code: 'AGENT_HOOKS_CONTEXT' });
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
  const child = spawn(process.execPath, [helper, '--data-dir', dataDir, '--pipe', pipe, '--pane-id', 'pane-explicit'], {
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
    paneId: 'pane-explicit',
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
