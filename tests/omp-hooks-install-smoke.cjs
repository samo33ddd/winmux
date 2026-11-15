'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const {
  installAgentHooks,
  OMP_EXTENSION_MARKER,
  OMP_HELPER_MARKER,
} = require('../electron/agent-hooks-install.cjs');
const { eventPayload } = require('../electron/hooks/winmux-omp-hook.cjs');

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixture(cwd) {
  return {
    async request(method) {
      if (method === 'state') {
        return {
          workspaces: [{
            id: 'workspace-omp',
            cwd,
            profileId: 'powershell',
            panes: [{ id: 'pane-omp' }],
          }],
        };
      }
      if (method === 'environment') {
        return { profiles: [{ id: 'powershell', environment: 'windows', available: true }] };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

function configFromExtension(content) {
  const encoded = /CONFIG_ENCODED = '([A-Za-z0-9+/=]+)'/.exec(content)?.[1];
  assert.ok(encoded, 'installed extension must contain the generated private configuration');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function discoverDirectExtensionFiles(extensionDir) {
  // OMP 18.20.2 discoverExtensionModulePaths scans the direct-file arm with `*.{ts,js}`.
  return fs.globSync('*.{ts,js}', { cwd: extensionDir })
    .filter(entry => fs.statSync(path.join(extensionDir, entry)).isFile())
    .map(entry => path.join(extensionDir, entry));
}

test('installs atomically, preserves foreign project files, and is idempotent', async t => {
  const root = temp('winmux-omp-project-');
  const dataDir = temp('winmux-omp-data-');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.omp', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(root, '.omp', 'extensions', 'foreign.mjs'), 'export default function() {}\n');
  fs.writeFileSync(path.join(root, '.omp', 'settings.json'), '{"foreign":true}\n');

  const first = await installAgentHooks(fixture(root), {
    workspaceId: 'workspace-omp',
    agent: 'omp',
    paneId: 'pane-omp',
  }, { dataDir, nodePath: process.execPath });
  const extensionPath = path.join(root, '.omp', 'extensions', 'winmux-status.ts');
  const helperPath = path.join(dataDir, 'hooks', 'winmux-omp-hook.cjs');
  assert.equal(first.status, 'installed');
  assert.equal(first.agent, 'omp');
  assert.equal(first.configPath, extensionPath);
  assert.equal(first.extensionPath, extensionPath);
  assert.equal(first.helperPath, helperPath);
  assert.equal(first.requiresRestart, true);
  assert.equal(first.requiresTrustReview, false);
  assert.equal(fs.readFileSync(path.join(root, '.omp', 'extensions', 'foreign.mjs'), 'utf8'), 'export default function() {}\n');
  assert.equal(fs.readFileSync(path.join(root, '.omp', 'settings.json'), 'utf8'), '{"foreign":true}\n');
  const content = fs.readFileSync(extensionPath, 'utf8');
  assert.match(content, new RegExp(OMP_EXTENSION_MARKER));
  const discovered = discoverDirectExtensionFiles(path.dirname(extensionPath));
  assert.ok(discovered.includes(extensionPath), 'installed .ts entrypoint must be returned by OMP direct-file discovery');
  assert.deepEqual(discovered, [extensionPath]);
  assert.match(fs.readFileSync(helperPath, 'utf8'), new RegExp(OMP_HELPER_MARKER));
  assert.deepEqual(configFromExtension(content), {
    dataDir: fs.realpathSync(dataDir),
    helperPath,
    nodePath: process.execPath,
  });

  const extensionMtime = fs.statSync(extensionPath).mtimeMs;
  const helperMtime = fs.statSync(helperPath).mtimeMs;
  const second = await installAgentHooks(fixture(root), { workspaceId: 'workspace-omp', agent: 'omp' }, {
    dataDir,
    nodePath: process.execPath,
  });
  assert.equal(second.status, 'unchanged');
  assert.equal(fs.statSync(extensionPath).mtimeMs, extensionMtime);
  assert.equal(fs.statSync(helperPath).mtimeMs, helperMtime);
  assert.deepEqual(fs.readdirSync(path.join(root, '.omp', 'extensions')).sort(), ['foreign.mjs', 'winmux-status.ts']);
});

test('rejects foreign extension conflicts and missing Node without overwriting', async t => {
  const root = temp('winmux-omp-conflict-');
  const dataDir = temp('winmux-omp-conflict-data-');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const extensionPath = path.join(root, '.omp', 'extensions', 'winmux-status.ts');
  fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
  fs.writeFileSync(extensionPath, 'user extension\n');
  await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-omp', agent: 'omp' }, {
    dataDir,
    nodePath: process.execPath,
  }), { code: 'CONFIG_CONFLICT' });
  assert.equal(fs.readFileSync(extensionPath, 'utf8'), 'user extension\n');
  assert.equal(fs.existsSync(path.join(dataDir, 'hooks', 'winmux-omp-hook.cjs')), false);

  const cleanRoot = temp('winmux-omp-no-node-');
  t.after(() => fs.rmSync(cleanRoot, { recursive: true, force: true }));
  await assert.rejects(() => installAgentHooks(fixture(cleanRoot), { workspaceId: 'workspace-omp', agent: 'omp' }, {
    dataDir,
    nodePath: path.join(cleanRoot, 'missing-node.exe'),
  }), { code: 'NODE_UNAVAILABLE' });
  assert.equal(fs.existsSync(path.join(cleanRoot, '.omp')), false);
});

test('rejects symlinked or junctioned project roots without writing outside', async t => {
  const root = temp('winmux-omp-link-');
  const outside = temp('winmux-omp-outside-');
  const dataDir = temp('winmux-omp-link-data-');
  t.after(() => {
    for (const directory of [root, outside, dataDir]) fs.rmSync(directory, { recursive: true, force: true });
  });
  const linkedRoot = path.join(root, '.omp');
  try {
    fs.symlinkSync(outside, linkedRoot, 'junction');
    await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-omp', agent: 'omp' }, {
      dataDir,
      nodePath: process.execPath,
    }), { code: 'UNSAFE_PATH' });
    assert.equal(fs.existsSync(path.join(outside, 'extensions', 'winmux-status.ts')), false);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  }
});

