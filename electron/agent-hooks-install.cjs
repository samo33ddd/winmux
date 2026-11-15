'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MARKER = 'winmux-codex-hook';
const OMP_EXTENSION_MARKER = 'winmux-omp-extension';
const OMP_HELPER_MARKER = 'winmux-omp-hook';
const GENERIC_HELPER_MARKER = 'winmux-agent-event';
const PI_EXTENSION_MARKER = 'winmux-pi-extension';
const HERMES_PLUGIN_MARKER = 'winmux-hermes-plugin';
const OWNED_STATUS = 'Winmux Codex activity [winmux-owned]';
const CLAUDE_OWNED_STATUS = 'Winmux Claude activity [winmux-owned]';
const EVENTS = Object.freeze([
  'SessionStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit',
  'PreModelRequest', 'PostModelRequest', 'Stop', 'Interrupt', 'SessionEnd',
]);
const CLAUDE_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd',
]);
const HERMES_HOOKS = Object.freeze([
  'on_session_open', 'on_session_reset', 'on_session_finalize', 'pre_llm_call',
  'pre_tool_call', 'post_tool_call', 'on_session_end', 'subagent_start',
  'subagent_stop', 'on_human_input_request', 'on_human_input_resolved',
]);
const SUPPORTED_AGENTS = new Set(['codex', 'omp', 'claude', 'pi', 'hermes']);

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

function commandFor(nodePath, helperPath, dataDir, agent) {
  const args = [nodePath, helperPath, '--data-dir', dataDir];
  if (agent) args.push('--agent', agent);
  const invocation = args.map(powershellLiteral).join(' ');
  const script = `$ErrorActionPreference='Stop'; & ${invocation}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function ownedCommand(entry, status) {
  return entry && entry.type === 'command' && entry.statusMessage === status;
}

function mergeHooks(existing, command) {
  return mergeCommandHooks(existing, command, EVENTS, OWNED_STATUS, 'Codex');
}

function mergeCommandHooks(existing, command, events, status, label) {
  if (existing === undefined) existing = {};
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) fail('CONFIG_INVALID', `${label} hooks config must be a JSON object.`);
  const next = structuredClone(existing);
  if (next.hooks === undefined) next.hooks = {};
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) fail('CONFIG_INVALID', `${label} hooks must be an object.`);
  for (const event of events) {
    if (next.hooks[event] === undefined) next.hooks[event] = [];
    if (!Array.isArray(next.hooks[event])) fail('CONFIG_CONFLICT', `${label} hook event ${event} is not an array and cannot be merged.`);
    const groups = next.hooks[event];
    let placed = false;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.hooks)) continue;
      const owned = group.hooks.filter(entry => ownedCommand(entry, status));
      if (!owned.length) continue;
      if (owned.length !== 1 || group.hooks.length !== 1 || group.matcher !== undefined) {
        fail('CONFIG_CONFLICT', `${label} hook event ${event} mixes the Winmux hook with other handlers.`);
      }
      owned[0].command = command;
      owned[0].timeout = 5;
      owned[0].statusMessage = status;
      if (label === 'Codex') owned[0].commandWindows = command;
      else delete owned[0].commandWindows;
      placed = true;
    }
    if (!placed) {
      const entry = { type: 'command', command, timeout: 5, statusMessage: status };
      if (label === 'Codex') entry.commandWindows = command;
      groups.push({ hooks: [entry] });
    }
  }
  return next;
}

function readConfig(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { existed: false, value: {} };
    if (error.code === 'EPERM' || error.code === 'EACCES') fail('CONFIG_UNSAFE', `${label} cannot be safely inspected.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('CONFIG_UNSAFE', `${label} is not a regular file.`);
  if (stat.size > 1024 * 1024) fail('CONFIG_INVALID', `${label} exceeds 1 MiB.`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail('CONFIG_INVALID', `${label} is not valid JSON.`); }
  return { existed: true, value: parsed };
}

