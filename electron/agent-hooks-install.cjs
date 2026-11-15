'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MARKER = 'winmux-codex-hook';
const OMP_EXTENSION_MARKER = 'winmux-omp-extension';
const OMP_HELPER_MARKER = 'winmux-omp-hook';
const OWNED_STATUS = 'Winmux Codex activity [winmux-owned]';
const EVENTS = Object.freeze([
  'SessionStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit',
  'PreModelRequest', 'PostModelRequest', 'Stop', 'Interrupt', 'SessionEnd',
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function validToken(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertContained(root, target, label) {
  const resolvedRoot = fs.realpathSync(root);
  const absolute = path.resolve(resolvedRoot, target);
  if (!isWithin(resolvedRoot, absolute)) fail('UNSAFE_PATH', `${label} is outside its root.`);
  let current = resolvedRoot;
  const relative = path.relative(resolvedRoot, absolute);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH', `${label} contains a symlink.`);
      if (!isWithin(resolvedRoot, fs.realpathSync(current))) fail('UNSAFE_PATH', `${label} resolves outside its root.`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return { root: resolvedRoot, target: absolute };
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stableNode(injected) {
  if (injected) {
    if (typeof injected !== 'string' || injected.includes('\0') || !path.isAbsolute(injected)) fail('NODE_UNAVAILABLE', 'The injected Node path is not an absolute executable path.');
    let stat;
    try { stat = fs.lstatSync(injected); }
    catch { fail('NODE_UNAVAILABLE', 'The injected Node path does not exist.'); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('NODE_UNAVAILABLE', 'The injected Node path is not a regular executable.');
    return injected;
  }
  if (process.platform !== 'win32') fail('NODE_UNAVAILABLE', 'A stable system Node executable was not found. Install Node.js and retry Codex hook installation.');
  const lookup = spawnSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const candidates = (lookup.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const lower = candidate.toLowerCase();
    if (lower.includes('\\electron') || lower.includes('\\temp\\') || lower.includes('\\tmp\\')) continue;
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch { /* try the next PATH entry */ }
  }
  fail('NODE_UNAVAILABLE', 'A stable system Node executable was not found. Install Node.js outside Electron or a temporary directory and retry.');
}

function commandFor(nodePath, helperPath, dataDir) {
  const invocation = [nodePath, helperPath, '--data-dir', dataDir].map(powershellLiteral).join(' ');
  const script = `$ErrorActionPreference='Stop'; & ${invocation}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function ownedCommand(entry) {
  return entry && entry.type === 'command' && entry.statusMessage === OWNED_STATUS;
}

function mergeHooks(existing, command) {
  if (existing === undefined) existing = {};
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) fail('CONFIG_INVALID', 'Codex hooks.json must be a JSON object.');
  const next = structuredClone(existing);
  if (next.hooks === undefined) next.hooks = {};
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) fail('CONFIG_INVALID', 'Codex hooks.json hooks must be an object.');
  for (const event of EVENTS) {
    if (next.hooks[event] === undefined) next.hooks[event] = [];
    if (!Array.isArray(next.hooks[event])) fail('CONFIG_CONFLICT', `Codex hook event ${event} is not an array and cannot be merged.`);
    const groups = next.hooks[event];
    let placed = false;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.hooks)) continue;
      const owned = group.hooks.filter(ownedCommand);
      if (!owned.length) continue;
      if (owned.length !== 1 || group.hooks.length !== 1) fail('CONFIG_CONFLICT', `Codex hook event ${event} mixes the Winmux hook with other handlers.`);
      owned[0].command = command;
      owned[0].commandWindows = command;
      owned[0].timeout = 5;
      owned[0].statusMessage = OWNED_STATUS;
      placed = true;
    }
    if (!placed) {
      groups.push({
        hooks: [{
          type: 'command',
          command,
          commandWindows: command,
          timeout: 5,
          statusMessage: OWNED_STATUS,
        }],
      });
    }
  }
  return next;
}

function readConfig(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { existed: false, value: {} };
    if (error.code === 'EPERM' || error.code === 'EACCES') fail('CONFIG_UNSAFE', 'Codex hooks.json cannot be safely inspected.');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('CONFIG_UNSAFE', 'Codex hooks.json is not a regular file.');
  if (stat.size > 1024 * 1024) fail('CONFIG_INVALID', 'Codex hooks.json exceeds 1 MiB.');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail('CONFIG_INVALID', 'Codex hooks.json is not valid JSON.'); }
  return { existed: true, value: parsed };
}

function sameConfig(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function installHelper(dataDir, helperRoot) {
  const root = assertContained(dataDir, path.join(dataDir, 'hooks'), 'Winmux hook directory').target;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = path.join(helperRoot, 'winmux-agent-hook.cjs');
  const content = fs.readFileSync(source);
  const target = path.join(root, 'winmux-agent-hook.cjs');
  const existing = fs.existsSync(target) ? fs.lstatSync(target) : null;
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('HELPER_UNSAFE', 'The installed Winmux hook helper is not a regular file.');
  if (existing) {
    const current = fs.readFileSync(target);
    if (!current.includes(MARKER) && !current.equals(content)) fail('HELPER_UNOWNED', 'An unrelated file already occupies the Winmux hook helper path.');
  }
  if (!existing || !fs.readFileSync(target).equals(content)) {
    const stage = path.join(root, `.winmux-agent-hook-${process.pid}-${crypto.randomBytes(4).toString('hex')}.cjs`);
    fs.writeFileSync(stage, content, { mode: 0o644 });
    fs.renameSync(stage, target);
  }
  return target;
}

function installOmpHelper(dataDir, helperRoot) {
  const root = assertContained(dataDir, path.join(dataDir, 'hooks'), 'Winmux OMP hook directory').target;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = path.join(helperRoot, 'winmux-omp-hook.cjs');
  const content = fs.readFileSync(source);
  const target = path.join(root, 'winmux-omp-hook.cjs');
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('HELPER_UNSAFE', 'The installed Winmux OMP hook helper is not a regular file.');
  if (existing) {
    const current = fs.readFileSync(target);
    if (!current.includes(OMP_HELPER_MARKER) && !current.equals(content)) fail('HELPER_UNOWNED', 'An unrelated file already occupies the Winmux OMP hook helper path.');
  }
  if (!existing || !fs.readFileSync(target).equals(content)) {
    const stage = path.join(root, `.winmux-omp-hook-${process.pid}-${crypto.randomBytes(4).toString('hex')}.cjs`);
    fs.writeFileSync(stage, content, { mode: 0o644 });
    fs.renameSync(stage, target);
  }
  return target;
}

function prepareOmpExtension(projectRoot, helperRoot, helperPath, nodePath, dataDir) {
  const extensionDir = assertContained(projectRoot, path.join(projectRoot, '.omp', 'extensions'), 'OMP extension directory').target;
  const target = path.join(extensionDir, 'winmux-status.ts');
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink()) fail('EXTENSION_UNSAFE', 'The OMP Winmux extension is not a regular file.');
    if (stat.size > 1024 * 1024) fail('CONFIG_CONFLICT', 'The OMP Winmux extension exceeds 1 MiB.');
    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(OMP_EXTENSION_MARKER)) fail('CONFIG_CONFLICT', 'An unrelated extension already occupies the Winmux OMP extension path.');
  }
  const config = Buffer.from(JSON.stringify({ dataDir, helperPath, nodePath }), 'utf8').toString('base64');
  const template = fs.readFileSync(path.join(helperRoot, 'winmux-omp-extension.mjs'), 'utf8');
  if (!template.includes(OMP_EXTENSION_MARKER) || !template.includes('__WINMUX_CONFIG_B64__')) {
    fail('HELPER_INVALID', 'The bundled OMP extension template is invalid.');
  }
  const content = template.replace('__WINMUX_CONFIG_B64__', config);
  return { extensionDir, target, content };
}

function installPreparedOmpExtension(prepared) {
  fs.mkdirSync(prepared.extensionDir, { recursive: true, mode: 0o755 });
  const existing = fs.lstatSync(prepared.target, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    fail('EXTENSION_UNSAFE', 'The OMP Winmux extension is not a regular file.');
  }
  if (existing && fs.readFileSync(prepared.target).equals(Buffer.from(prepared.content))) {
    return { status: 'unchanged', configPath: prepared.target };
  }
  const stage = path.join(prepared.extensionDir, `.winmux-status-${process.pid}-${crypto.randomBytes(4).toString('hex')}.mjs`);
  fs.writeFileSync(stage, prepared.content, { mode: 0o644 });
  fs.renameSync(stage, prepared.target);
  return { status: existing ? 'updated' : 'installed', configPath: prepared.target };
}

async function installAgentHooks(client, params, options = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some(key => !['workspaceId', 'agent', 'paneId'].includes(key))
    || !Object.hasOwn(params, 'workspaceId') || !Object.hasOwn(params, 'agent')) {
    fail('INVALID_ARGUMENT', 'Expected workspaceId and agent.');
  }
  if (!validToken(params.workspaceId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) fail('INVALID_ARGUMENT', 'Invalid workspaceId.');
  if (params.agent !== 'codex' && params.agent !== 'omp') fail('UNSUPPORTED_AGENT', 'This Winmux release installs project-local Codex or OMP hooks only.');
  if (params.paneId !== undefined && !validToken(params.paneId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) fail('INVALID_ARGUMENT', 'Invalid paneId.');
  if (!options.dataDir || typeof options.dataDir !== 'string') fail('INVALID_ARGUMENT', 'options.dataDir is required.');

  const state = await client.request('state');
  const environment = await client.request('environment');
  const workspace = state.workspaces.find(item => item.id === params.workspaceId);
  if (!workspace) fail('NOT_FOUND', 'Workspace not found.');
  if (typeof workspace.cwd !== 'string' || !workspace.cwd || /[\x00-\x1f]/.test(workspace.cwd)) fail('INVALID_CWD', 'The workspace needs a valid startup directory.');
  const profile = environment.profiles.find(item => item.id === workspace.profileId);
  if (!profile || profile.available === false || profile.environment !== 'windows') {
    fail('UNSUPPORTED_ENVIRONMENT', 'Project-local Codex hooks are installed for a verified Windows workspace. WSL hook installation is not supported by this release.');
  }
  if (params.paneId && !workspace.panes.some(pane => pane.id === params.paneId)) fail('NOT_FOUND', 'Pane not found in the selected workspace.');

  const project = assertContained(workspace.cwd, workspace.cwd, 'Workspace');
  if (params.agent === 'omp') {
    const data = assertContained(options.dataDir, options.dataDir, 'Winmux data directory');
    const nodePath = stableNode(options.nodePath);
    const helperRoot = path.resolve(options.helperRoot || path.join(__dirname, 'hooks'));
    const helperPathTarget = path.join(data.root, 'hooks', 'winmux-omp-hook.cjs');
    const prepared = prepareOmpExtension(project.root, helperRoot, helperPathTarget, nodePath, data.root);
    const helperPath = installOmpHelper(data.root, helperRoot);
    const installed = installPreparedOmpExtension(prepared);
    return {
      status: installed.status,
      agent: 'omp',
      workspaceId: workspace.id,
      ...(params.paneId ? { paneId: params.paneId } : {}),
      configPath: installed.configPath,
      extensionPath: installed.configPath,
      helperPath,
      requiresTrustReview: false,
      requiresRestart: true,
    };
  }
  const codexDir = assertContained(project.root, path.join(project.root, '.codex'), 'Codex project directory');
  const configPath = path.join(codexDir.target, 'hooks.json');
  const data = assertContained(options.dataDir, options.dataDir, 'Winmux data directory');
  const nodePath = stableNode(options.nodePath);
  const helperPath = installHelper(data.root, options.helperRoot || path.join(__dirname, 'hooks'));
  const command = commandFor(nodePath, helperPath, data.root);
  const current = readConfig(configPath);
  const merged = mergeHooks(current.value, command);
  let backupPath;
  let status = 'unchanged';
  if (!sameConfig(current.value, merged)) {
    fs.mkdirSync(codexDir.target, { recursive: true });
    if (current.existed) {
      backupPath = `${configPath}.${MARKER}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
      fs.copyFileSync(configPath, backupPath);
    }
    const stage = path.join(codexDir.target, `.hooks-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(stage, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(stage, configPath);
    status = current.existed ? 'updated' : 'installed';
  }
  return {
    status,
    agent: 'codex',
    workspaceId: workspace.id,
    ...(params.paneId ? { paneId: params.paneId } : {}),
    configPath,
    helperPath,
    ...(backupPath ? { backupPath } : {}),
    requiresTrustReview: true,
  };
}

module.exports = {
  installAgentHooks,
  MARKER,
  OMP_EXTENSION_MARKER,
  OMP_HELPER_MARKER,
  OWNED_STATUS,
  EVENTS,
};
