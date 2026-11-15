'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { once } = require('node:events');
const { installSkills } = require('../electron/skills-install.cjs');
const { SKILL_DESTINATIONS, readBundledSkills } = require('../electron/skills-local-installer.cjs');
const { connect } = require('../electron/client.cjs');

const valid = { workspaceId: 'workspace-1', agent: 'codex' };

function fixture({ cwd, profileId = 'powershell', profile } = {}) {
  const selected = {
    id: valid.workspaceId,
    profileId,
    cwd: cwd || 'E:\\project',
    panes: [],
  };
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'state') return { workspaces: [selected] };
      if (method === 'environment') return {
        profiles: [profile || { id: profileId, environment: profileId.startsWith('wsl:') ? 'wsl' : 'windows' }],
      };
      throw new Error(`Unexpected request: ${method}`);
    },
  };
  return { client, calls };
}

function tempProject(t, prefix = 'winmux-skills-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtimeOptions(t) {
  const dataDir = tempProject(t, 'winmux-runtime-');
  return { dataDir, appRoot: path.resolve(__dirname, '..') };
}

async function waitForDaemon(dataDir, child, logs) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Isolated daemon exited ${child.exitCode}:\n${logs.join('')}`);
    try {
      const client = await connect({ dataDir, connectTimeout: 500, requestTimeout: 1000 });
      client.close();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Isolated daemon did not become ready: ${lastError?.message}\n${logs.join('')}`);
}

async function isolatedDaemon(t) {
  const dataDir = tempProject(t, 'winmux-ipc-');
  const electron = require('electron');
  assert.equal(typeof electron, 'string');
  const logs = [];
  const child = spawn(electron, [path.resolve(__dirname, '..', 'electron', 'backend.cjs')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WINMUX_DATA_DIR: dataDir,
      WINMUX_NO_PROFILE: '1',
      WINMUX_TEST_MODE: '1',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
  });
  await waitForDaemon(dataDir, child, logs);
  return { dataDir, child, logs };
}

function listRelativeFiles(root) {
  const files = [];
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const itemRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(item, itemRelative);
      else files.push(itemRelative.replace(/\\/g, '/'));
    }
  }
  visit(root);
  return files.sort();
}

function decodeWslOutput(buffer) {
  return (buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/^\uFEFF/, '').trim();
}

function availableWslDistribution() {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('wsl.exe', ['--list', '--quiet'], { windowsHide: true, timeout: 10000 });
  if (result.status !== 0) return null;
  return decodeWslOutput(result.stdout).split(/\r?\n/).map(line => line.trim()).find(Boolean) || null;
}

function wsl(distribution, args, options = {}) {
  return spawnSync('wsl.exe', ['--distribution', distribution, '--exec', ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
    ...options,
  });
}

test('rejects arbitrary sources, skills, global flags and malformed identities before daemon access', async () => {
  const invalid = [
    null,
    [],
    {},
    { workspaceId: 'workspace-1' },
    { agent: 'codex' },
    { ...valid, source: 'vercel-labs/agent-skills' },
    { ...valid, skill: 'web-design-guidelines' },
    { ...valid, global: true },
    { ...valid, source: 'samo33ddd/winmux', skill: 'winmux-terminal' },
    { ...valid, workspaceId: '' },
    { ...valid, workspaceId: '../workspace' },
    { ...valid, workspaceId: 'workspace\n1' },
    { ...valid, agent: '' },
    { ...valid, agent: 'unknown' },
    { ...valid, agent: 'codex;whoami' },
  ];
  for (const params of invalid) {
    const { client, calls } = fixture();
    await assert.rejects(installSkills(client, params), { code: 'INVALID_ARGUMENT' }, JSON.stringify(params));
    assert.deepEqual(calls, []);
  }
});