function sameConfig(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function installMarkedFile(directory, fileName, source, marker, unsafeCode, unsafeMessage, unownedMessage) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = assertContained(directory, directory, 'Winmux install directory').target;
  const content = fs.readFileSync(source);
  const target = path.join(root, fileName);
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail(unsafeCode, unsafeMessage);
  if (existing) {
    const current = fs.readFileSync(target);
    if (!current.includes(marker) && !current.equals(content)) fail('HELPER_UNOWNED', unownedMessage);
  }
  if (!existing || !fs.readFileSync(target).equals(content)) {
    const extension = path.extname(fileName);
    const stage = path.join(root, `.${path.basename(fileName, extension)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}${extension}`);
    fs.writeFileSync(stage, content, { mode: 0o644 });
    fs.renameSync(stage, target);
  }
  return target;
}

function installHelper(dataDir, helperRoot) {
  const root = assertContained(dataDir, path.join(dataDir, 'hooks'), 'Winmux hook directory').target;
  return installMarkedFile(
    root,
    'winmux-agent-hook.cjs',
    path.join(helperRoot, 'winmux-agent-hook.cjs'),
    MARKER,
    'HELPER_UNSAFE',
    'The installed Winmux hook helper is not a regular file.',
    'An unrelated file already occupies the Winmux hook helper path.',
  );
}

function installOmpHelper(dataDir, helperRoot) {
  const root = assertContained(dataDir, path.join(dataDir, 'hooks'), 'Winmux OMP hook directory').target;
  return installMarkedFile(
    root,
    'winmux-omp-hook.cjs',
    path.join(helperRoot, 'winmux-omp-hook.cjs'),
    OMP_HELPER_MARKER,
    'HELPER_UNSAFE',
    'The installed Winmux OMP hook helper is not a regular file.',
    'An unrelated file already occupies the Winmux OMP hook helper path.',
  );
}

function installGenericHelper(dataDir, helperRoot) {
  const root = assertContained(dataDir, path.join(dataDir, 'hooks'), 'Winmux generic hook directory').target;
  return installMarkedFile(
    root,
    'winmux-agent-event.cjs',
    path.join(helperRoot, 'winmux-agent-event.cjs'),
    GENERIC_HELPER_MARKER,
    'HELPER_UNSAFE',
    'The installed Winmux agent event helper is not a regular file.',
    'An unrelated file already occupies the Winmux agent event helper path.',
  );
}

function prepareConfiguredExtension(projectRoot, relativeDir, fileName, helperRoot, templateName, marker, config, labels) {
  const extensionDir = assertContained(projectRoot, path.join(projectRoot, ...relativeDir), labels.directory).target;
  const target = path.join(extensionDir, fileName);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink()) fail(labels.unsafeCode, labels.unsafeMessage);
    if (stat.size > 1024 * 1024) fail('CONFIG_CONFLICT', labels.tooLarge);
    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(marker)) fail('CONFIG_CONFLICT', labels.conflict);
  }
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const template = fs.readFileSync(path.join(helperRoot, templateName), 'utf8');
  if (!template.includes(marker) || !template.includes('__WINMUX_CONFIG_B64__')) fail('HELPER_INVALID', labels.invalidTemplate);
  return { extensionDir, target, content: template.replace('__WINMUX_CONFIG_B64__', encoded) };
}

function prepareOmpExtension(projectRoot, helperRoot, helperPath, nodePath, dataDir) {
  return prepareConfiguredExtension(
    projectRoot,
    ['.omp', 'extensions'],
    'winmux-status.ts',
    helperRoot,
    'winmux-omp-extension.mjs',
    OMP_EXTENSION_MARKER,
    { dataDir, helperPath, nodePath },
    {
      directory: 'OMP extension directory',
      unsafeCode: 'EXTENSION_UNSAFE',
      unsafeMessage: 'The OMP Winmux extension is not a regular file.',
      tooLarge: 'The OMP Winmux extension exceeds 1 MiB.',
      conflict: 'An unrelated extension already occupies the Winmux OMP extension path.',
      invalidTemplate: 'The bundled OMP extension template is invalid.',
    },
  );
}