test('rejects dangling OMP extension and helper symlinks without replacing them', async t => {
  const roots = [];
  const makeWorkspace = prefix => {
    const root = temp(prefix);
    const dataDir = temp(`${prefix}-data-`);
    const outside = temp(`${prefix}-outside-`);
    roots.push(root, dataDir, outside);
    return { root, dataDir, outside };
  };
  t.after(() => {
    for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  });

  const extensionCase = makeWorkspace('winmux-omp-dangling-extension-');
  const extensionDir = path.join(extensionCase.root, '.omp', 'extensions');
  fs.mkdirSync(extensionDir, { recursive: true });
  const extensionTarget = path.join(extensionDir, 'winmux-status.ts');
  const missingExtensionTarget = path.join(extensionCase.outside, 'missing-extension.ts');
  fs.symlinkSync(missingExtensionTarget, extensionTarget, 'file');
  const extensionLinkBefore = fs.readlinkSync(extensionTarget);
  await assert.rejects(() => installAgentHooks(fixture(extensionCase.root), {
    workspaceId: 'workspace-omp',
    agent: 'omp',
  }, {
    dataDir: extensionCase.dataDir,
    nodePath: process.execPath,
  }), { code: 'EXTENSION_UNSAFE' });
  assert.equal(fs.lstatSync(extensionTarget).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(extensionTarget), extensionLinkBefore);
  assert.deepEqual(fs.readdirSync(extensionCase.outside), []);
  assert.equal(fs.existsSync(path.join(extensionCase.dataDir, 'hooks', 'winmux-omp-hook.cjs')), false);

  const helperCase = makeWorkspace('winmux-omp-dangling-helper-');
  const helperDir = path.join(helperCase.dataDir, 'hooks');
  fs.mkdirSync(helperDir, { recursive: true });
  const helperTarget = path.join(helperDir, 'winmux-omp-hook.cjs');
  const missingHelperTarget = path.join(helperCase.outside, 'missing-helper.cjs');
  fs.symlinkSync(missingHelperTarget, helperTarget, 'file');
  const helperLinkBefore = fs.readlinkSync(helperTarget);
  await assert.rejects(() => installAgentHooks(fixture(helperCase.root), {
    workspaceId: 'workspace-omp',
    agent: 'omp',
  }, {
    dataDir: helperCase.dataDir,
    nodePath: process.execPath,
  }), { code: 'HELPER_UNSAFE' });
  assert.equal(fs.lstatSync(helperTarget).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(helperTarget), helperLinkBefore);
  assert.deepEqual(fs.readdirSync(helperCase.outside), []);
  assert.equal(fs.existsSync(path.join(helperCase.root, '.omp', 'extensions', 'winmux-status.ts')), false);
});

