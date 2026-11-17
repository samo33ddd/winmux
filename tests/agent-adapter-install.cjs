'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  installAgentHooks,
  installProjectAgentHooks,
  CLAUDE_EVENTS,
  CLAUDE_OWNED_STATUS,
  HERMES_HOOKS,
  HERMES_PLUGIN_MARKER,
  PI_EXTENSION_MARKER,
} = require('../electron/agent-hooks-install.cjs');

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixture(cwd) {
  return {
    async request(method) {
      if (method === 'state') {
        return { workspaces: [{ id: 'workspace-1', cwd, profileId: 'powershell', panes: [{ id: 'pane-1' }] }] };
      }
      if (method === 'environment') {
        return { profiles: [{ id: 'powershell', environment: 'windows', available: true }] };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

function decodeCommand(command) {
  const encoded = /EncodedCommand (\S+)/.exec(command)?.[1];
  assert.ok(encoded, 'hook command must be an encoded PowerShell command');
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

function removeAll(directories) {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
}

test('installs a project adapter without a live workspace and repeats cleanly', async t => {
  const root = temp('winmux-project-adapter-');
  const dataDir = temp('winmux-project-adapter-data-');
  t.after(() => removeAll([root, dataDir]));
  const first = await installProjectAgentHooks({
    projectRoot: root,
    dataDir,
    agent: 'pi',
    nodePath: process.execPath,
  });
  assert.equal(first.status, 'installed');
  assert.equal(first.workspaceId, undefined);
  assert.ok(fs.existsSync(path.join(root, '.pi', 'extensions', 'winmux-status.ts')));
  assert.ok(fs.existsSync(path.join(dataDir, 'hooks', 'winmux-agent-event.cjs')));
  const second = await installProjectAgentHooks({
    projectRoot: root,
    dataDir,
    agent: 'pi',
    nodePath: process.execPath,
  });
  assert.equal(second.status, 'unchanged');
});

test('installed adapters actually load their embedded configuration at runtime', async t => {
  const root = temp('winmux-adapter-runtime-');
  const dataDir = path.join(root, 'data'), helperRoot = path.join(root, 'templates'), home = path.join(root, 'profile');
  for (const directory of [dataDir, helperRoot, home]) fs.mkdirSync(directory);
  t.after(() => removeAll([root]));
  const bundled = path.join(__dirname, '../electron/hooks');
  for (const name of ['winmux-pi-extension.mjs', 'winmux-hermes-plugin.py']) fs.copyFileSync(path.join(bundled, name), path.join(helperRoot, name));
  // Replace only the IPC boundary; the installed default extension still has
  // to decode its config and spawn the configured executable/helper itself.
  fs.writeFileSync(path.join(helperRoot, 'winmux-agent-event.cjs'), `// winmux-agent-event\nconst fs=require('node:fs'),path=require('node:path');(async()=>{let raw='';for await(const chunk of process.stdin)raw+=chunk;JSON.parse(raw);fs.writeFileSync(path.join(process.argv[process.argv.indexOf('--data-dir')+1],'delivered.json'),raw);})().catch(()=>process.exitCode=1);`);
  const installed = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'pi' }, { dataDir, helperRoot, nodePath: process.execPath });
  const source = fs.readFileSync(installed.extensionPath, 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const handlers = new Map();
  module.default({ on(name, handler) { handlers.set(name, handler); } });
  const sent = await handlers.get('session_start')({ reason: 'startup' }, { hasUI: true, cwd: root, sessionManager: { getSessionId: () => 'runtime-root' } });
  assert.equal(sent, true, 'the installed default transport must receive its configured paths');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'delivered.json'), 'utf8')).sessionId, 'runtime-root');

  const hermes = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'hermes', hermesHome: home }, { dataDir, helperRoot, nodePath: process.execPath });
  const python = (process.platform === 'win32' ? ['python.exe', 'python', 'py'] : ['python3', 'python']).find(command => spawnSync(command, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() === '3');
  assert.ok(python, 'Python 3 is required to load the installed Hermes adapter');
  const loaded = spawnSync(python, ['-c', 'import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])["_load_config"]()))', path.join(hermes.pluginPath, '__init__.py')], { encoding: 'utf8', windowsHide: true });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(JSON.parse(loaded.stdout), { dataDir, helperPath: hermes.helperPath, nodePath: process.execPath });
});