function preparePiExtension(projectRoot, helperRoot, helperPath, nodePath, dataDir) {
  return prepareConfiguredExtension(
    projectRoot,
    ['.pi', 'extensions'],
    'winmux-status.ts',
    helperRoot,
    'winmux-pi-extension.mjs',
    PI_EXTENSION_MARKER,
    { dataDir, helperPath, nodePath },
    {
      directory: 'Pi extension directory',
      unsafeCode: 'EXTENSION_UNSAFE',
      unsafeMessage: 'The Pi Winmux extension is not a regular file.',
      tooLarge: 'The Pi Winmux extension exceeds 1 MiB.',
      conflict: 'An unrelated extension already occupies the Winmux Pi extension path.',
      invalidTemplate: 'The bundled Pi extension template is invalid.',
    },
  );
}

function installPreparedExtension(prepared, stagePrefix, unsafeMessage) {
  fs.mkdirSync(prepared.extensionDir, { recursive: true, mode: 0o755 });
  const existing = fs.lstatSync(prepared.target, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('EXTENSION_UNSAFE', unsafeMessage);
  if (existing && fs.readFileSync(prepared.target).equals(Buffer.from(prepared.content))) {
    return { status: 'unchanged', configPath: prepared.target };
  }
  const extension = path.extname(prepared.target);
  const stage = path.join(prepared.extensionDir, `.${stagePrefix}-${process.pid}-${crypto.randomBytes(4).toString('hex')}${extension}`);
  fs.writeFileSync(stage, prepared.content, { mode: 0o644 });
  fs.renameSync(stage, prepared.target);
  return { status: existing ? 'updated' : 'installed', configPath: prepared.target };
}

function installPreparedOmpExtension(prepared) {
  return installPreparedExtension(prepared, 'winmux-status', 'The OMP Winmux extension is not a regular file.');
}

function platformHermesHome() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA && process.env.LOCALAPPDATA.trim();
    return path.join(localAppData || path.join(os.homedir(), 'AppData', 'Local'), 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

function resolveHermesHome(options) {
  const requested = options.hermesHome || process.env.HERMES_HOME;
  if (typeof requested === 'string' && requested.trim()) return hermesProfilePath(requested);
  return platformHermesHome();
}

function hermesProfilePath(value) {
  if (typeof value !== 'string') fail('INVALID_ARGUMENT', 'Hermes profile must be an absolute directory path.');
  const selected = value.trim();
  if (!selected || /[\u0000-\u001f]/.test(selected) || !path.isAbsolute(selected)) {
    fail('INVALID_ARGUMENT', 'Hermes profile must be an absolute directory path.');
  }
  if (selected.startsWith('-') || selected.includes(' --') || /[&|;<>`"']/.test(selected)) {
    fail('INVALID_ARGUMENT', 'Hermes profile must be a directory path, not command arguments.');
  }
  return path.resolve(selected);
}

function installHermesPlugin(home, helperRoot, config) {
  return commitHermesPlugin(home, helperRoot, config);
}

function assertHermesPluginSafe(home, pluginDir) {
  const configPath = path.join(home, 'config.yaml');
  const configStat = fs.lstatSync(configPath, { throwIfNoEntry: false });
  if (configStat && (!configStat.isFile() || configStat.isSymbolicLink())) {
    fail('CONFIG_UNSAFE', 'Hermes config.yaml is not a regular file.');
  }
  for (const alias of ['plugin.yml', 'plugin.json']) {
    if (assertHermesPluginFile(pluginDir, alias, `The Hermes manifest ${alias} is not a regular file.`)) {
      fail('CONFIG_CONFLICT', `An existing ${alias} already occupies the Winmux Hermes plugin path.`);
    }
  }
  if (assertHermesPluginFile(pluginDir, 'plugin.yaml', 'The Hermes Winmux plugin manifest is not a regular file.')) {
    const current = fs.readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8');
    if (!current.includes('name: winmux-status') || !current.includes(HERMES_PLUGIN_MARKER)) {
      fail('CONFIG_CONFLICT', 'An unrelated Hermes plugin already occupies the Winmux plugin path.');
    }
  }
  if (assertHermesPluginFile(pluginDir, '__init__.py', 'The Hermes Winmux plugin is not a regular file.')) {
    const current = fs.readFileSync(path.join(pluginDir, '__init__.py'), 'utf8');
    if (!current.includes(HERMES_PLUGIN_MARKER)) {
      fail('CONFIG_CONFLICT', 'An unrelated Hermes plugin source already occupies the Winmux plugin path.');
    }
  }
}

function assertHermesPluginFile(pluginDir, fileName, message) {
  const stat = fs.lstatSync(path.join(pluginDir, fileName), { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('EXTENSION_UNSAFE', message);
  return stat;
}

function commitHermesPlugin(home, helperRoot, config) {
  const pluginDir = assertContained(home, path.join(home, 'plugins', 'winmux-status'), 'Hermes plugin directory');
  assertHermesPluginSafe(home, pluginDir.target);
  const configPath = path.join(home, 'config.yaml');
  const configStat = fs.lstatSync(configPath, { throwIfNoEntry: false });
  const configBefore = configStat ? fs.readFileSync(configPath) : null;
  const manifestPath = path.join(pluginDir.target, 'plugin.yaml');
  const pythonPath = path.join(pluginDir.target, '__init__.py');
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  const pythonStat = fs.lstatSync(pythonPath, { throwIfNoEntry: false });
  const template = fs.readFileSync(path.join(helperRoot, 'winmux-hermes-plugin.py'), 'utf8');
  if (!template.includes(HERMES_PLUGIN_MARKER) || !template.includes('__WINMUX_CONFIG_B64__')) {
    fail('HELPER_INVALID', 'The bundled Hermes plugin template is invalid.');
  }
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const content = template.replace('__WINMUX_CONFIG_B64__', encoded);
  const manifest = [
    `# ${HERMES_PLUGIN_MARKER}`,
    'name: winmux-status',
    'version: "1.0.0"',
    'description: Winmux Hermes lifecycle observer',
    'kind: standalone',
    'provides_tools: []',
    'provides_hooks:',
    ...HERMES_HOOKS.map(name => `  - ${name}`),
    '',
  ].join('\n');
  const manifestSame = Boolean(manifestStat) && fs.readFileSync(manifestPath, 'utf8') === manifest;
  const pythonSame = Boolean(pythonStat) && fs.readFileSync(pythonPath, 'utf8') === content;
  const backupPaths = [];
  if (!manifestSame || !pythonSame) {
    fs.mkdirSync(pluginDir.target, { recursive: true, mode: 0o755 });
    if (manifestStat && !manifestSame) backupPaths.push(backupOwnedFile(manifestPath));
    if (pythonStat && !pythonSame) backupPaths.push(backupOwnedFile(pythonPath));
    const stamp = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    if (!manifestSame) replaceOwnedFile(pluginDir.target, `.plugin-${stamp}.yaml`, manifestPath, manifest);
    if (!pythonSame) replaceOwnedFile(pluginDir.target, `.__init__-${stamp}.py`, pythonPath, content);
  }
  if (configBefore === null) {
    if (fs.existsSync(configPath)) fail('CONFIG_CONFLICT', 'Hermes config.yaml was created during plugin installation.');
  } else if (!fs.readFileSync(configPath).equals(configBefore)) {
    fail('CONFIG_CONFLICT', 'Hermes config.yaml changed during plugin installation.');
  }
  return {
    status: manifestSame && pythonSame ? 'unchanged' : manifestStat || pythonStat ? 'updated' : 'installed',
    configPath: manifestPath,
    ...(backupPaths.length ? { backupPaths } : {}),
  };
}

function backupOwnedFile(filePath) {
  const backupPath = `${filePath}.${HERMES_PLUGIN_MARKER}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function replaceOwnedFile(directory, stageName, target, content) {
  const stage = path.join(directory, stageName);
  fs.writeFileSync(stage, content, { mode: 0o644 });
  fs.renameSync(stage, target);
}

function installMergedJson(directory, fileName, current, merged, marker) {
  let backupPath;
  let status = 'unchanged';
  if (!sameConfig(current.value, merged)) {
    fs.mkdirSync(directory, { recursive: true });
    const configPath = path.join(directory, fileName);
    if (current.existed) {
      backupPath = `${configPath}.${marker}-${new Date().toISOString().replace(/[:.]/g, '-')}`.concat('.bak');
      fs.copyFileSync(configPath, backupPath);
    }
    const stage = path.join(directory, `.${path.basename(fileName, '.json')}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(stage, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(stage, configPath);
    status = current.existed ? 'updated' : 'installed';
  }
  return { status, backupPath, configPath: path.join(directory, fileName) };
}

function requireWindowsWorkspace(clientState, environment, params) {
  const workspace = clientState.workspaces.find(item => item.id === params.workspaceId);
  if (!workspace) fail('NOT_FOUND', 'Workspace not found.');
  if (typeof workspace.cwd !== 'string' || !workspace.cwd || /[\x00-\x1f]/.test(workspace.cwd)) fail('INVALID_CWD', 'The workspace needs a valid startup directory.');
  const profile = environment.profiles.find(item => item.id === workspace.profileId);
  if (!profile || profile.available === false || profile.environment !== 'windows') {
    fail('UNSUPPORTED_ENVIRONMENT', 'Project-local hooks are installed for a verified Windows workspace. WSL hook installation is not supported by this release.');
  }
  if (params.paneId && !workspace.panes.some(pane => pane.id === params.paneId)) fail('NOT_FOUND', 'Pane not found in the selected workspace.');
  return workspace;
}

async function installAgentHooks(client, params, options = {}) {
  const allowed = ['workspaceId', 'agent', 'paneId', 'hermesHome'];
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some(key => !allowed.includes(key))
    || !Object.hasOwn(params, 'workspaceId') || !Object.hasOwn(params, 'agent')) {
    fail('INVALID_ARGUMENT', 'Expected workspaceId and agent.');
  }
  if (!validToken(params.workspaceId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) fail('INVALID_ARGUMENT', 'Invalid workspaceId.');
  if (!SUPPORTED_AGENTS.has(params.agent)) fail('UNSUPPORTED_AGENT', 'This Winmux release installs Codex, OMP, Claude, Pi, or Hermes hooks only.');
  if (params.paneId !== undefined && !validToken(params.paneId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) fail('INVALID_ARGUMENT', 'Invalid paneId.');
  if (!options.dataDir || typeof options.dataDir !== 'string') fail('INVALID_ARGUMENT', 'options.dataDir is required.');
  if (params.hermesHome !== undefined) options = { ...options, hermesHome: hermesProfilePath(params.hermesHome) };

  const state = await client.request('state');
  const environment = await client.request('environment');
  const workspace = requireWindowsWorkspace(state, environment, params);
  const project = assertContained(workspace.cwd, workspace.cwd, 'Workspace');
  const data = assertContained(options.dataDir, options.dataDir, 'Winmux data directory');
  const nodePath = stableNode(options.nodePath);
  const helperRoot = path.resolve(options.helperRoot || path.join(__dirname, 'hooks'));
  const pane = params.paneId ? { paneId: params.paneId } : {};

  if (params.agent === 'omp' || params.agent === 'pi') {
    const helperName = params.agent === 'omp' ? 'winmux-omp-hook.cjs' : 'winmux-agent-event.cjs';
    const helperPathTarget = path.join(data.root, 'hooks', helperName);
    const prepared = params.agent === 'omp'
      ? prepareOmpExtension(project.root, helperRoot, helperPathTarget, nodePath, data.root)
      : preparePiExtension(project.root, helperRoot, helperPathTarget, nodePath, data.root);
    const helperPath = params.agent === 'omp'
      ? installOmpHelper(data.root, helperRoot)
      : installGenericHelper(data.root, helperRoot);
    const installed = params.agent === 'omp'
      ? installPreparedOmpExtension(prepared)
      : installPreparedExtension(prepared, 'winmux-pi', 'The Pi Winmux extension is not a regular file.');
    return {
      status: installed.status,
      agent: params.agent,
      workspaceId: workspace.id,
      ...pane,
      configPath: installed.configPath,
      extensionPath: installed.configPath,
      helperPath,
      requiresTrustReview: false,
      requiresRestart: true,
    };
  }

  if (params.agent === 'hermes') {
    const home = resolveHermesHome(options);
    const homeStat = fs.lstatSync(home, { throwIfNoEntry: false });
    if (!homeStat) fail('NOT_FOUND', 'Hermes profile directory was not found.');
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) fail('UNSAFE_PATH', 'Hermes profile is not a real directory.');
    const pluginDir = assertContained(home, path.join(home, 'plugins', 'winmux-status'), 'Hermes plugin directory');
    assertHermesPluginSafe(home, pluginDir.target);
    const helperPath = installGenericHelper(data.root, helperRoot);
    const installed = installHermesPlugin(home, helperRoot, {
      dataDir: data.root,
      helperPath,
      nodePath,
    });
    return {
      status: installed.status,
      agent: 'hermes',
      workspaceId: workspace.id,
      ...pane,
      configPath: installed.configPath,
      pluginPath: path.dirname(installed.configPath),
      helperPath,
      requiresTrustReview: false,
      requiresEnable: true,
      enableCommand: 'hermes plugins enable winmux-status',
      requiresRestart: true,
      ...(installed.backupPaths ? { backupPaths: installed.backupPaths } : {}),
    };
  }

  const generic = params.agent === 'claude';
  const projectDirName = generic ? '.claude' : '.codex';
  const configName = generic ? 'settings.local.json' : 'hooks.json';
  const marker = generic ? 'winmux-claude-hook' : MARKER;
  const projectDir = assertContained(project.root, path.join(project.root, projectDirName), `${generic ? 'Claude' : 'Codex'} project directory`);
  const configPath = path.join(projectDir.target, configName);
  const helperPath = generic ? installGenericHelper(data.root, helperRoot) : installHelper(data.root, helperRoot);
  const command = commandFor(nodePath, helperPath, data.root, generic ? 'claude' : undefined);
  const current = readConfig(configPath, generic ? 'Claude settings.local.json' : 'Codex hooks.json');
  const merged = generic
    ? mergeCommandHooks(current.value, command, CLAUDE_EVENTS, CLAUDE_OWNED_STATUS, 'Claude')
    : mergeHooks(current.value, command);
  const written = installMergedJson(projectDir.target, configName, current, merged, marker);
  return {
    status: written.status,
    agent: params.agent,
    workspaceId: workspace.id,
    ...pane,
    configPath,
    helperPath,
    ...(written.backupPath ? { backupPath: written.backupPath } : {}),
    requiresTrustReview: true,
  };
}

module.exports = {
  installAgentHooks,
  MARKER,
  OMP_EXTENSION_MARKER,
  OMP_HELPER_MARKER,
  GENERIC_HELPER_MARKER,
  PI_EXTENSION_MARKER,
  HERMES_PLUGIN_MARKER,
  OWNED_STATUS,
  CLAUDE_OWNED_STATUS,
  EVENTS,
  CLAUDE_EVENTS,
  HERMES_HOOKS,
  platformHermesHome,
};