test('helper sends only the exact lifecycle payload over authenticated agent.hook', async t => {
  const dataDir = temp('winmux-omp-helper-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const token = fs.readFileSync(path.join(dataDir, 'ipc-token'), 'utf8').trim();
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\winmux-omp-hook-${crypto.randomBytes(6).toString('hex')}`
    : path.join(dataDir, 'omp.sock');
  const received = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const line = buffer.slice(0, buffer.indexOf('\n'));
      const request = JSON.parse(line);
      received.push(request);
      socket.end(`${JSON.stringify({
        id: request.id,
        ...(request.token === token ? { result: { applied: true } } : { error: { code: 'UNAUTHORIZED', message: 'no' } }),
      })}\n`);
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  t.after(() => server.close());
  const helper = path.resolve(__dirname, '..', 'electron', 'hooks', 'winmux-omp-hook.cjs');
  const child = spawn(process.execPath, [helper, '--data-dir', dataDir, '--pipe', pipe], {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(JSON.stringify({
    agentId: 'omp',
    event: 'tool_execution_start',
    sessionId: 'session-1',
    cwd: 'E:\\project',
    paneId: 'pane-1',
    pid: 1234,
    stamp: '456789',
    state: 'waiting',
    toolName: 'read',
    toolId: 'call-1',
    phase: 'start',
    messages: ['secret message'],
    args: { prompt: 'secret prompt' },
    result: 'secret result',
  }));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'agent.hook');
  assert.deepEqual(received[0].params, {
    agentId: 'omp',
    event: 'tool_execution_start',
    sessionId: 'session-1',
    cwd: 'E:\\project',
    paneId: 'pane-1',
    pid: 1234,
    stamp: '456789',
    state: 'waiting',
    toolName: 'read',
    toolId: 'call-1',
    phase: 'start',
  });
  assert.equal(JSON.stringify(received[0]).includes('secret'), false);
});

test('helper requires matching bounded tool identity without forwarding private tool data', () => {
  const base = {
    agentId: 'omp',
    event: 'tool_execution_start',
    sessionId: 'session-1',
    cwd: 'E:\\project',
    pid: 1234,
    stamp: '123456789012345678901234567890',
    state: 'running',
  };
  assert.throws(() => eventPayload(JSON.stringify({
    ...base,
    toolName: 'read',
    toolId: 'call-1',
    phase: 'end',
  })), { code: 'HOOK_INVALID' });
  assert.throws(() => eventPayload(JSON.stringify({
    ...base,
    toolName: 'x'.repeat(129),
    toolId: 'call-1',
    phase: 'start',
  })), { code: 'HOOK_INVALID' });
  assert.throws(() => eventPayload(JSON.stringify({
    ...base,
    stamp: '1'.repeat(31),
    toolName: 'read',
    toolId: 'call-1',
    phase: 'start',
  })), { code: 'HOOK_INVALID' });

  const lifecycle = eventPayload(JSON.stringify({
    agentId: 'omp',
    event: 'agent_start',
    sessionId: 'session-1',
    cwd: 'E:\\project',
    pid: 1234,
    stamp: '123',
    state: 'running',
    toolName: 'ignored',
    toolId: 'ignored',
    phase: 'invalid',
    args: { command: 'secret' },
  }));
  assert.equal(Object.hasOwn(lifecycle, 'toolName'), false);
  assert.equal(JSON.stringify(lifecycle).includes('secret'), false);
});