test('merges Claude settings.local.json without global config edits and repeats cleanly', async t => {
  const root = temp('winmux-claude-project-');
  const dataDir = temp('winmux-claude-data-');
  t.after(() => removeAll([root, dataDir]));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir);
  const original = {
    permissions: { allow: ['Read'] },
    hooks: {
      Stop: [{ matcher: 'keep', hooks: [{ type: 'command', command: 'foreign' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'notify-user' }] }],
    },
  };
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  const globalSettings = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(original));
  fs.writeFileSync(globalSettings, '{"global":true}\n');

  const first = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'claude' }, {
    dataDir,
    nodePath: process.execPath,
  });
  const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(first.status, 'updated');
  assert.equal(first.requiresTrustReview, true);
  assert.equal(first.requiresEnable, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.backupPath, 'utf8')), original);
  assert.equal(fs.readFileSync(globalSettings, 'utf8'), '{"global":true}\n');
  assert.deepEqual(merged.permissions, original.permissions);
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'foreign');
  assert.equal(merged.hooks.Notification[0].hooks[0].command, 'notify-user');
  assert.equal(merged.hooks.Notification.length, 1);
  for (const event of CLAUDE_EVENTS) {
    const owned = merged.hooks[event].find(group => group.hooks?.[0]?.statusMessage === CLAUDE_OWNED_STATUS);
    assert.ok(owned, event);
    assert.equal(owned.matcher, undefined);
    const decoded = decodeCommand(owned.hooks[0].command);
    assert.match(decoded, /'--agent' 'claude'/);
    assert.match(decoded, /winmux-agent-event\.cjs/);
    assert.equal(decoded.includes('hermes'), false);
  }
  const helperMtime = fs.statSync(first.helperPath).mtimeMs;
  const configMtime = fs.statSync(settingsPath).mtimeMs;
  const second = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'claude' }, {
    dataDir,
    nodePath: process.execPath,
  });
  assert.equal(second.status, 'unchanged');
  assert.equal(second.backupPath, undefined);
  assert.equal(fs.statSync(settingsPath).mtimeMs, configMtime);
  assert.equal(fs.statSync(first.helperPath).mtimeMs, helperMtime);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), merged);
});

test('rejects a Claude hook conflict and a dangling settings link without replacing them', async t => {
  const root = temp('winmux-claude-conflict-');
  const dataDir = temp('winmux-claude-conflict-data-');
  const outside = temp('winmux-claude-outside-');
  t.after(() => removeAll([root, dataDir, outside]));
  const settingsPath = path.join(root, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const mixed = {
    hooks: {
      Stop: [{ hooks: [
        { type: 'command', command: 'foreign' },
        { type: 'command', command: 'owned', statusMessage: CLAUDE_OWNED_STATUS },
      ] }],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(mixed));
  await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'claude' }, {
    dataDir,
    nodePath: process.execPath,
  }), { code: 'CONFIG_CONFLICT' });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), JSON.stringify(mixed));

  fs.rmSync(settingsPath);
  try {
    fs.symlinkSync(path.join(outside, 'missing.json'), settingsPath, 'file');
    const before = fs.readlinkSync(settingsPath);
    await assert.rejects(() => installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'claude' }, {
      dataDir,
      nodePath: process.execPath,
    }), { code: 'CONFIG_UNSAFE' });
    assert.equal(fs.readlinkSync(settingsPath), before);
    assert.deepEqual(fs.readdirSync(outside), []);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  }
});

function captured(file) {
  return { body: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
}

function assertUnchanged(file, before) {
  assert.deepEqual(fs.readFileSync(file), before.body);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
}

test('rejects foreign Hermes manifest aliases and source before writing', async t => {
  const project = temp('winmux-hermes-foreign-project-');
  const dirs = [project];
  t.after(() => removeAll(dirs));
  const config = 'plugins:\n  enabled: ["foreign"]\n';
  const foreignSource = 'def register(ctx):\n    raise RuntimeError("foreign")\n';
  const cases = [
    ['yml', { 'plugin.yml': 'name: someone-else\n', '__init__.py': foreignSource }],
    ['json', { 'plugin.json': '{"name":"someone-else"}\n', '__init__.py': foreignSource }],
    ['source', { '__init__.py': foreignSource }],
    ['owned-manifest', {
      'plugin.yaml': `# ${HERMES_PLUGIN_MARKER}\nname: winmux-status\nversion: "9.9.9"\n`,
      '__init__.py': foreignSource,
    }],
  ];
  for (const [label, files] of cases) {
    const home = temp(`winmux-hermes-foreign-${label}-`);
    const dataDir = temp(`winmux-hermes-foreign-${label}-data-`);
    dirs.push(home, dataDir);
    const pluginDir = path.join(home, 'plugins', 'winmux-status');
    fs.mkdirSync(pluginDir, { recursive: true });
    const configPath = path.join(home, 'config.yaml');
    fs.writeFileSync(configPath, config);
    const before = new Map();
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(pluginDir, name);
      fs.writeFileSync(file, content);
      before.set(file, captured(file));
    }
    const configBefore = captured(configPath);
    const listing = fs.readdirSync(pluginDir).sort();
    await assert.rejects(() => installAgentHooks(fixture(project), {
      workspaceId: 'workspace-1',
      agent: 'hermes',
      hermesHome: home,
    }, { dataDir, nodePath: process.execPath }), { code: 'CONFIG_CONFLICT' });
    assert.deepEqual(fs.readdirSync(pluginDir).sort(), listing);
    for (const [file, snapshot] of before) assertUnchanged(file, snapshot);
    assertUnchanged(configPath, configBefore);
    assert.equal(fs.existsSync(path.join(dataDir, 'hooks', 'winmux-agent-event.cjs')), false);
    assert.equal(fs.existsSync(path.join(pluginDir, 'plugin.yaml')) && !files['plugin.yaml'], false);
  }
});