test('the package contains exactly the two valid Winmux skills', () => {
  assert.deepEqual(SKILL_DESTINATIONS, {
    'codex': '.agents/skills',
    'claude-code': '.claude/skills',
    'opencode': '.agents/skills',
    'cursor': '.agents/skills',
    'gemini-cli': '.agents/skills',
    'github-copilot': '.agents/skills',
    'pi': '.agents/skills',
    'hermes-agent': '.hermes/skills',
  });
  const bundled = readBundledSkills();
  assert.deepEqual(bundled.map(skill => skill.name), ['winmux-terminal', 'winmux-browser']);
  for (const skill of bundled) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'skills', skill.name, 'SKILL.md'));
    assert.deepEqual(skill.content, source);
    assert.match(skill.content.toString('utf8'), new RegExp(`^---\\nname: ${skill.name}\\n`));
    assert.ok(skill.files.some(file => file.relative === 'scripts/winmux-client.cjs'));
    assert.doesNotMatch(skill.content.toString('utf8'), /[a-f0-9]{64}/i);
  }
});

test('installed Windows wrapper uses a plain runtime and authenticated IPC from an unrelated cwd', async t => {
  const daemon = await isolatedDaemon(t);
  const project = tempProject(t);
  const unrelated = tempProject(t);
  const runtime = { dataDir: daemon.dataDir, appRoot: path.resolve(__dirname, '..') };
  const { client } = fixture({ cwd: project, profile: { id: 'powershell', environment: 'windows' } });

  const installed = await installSkills(client, valid, runtime);

  assert.ok(path.isAbsolute(installed.runtimeRoot));
  assert.equal(installed.runtimeRoot.includes('.asar'), false);
  assert.equal(fs.statSync(path.join(installed.runtimeRoot, 'cli.cjs')).isFile(), true);
  const connectionFile = path.join(project, '.agents', 'skills', 'winmux-terminal', 'scripts', 'connection.json');
  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  assert.deepEqual(Object.keys(connection).sort(), ['cliPath', 'dataDir']);
  assert.equal(connection.dataDir, daemon.dataDir);
  assert.equal(connection.cliPath, path.join(installed.runtimeRoot, 'cli.cjs'));
  assert.doesNotMatch(JSON.stringify(connection), /[a-f0-9]{64}|ipc-token|ui-control/i);

  const wrapper = path.join(project, '.agents', 'skills', 'winmux-terminal', 'scripts', 'winmux-client.cjs');
  const listed = spawnSync(process.execPath, [wrapper, 'list'], {
    cwd: unrelated,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, WINMUX_DATA_DIR: path.join(unrelated, 'wrong-instance') },
  });
  assert.equal(listed.status, 0, listed.stderr);
  const state = JSON.parse(listed.stdout);
  assert.ok(Array.isArray(state.workspaces));

  const started = spawnSync(process.execPath, [wrapper, 'start'], {
    cwd: unrelated,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /Open the Winmux desktop.*existing Winmux instance/);
  const live = await connect({ dataDir: daemon.dataDir, connectTimeout: 1500, requestTimeout: 2000 });
  assert.ok(Array.isArray((await live.request('state')).workspaces));
  live.close();

  const browser = path.join(project, '.agents', 'skills', 'winmux-browser', 'scripts', 'winmux-client.cjs');
  const browserHelp = spawnSync(process.execPath, [browser, '--help'], {
    cwd: unrelated,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  assert.equal(browserHelp.status, 0, browserHelp.stderr);
  assert.match(browserHelp.stdout, /Winmux browser/);
});

test('Windows creates both files for every verified agent destination and preserves unrelated skills', async t => {
  const bundled = readBundledSkills();
  const runtime = runtimeOptions(t);
  for (const [agent, relative] of Object.entries(SKILL_DESTINATIONS)) {
    const project = tempProject(t);
    const unrelated = path.join(project, relative, 'user-owned', 'SKILL.md');
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, '---\nname: user-owned\n---\nkeep\n');
    const before = fs.readFileSync(unrelated);
    const { client } = fixture({ cwd: project, profile: { id: 'powershell', environment: 'windows' } });

    const result = await installSkills(client, { ...valid, agent }, runtime);

    assert.equal(result.environment, 'windows');
    assert.equal(result.agent, agent);
    assert.equal(result.destinationRoot, path.join(fs.realpathSync(project), relative));
    assert.deepEqual(result.installedSkills, ['winmux-terminal', 'winmux-browser']);
    assert.deepEqual(result.unchangedSkills, []);
    for (const skill of bundled) {
      assert.deepEqual(fs.readFileSync(path.join(project, relative, skill.name, 'SKILL.md')), skill.content);
    }
    assert.deepEqual(fs.readFileSync(unrelated), before);
  }
});

test('a conflicting same-name skill blocks both writes and leaves all project skills intact', async t => {
  const project = tempProject(t);
  const root = path.join(project, '.agents', 'skills');
  const conflict = path.join(root, 'winmux-terminal', 'SKILL.md');
  const unrelated = path.join(root, 'custom', 'SKILL.md');
  fs.mkdirSync(path.dirname(conflict), { recursive: true });
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(conflict, 'different user content');
  fs.writeFileSync(unrelated, 'unrelated');
  const before = listRelativeFiles(root);
  const { client } = fixture({ cwd: project, profile: { id: 'powershell', environment: 'windows' } });

  await assert.rejects(installSkills(client, valid, runtimeOptions(t)), { code: 'SKILL_CONFLICT' });

  assert.deepEqual(listRelativeFiles(root), before);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'different user content');
  assert.equal(fs.existsSync(path.join(root, 'winmux-browser')), false);
});