test('backs up an owned Hermes plugin before upgrading and repairs an owned partial plugin', async t => {
  const project = temp('winmux-hermes-upgrade-project-');
  const dataDir = temp('winmux-hermes-upgrade-data-');
  const home = temp('winmux-hermes-upgrade-home-');
  const partial = temp('winmux-hermes-upgrade-partial-');
  t.after(() => removeAll([project, dataDir, home, partial]));
  const configPath = path.join(home, 'config.yaml');
  const config = 'plugins:\n  enabled: []\n';
  fs.writeFileSync(configPath, config);
  const configBefore = captured(configPath);
  await installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: home,
  }, { dataDir, nodePath: process.execPath });
  const pluginDir = path.join(home, 'plugins', 'winmux-status');
  const manifestPath = path.join(pluginDir, 'plugin.yaml');
  const pythonPath = path.join(pluginDir, '__init__.py');
  const canonicalManifest = fs.readFileSync(manifestPath);
  const canonicalPython = fs.readFileSync(pythonPath);
  fs.writeFileSync(manifestPath, canonicalManifest.toString('utf8').replace('version: "1.0.0"', 'version: "0.9.0"'));
  fs.writeFileSync(pythonPath, `${canonicalPython.toString('utf8')}\n# owned local note\n`);
  const ownedManifest = captured(manifestPath);
  const ownedPython = captured(pythonPath);
  const upgraded = await installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: home,
  }, { dataDir, nodePath: process.execPath });
  assert.equal(upgraded.status, 'updated');
  assert.equal(upgraded.backupPaths.length, 2);
  assert.deepEqual(fs.readFileSync(upgraded.backupPaths.find(file => file.includes('plugin.yaml'))), ownedManifest.body);
  assert.deepEqual(fs.readFileSync(upgraded.backupPaths.find(file => file.includes('__init__.py'))), ownedPython.body);
  assert.equal(fs.readFileSync(manifestPath, 'utf8').includes('version: "1.0.0"'), true);
  assert.equal(fs.readFileSync(pythonPath, 'utf8').includes('owned local note'), false);
  assert.match(fs.readFileSync(pythonPath, 'utf8'), new RegExp(HERMES_PLUGIN_MARKER));
  assertUnchanged(configPath, configBefore);
  const upgradedManifest = captured(manifestPath);
  const upgradedPython = captured(pythonPath);
  const repeated = await installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: home,
  }, { dataDir, nodePath: process.execPath });
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.backupPaths, undefined);
  assert.equal(fs.readdirSync(pluginDir).filter(name => name.endsWith('.bak')).length, 2);
  assertUnchanged(manifestPath, upgradedManifest);
  assertUnchanged(pythonPath, upgradedPython);
  assertUnchanged(configPath, configBefore);

  const partialDir = path.join(partial, 'plugins', 'winmux-status');
  fs.mkdirSync(partialDir, { recursive: true });
  const partialManifest = path.join(partialDir, 'plugin.yaml');
  fs.writeFileSync(partialManifest, canonicalManifest);
  const partialBefore = captured(partialManifest);
  const repaired = await installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: partial,
  }, { dataDir, nodePath: process.execPath });
  assert.equal(repaired.status, 'updated');
  assert.equal(repaired.backupPaths, undefined);
  assertUnchanged(partialManifest, partialBefore);
  assert.match(fs.readFileSync(path.join(partialDir, '__init__.py'), 'utf8'), new RegExp(HERMES_PLUGIN_MARKER));
  assert.equal(fs.existsSync(path.join(partial, 'config.yaml')), false);
});

test('installs the discovered Pi .ts extension, keeps foreign files, and rejects conflicts', async t => {
  const root = temp('winmux-pi-project-');
  const dataDir = temp('winmux-pi-data-');
  t.after(() => removeAll([root, dataDir]));
  const extensionDir = path.join(root, '.pi', 'extensions');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, 'foreign.js'), 'export default function () {}\n');
  fs.writeFileSync(path.join(root, '.pi', 'settings.json'), '{"theme":"keep"}\n');

  const first = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'pi' }, {
    dataDir,
    nodePath: process.execPath,
  });
  const extensionPath = path.join(extensionDir, 'winmux-status.ts');
  assert.equal(first.status, 'installed');
  assert.equal(first.extensionPath, extensionPath);
  assert.equal(first.requiresRestart, true);
  assert.equal(first.requiresTrustReview, false);
  assert.equal(fs.existsSync(path.join(extensionDir, 'winmux-status.mjs')), false);
  assert.equal(fs.readFileSync(path.join(root, '.pi', 'settings.json'), 'utf8'), '{"theme":"keep"}\n');
  assert.equal(fs.readFileSync(path.join(extensionDir, 'foreign.js'), 'utf8'), 'export default function () {}\n');
  const content = fs.readFileSync(extensionPath, 'utf8');
  assert.match(content, new RegExp(PI_EXTENSION_MARKER));
  assert.equal(content.match(/__WINMUX_CONFIG_B64__/g)?.length, 1, 'the unconfigured sentinel remains distinct from the embedded config');
  const discovered = fs.globSync('*.{ts,js}', { cwd: extensionDir }).sort();
  assert.deepEqual(discovered, ['foreign.js', 'winmux-status.ts']);
  const extensionMtime = fs.statSync(extensionPath).mtimeMs;
  const second = await installAgentHooks(fixture(root), { workspaceId: 'workspace-1', agent: 'pi' }, {
    dataDir,
    nodePath: process.execPath,
  });
  assert.equal(second.status, 'unchanged');
  assert.equal(fs.statSync(extensionPath).mtimeMs, extensionMtime);

  const conflictRoot = temp('winmux-pi-conflict-');
  const conflictData = temp('winmux-pi-conflict-data-');
  t.after(() => removeAll([conflictRoot, conflictData]));
  const conflictPath = path.join(conflictRoot, '.pi', 'extensions', 'winmux-status.ts');
  fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
  fs.writeFileSync(conflictPath, 'user extension\n');
  await assert.rejects(() => installAgentHooks(fixture(conflictRoot), { workspaceId: 'workspace-1', agent: 'pi' }, {
    dataDir: conflictData,
    nodePath: process.execPath,
  }), { code: 'CONFIG_CONFLICT' });
  assert.equal(fs.readFileSync(conflictPath, 'utf8'), 'user extension\n');
  assert.equal(fs.existsSync(path.join(conflictData, 'hooks', 'winmux-agent-event.cjs')), false);

  const linkRoot = temp('winmux-pi-link-');
  const linkData = temp('winmux-pi-link-data-');
  const linkOutside = temp('winmux-pi-link-outside-');
  t.after(() => removeAll([linkRoot, linkData, linkOutside]));
  const linkDir = path.join(linkRoot, '.pi', 'extensions');
  fs.mkdirSync(linkDir, { recursive: true });
  const linkPath = path.join(linkDir, 'winmux-status.ts');
  try {
    fs.symlinkSync(path.join(linkOutside, 'missing.ts'), linkPath, 'file');
    const before = fs.readlinkSync(linkPath);
    await assert.rejects(() => installAgentHooks(fixture(linkRoot), { workspaceId: 'workspace-1', agent: 'pi' }, {
      dataDir: linkData,
      nodePath: process.execPath,
    }), { code: 'EXTENSION_UNSAFE' });
    assert.equal(fs.readlinkSync(linkPath), before);
    assert.deepEqual(fs.readdirSync(linkOutside), []);
    assert.equal(fs.existsSync(path.join(linkData, 'hooks', 'winmux-agent-event.cjs')), false);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  }
});