test('an exact existing skill is unchanged while the missing skill is installed', async t => {
  const project = tempProject(t);
  const runtime = runtimeOptions(t);
  const terminalRoot = path.join(project, '.agents', 'skills', 'winmux-terminal');
  const terminal = path.join(terminalRoot, 'SKILL.md');
  const { client } = fixture({ cwd: project, profile: { id: 'powershell', environment: 'windows' } });

  await installSkills(client, valid, runtime);
  fs.rmSync(path.join(project, '.agents', 'skills', 'winmux-browser'), { recursive: true, force: true });
  const before = fs.statSync(terminal).mtimeMs;

  const result = await installSkills(client, valid, runtime);

  assert.deepEqual(result.installedSkills, ['winmux-browser']);
  assert.deepEqual(result.unchangedSkills, ['winmux-terminal']);
  assert.equal(fs.statSync(terminal).mtimeMs, before);
  assert.deepEqual(fs.readFileSync(path.join(project, '.agents', 'skills', 'winmux-browser', 'SKILL.md')),
    readBundledSkills().find(skill => skill.name === 'winmux-browser').content);
});

test('Windows fails before writing when the destination escapes through a symlink', async t => {
  const project = tempProject(t);
  const outside = tempProject(t);
  try {
    fs.symlinkSync(outside, path.join(project, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    assert.fail(`UNVERIFIED: Windows junction containment fixture could not be created: ${error.code || error.message}`);
  }
  const { client } = fixture({ cwd: project, profile: { id: 'powershell', environment: 'windows' } });
  await assert.rejects(installSkills(client, valid, runtimeOptions(t)), { code: 'UNSAFE_DESTINATION' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

const distribution = availableWslDistribution();

test(distribution
  ? 'unavailable WSL profiles reject before writes or Winmux client launch'
  : 'WSL distribution unavailable: profile rejection is verified; WSL runtime is unverified', async t => {
  const project = tempProject(t);
  const dataDir = path.join(project, 'uncreated-runtime');
  const spawned = t.mock.method(require('node:child_process').ChildProcess.prototype, 'spawn', () => {
    assert.fail('An unavailable WSL profile must not launch a Winmux client or installer.');
  });
  const writers = ['mkdirSync', 'writeFileSync', 'renameSync', 'copyFileSync'].map(method =>
    t.mock.method(fs, method, () => {
      assert.fail(`An unavailable WSL profile must not call fs.${method}.`);
    }));
  try {
    for (const profile of [
      { id: 'wsl:Unavailable', environment: 'wsl', available: false },
      { id: 'powershell', environment: 'windows', available: true },
    ]) {
      const { client, calls } = fixture({ cwd: project, profileId: 'wsl:Unavailable', profile });
      await assert.rejects(installSkills(client, valid, { dataDir }), { code: 'PROFILE_UNAVAILABLE' });
      assert.deepEqual(calls, [
        { method: 'state', params: undefined },
        { method: 'environment', params: undefined },
      ]);
    }
    assert.equal(spawned.mock.callCount(), 0);
    for (const writer of writers) assert.equal(writer.mock.callCount(), 0);
    assert.deepEqual(fs.readdirSync(project), []);
    assert.equal(fs.existsSync(dataDir), false);
  } finally {
    spawned.mock.restore();
    for (const writer of writers) writer.mock.restore();
  }
});

if (distribution) {
  test('WSL writes and verifies the exact two skill files in an isolated Linux project', async t => {
    const made = wsl(distribution, ['mktemp', '-d', '/tmp/winmux-skills-test-XXXXXX']);
    assert.equal(made.status, 0, made.stderr);
    const project = made.stdout.trim();
    t.after(() => wsl(distribution, ['rm', '-rf', '--', project]));

    const preset = wsl(distribution, ['python3', '-c',
      'import os,sys; p=os.path.join(sys.argv[1],".claude","skills","user-owned"); os.makedirs(p); open(os.path.join(p,"SKILL.md"),"w").write("keep")',
      project]);
    assert.equal(preset.status, 0, preset.stderr);
    const { client } = fixture({
      cwd: project,
      profileId: `wsl:${distribution}`,
      profile: {
        id: `wsl:${distribution}`,
        environment: 'wsl',
        command: 'wsl.exe',
        args: ['--distribution', distribution],
        distro: distribution,
      },
    });
    const runtime = runtimeOptions(t);

    const firstAgentByDestination = new Map();
    for (const [agent, relative] of Object.entries(SKILL_DESTINATIONS)) {
      const result = await installSkills(client, { ...valid, agent }, runtime);
      assert.equal(result.environment, 'wsl');
      assert.equal(result.destinationRoot, `${project}/${relative}`);
      if (firstAgentByDestination.has(relative)) {
        assert.deepEqual(result.installedSkills, []);
        assert.deepEqual(result.unchangedSkills, ['winmux-terminal', 'winmux-browser']);
      } else {
        firstAgentByDestination.set(relative, agent);
        assert.deepEqual(result.installedSkills, ['winmux-terminal', 'winmux-browser']);
        assert.deepEqual(result.unchangedSkills, []);
      }
    }
    for (const relative of firstAgentByDestination.keys()) {
      for (const skill of readBundledSkills()) {
        const installed = wsl(distribution, ['cat', `${project}/${relative}/${skill.name}/SKILL.md`]);
        assert.equal(installed.status, 0, installed.stderr);
        assert.deepEqual(Buffer.from(installed.stdout), skill.content);
      }
    }
    const unrelated = wsl(distribution, ['cat', `${project}/.claude/skills/user-owned/SKILL.md`]);
    assert.equal(unrelated.stdout, 'keep');
  });

  test('installed WSL wrapper uses Windows Node interop for authenticated IPC', async t => {
    const linuxNode = wsl(distribution, ['node', '--version']);
    assert.equal(linuxNode.status, 0, `UNVERIFIED: installed WSL wrapper IPC requires Node.js in ${distribution}: ${linuxNode.stderr}`);
    const made = wsl(distribution, ['mktemp', '-d', '/tmp/winmux-installed-wrapper-XXXXXX']);
    assert.equal(made.status, 0, made.stderr);
    const project = made.stdout.trim();
    t.after(() => wsl(distribution, ['rm', '-rf', '--', project]));
    const daemon = await isolatedDaemon(t);
    const { client } = fixture({
      cwd: project,
      profileId: `wsl:${distribution}`,
      profile: {
        id: `wsl:${distribution}`,
        environment: 'wsl',
        command: 'wsl.exe',
        args: ['--distribution', distribution],
        distro: distribution,
      },
    });
    await installSkills(client, valid, { dataDir: daemon.dataDir, appRoot: path.resolve(__dirname, '..') });
    const wrapper = `${project}/.agents/skills/winmux-terminal/scripts/winmux-client.cjs`;

    const unsupported = wsl(distribution, ['node', wrapper, 'list'], {
      env: {
        ...process.env,
        WINMUX_WINDOWS_NODE: '/definitely/missing/winmux-node.exe',
        WINMUX_AGENT_NODE: '',
        WSLENV: [process.env.WSLENV, 'WINMUX_WINDOWS_NODE'].filter(Boolean).join(':'),
      },
    });
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /Windows Node\.js is unavailable/);

    const wslEnv = {
      ...process.env,
      WINMUX_WINDOWS_NODE: process.execPath,
      WINMUX_AGENT_NODE: '',
      WSLENV: [process.env.WSLENV, 'WINMUX_WINDOWS_NODE'].filter(Boolean).join(':'),
    };
    const listed = wsl(distribution, ['node', wrapper, 'list'], { env: wslEnv });
    assert.equal(listed.status, 0, listed.stderr);
    const state = JSON.parse(listed.stdout);
    assert.ok(Array.isArray(state.workspaces));

    const metadata = wsl(distribution, ['cat', `${project}/.agents/skills/winmux-terminal/scripts/connection.json`]);
    assert.equal(metadata.status, 0, metadata.stderr);
    const connection = JSON.parse(metadata.stdout);
    assert.deepEqual(Object.keys(connection).sort(), ['cliPath', 'dataDir']);
    assert.equal(connection.dataDir, daemon.dataDir);
    assert.doesNotMatch(metadata.stdout, /[a-f0-9]{64}|ipc-token|ui-control/i);
  });

  test('WSL conflict validation changes neither the conflicting nor missing skill', async t => {
    const made = wsl(distribution, ['mktemp', '-d', '/tmp/winmux-skills-conflict-XXXXXX']);
    assert.equal(made.status, 0, made.stderr);
    const project = made.stdout.trim();
    t.after(() => wsl(distribution, ['rm', '-rf', '--', project]));
    const preset = wsl(distribution, ['python3', '-c',
      'import os,sys; p=os.path.join(sys.argv[1],".agents","skills","winmux-terminal"); os.makedirs(p); open(os.path.join(p,"SKILL.md"),"w").write("user content")',
      project]);
    assert.equal(preset.status, 0, preset.stderr);
    const { client } = fixture({
      cwd: project,
      profileId: `wsl:${distribution}`,
      profile: {
        id: `wsl:${distribution}`,
        environment: 'wsl',
        command: 'wsl.exe',
        args: ['--distribution', distribution],
        distro: distribution,
      },
    });

    await assert.rejects(installSkills(client, valid, runtimeOptions(t)), { code: 'SKILL_CONFLICT' });

    const conflict = wsl(distribution, ['cat', `${project}/.agents/skills/winmux-terminal/SKILL.md`]);
    const missing = wsl(distribution, ['test', '!', '-e', `${project}/.agents/skills/winmux-browser`]);
    assert.equal(conflict.stdout, 'user content');
    assert.equal(missing.status, 0);
  });
}

test('settings shows only two fixed skills, submits a fixed payload and reports EN/RU success and failure', async () => {
  const { build } = require('esbuild');
  const { chromium } = require('playwright');
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { SkillsSettings } from './src/SkillsSettings';
        import { setLanguage } from './src/i18n';
        window.requests = []; window.started = [];
        window.winmux = { call: async (method, params) => {
          window.requests.push({method, params});
          if (window.failLaunch) throw new Error('Install conflict');
          return {
            workspaceId: params.workspaceId,
            environment: params.workspaceId === 'workspace-2' ? 'wsl' : 'windows',
            agent: params.agent,
            destinationRoot: params.workspaceId === 'workspace-2' ? '/home/user/project/.claude/skills' : 'E:/project/.agents/skills',
            installedSkills: ['winmux-terminal', 'winmux-browser'],
            unchangedSkills: [],
            skills: [
              {name:'winmux-terminal',status:'install',path:'terminal'},
              {name:'winmux-browser',status:'install',path:'browser'}
            ]
          };
        }};
        const root = createRoot(document.getElementById('root'));
        window.renderSkills = (language = 'en', empty = false) => {
          setLanguage(language);
          root.render(<SkillsSettings workspaces={empty ? [] : [
            {id:'workspace-1',name:'Windows project',profileId:'powershell',cwd:'E:/project',panes:[]},
            {id:'workspace-2',name:'WSL project',profileId:'wsl:Ubuntu',cwd:'/home/user/project',panes:[]}
          ]} activeWorkspaceId="workspace-2" onStarted={(workspaceId,paneId)=>window.started.push({workspaceId,paneId})} />);
        };
        window.renderSkills();
      `,
      resolveDir: path.resolve(__dirname, '..'),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'silent',
  });
  const executablePath = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find(file => fs.existsSync(file));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('heading', { name: 'Winmux skills' }).waitFor();
    assert.equal(await page.getByTestId('skills-workspace').inputValue(), 'workspace-2');
    assert.equal(await page.getByTestId('skills-destination').textContent(), 'Destination: /home/user/project/.agents/skills');
    assert.equal(await page.getByTestId('skills-skill-winmux-terminal').getByRole('code').first().textContent(), 'winmux-terminal');
    assert.equal(await page.getByTestId('skills-skill-winmux-browser').getByRole('code').first().textContent(), 'winmux-browser');
    assert.deepEqual(await page.getByTestId('skills-agent').locator('option').evaluateAll(options => options.map(option => option.value)), [
      'codex', 'claude-code', 'opencode', 'cursor', 'gemini-cli', 'github-copilot', 'pi', 'hermes-agent',
    ]);
    assert.equal(await page.getByTestId('skills-source').count(), 0);
    assert.equal(await page.getByTestId('skills-name').count(), 0);
    assert.equal(await page.getByText('Vercel · agent-skills').count(), 0);
    assert.equal(await page.getByText('Anthropic · skills').count(), 0);

    await page.getByTestId('skills-agent').selectOption('claude-code');
    assert.equal(await page.getByTestId('skills-destination').textContent(), 'Destination: /home/user/project/.claude/skills');
    await page.getByTestId('skills-launch').click();
    await page.getByTestId('skills-result').waitFor();
    assert.match(await page.getByTestId('skills-result').textContent(), /Installation complete.*winmux-terminal.*winmux-browser/s);
    assert.deepEqual(await page.evaluate(() => window.requests), [{
      method: 'skills.install',
      params: { workspaceId: 'workspace-2', agent: 'claude-code' },
    }]);
    assert.deepEqual(await page.evaluate(() => window.started), []);

    await page.evaluate(() => window.renderSkills('ru'));
    await page.getByRole('heading', { name: 'Навыки Winmux' }).waitFor();
    await page.evaluate(() => { window.failLaunch = true; });
    await page.getByTestId('skills-launch').click();
    await page.getByTestId('skills-error').waitFor();
    assert.match(await page.getByTestId('skills-error').textContent(), /Не удалось установить навыки Winmux: Install conflict/);
    assert.equal(await page.getByTestId('skills-result').count(), 0);

    await page.evaluate(() => window.renderSkills('en', true));
    await page.getByRole('heading', { name: 'Winmux skills' }).waitFor();
    assert.equal(await page.getByTestId('skills-launch').isDisabled(), true);
  } finally {
    await browser.close();
  }
});