test('installs a disabled Hermes profile plugin and resolves only a validated profile path', async t => {
  const project = temp('winmux-hermes-project-');
  const dataDir = temp('winmux-hermes-data-');
  const selected = temp('winmux-hermes-profile-');
  const profile = path.join(selected, 'profile dir');
  const optionHome = temp('winmux-hermes-option-');
  const envHome = temp('winmux-hermes-env-');
  fs.mkdirSync(profile);
  const configPath = path.join(profile, 'config.yaml');
  const config = 'plugins:\n  enabled: []\n';
  fs.writeFileSync(configPath, config);
  const previous = process.env.HERMES_HOME;
  process.env.HERMES_HOME = envHome;
  t.after(() => {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
    removeAll([project, dataDir, selected, optionHome, envHome]);
  });

  const first = await installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: profile,
  }, { dataDir, nodePath: process.execPath, hermesHome: optionHome });
  const pluginDir = path.join(profile, 'plugins', 'winmux-status');
  assert.equal(first.status, 'installed');
  assert.equal(first.pluginPath, pluginDir);
  assert.equal(first.requiresEnable, true);
  assert.equal(first.enableCommand, 'hermes plugins enable winmux-status');
  assert.equal(first.requiresRestart, true);
  assert.equal(first.enableCommand.includes(profile), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), config);
  assert.equal(fs.existsSync(path.join(optionHome, 'plugins')), false);
  assert.equal(fs.existsSync(path.join(envHome, 'plugins')), false);
  const manifest = fs.readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8');
  assert.match(manifest, new RegExp(HERMES_PLUGIN_MARKER));
  assert.match(manifest, /name: winmux-status/);
  assert.deepEqual([...manifest.matchAll(/^ {2}- (\S+)/gm)].map(match => match[1]), [...HERMES_HOOKS]);
  const python = fs.readFileSync(path.join(pluginDir, '__init__.py'), 'utf8');
  assert.equal(python.match(/__WINMUX_CONFIG_B64__/g)?.length, 1, 'the Python sentinel is not replaced with its configured value');
  assert.match(python, new RegExp(HERMES_PLUGIN_MARKER));
  const manifestMtime = fs.statSync(path.join(pluginDir, 'plugin.yaml')).mtimeMs;
  const configMtime = fs.statSync(configPath).mtimeMs;
  const second = await installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: profile,
  }, { dataDir, nodePath: process.execPath });
  assert.equal(second.status, 'unchanged');
  assert.equal(fs.statSync(path.join(pluginDir, 'plugin.yaml')).mtimeMs, manifestMtime);
  assert.equal(fs.statSync(configPath).mtimeMs, configMtime);

  const cleanHome = temp('winmux-hermes-clean-');
  t.after(() => fs.rmSync(cleanHome, { recursive: true, force: true }));
  await installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: cleanHome,
  }, { dataDir, nodePath: process.execPath });
  assert.equal(fs.existsSync(path.join(cleanHome, 'config.yaml')), false);

  for (const hermesHome of ['--profile', path.join(profile, '..', 'ignored --enable'), 'relative\\hermes', `${profile} & calc`]) {
    await assert.rejects(() => installAgentHooks(fixture(project), {
      workspaceId: 'workspace-1',
      agent: 'hermes',
      hermesHome,
    }, { dataDir, nodePath: process.execPath }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), config);
});

test('rejects a foreign or dangling Hermes plugin without writing config or the helper', async t => {
  const project = temp('winmux-hermes-reject-project-');
  const dataDir = temp('winmux-hermes-reject-data-');
  const home = temp('winmux-hermes-reject-home-');
  const outside = temp('winmux-hermes-reject-outside-');
  t.after(() => removeAll([project, dataDir, home, outside]));
  const pluginDir = path.join(home, 'plugins', 'winmux-status');
  fs.mkdirSync(pluginDir, { recursive: true });
  const config = 'plugins:\n  enabled: ["other"]\n';
  fs.writeFileSync(path.join(home, 'config.yaml'), config);
  fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), 'name: someone-else\n');
  await assert.rejects(() => installAgentHooks(fixture(project), {
    workspaceId: 'workspace-1',
    agent: 'hermes',
    hermesHome: home,
  }, { dataDir, nodePath: process.execPath }), { code: 'CONFIG_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8'), 'name: someone-else\n');
  assert.equal(fs.existsSync(path.join(pluginDir, '__init__.py')), false);
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), config);
  assert.equal(fs.existsSync(path.join(dataDir, 'hooks', 'winmux-agent-event.cjs')), false);

  fs.rmSync(path.join(pluginDir, 'plugin.yaml'));
  try {
    const link = path.join(pluginDir, 'plugin.yaml');
    fs.symlinkSync(path.join(outside, 'missing.yaml'), link, 'file');
    const before = fs.readlinkSync(link);
    await assert.rejects(() => installAgentHooks(fixture(project), {
      workspaceId: 'workspace-1',
      agent: 'hermes',
      hermesHome: home,
    }, { dataDir, nodePath: process.execPath }), { code: 'EXTENSION_UNSAFE' });
    assert.equal(fs.readlinkSync(link), before);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), config);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  }
});
