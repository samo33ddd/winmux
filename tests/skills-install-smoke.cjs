'use strict';
// Isolated contract tests: never connect to the daemon or invoke an installer.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installSkills } = require('../electron/skills-install.cjs');

const valid = { workspaceId: 'workspace-1', source: 'vercel-labs/agent-skills', agent: 'codex', skill: 'web-design-guidelines' };
function fixture({ wsl = false, screens, workspace, profiles, split, inputError } = {}) {
  const profileId = wsl ? 'wsl:Ubuntu' : 'powershell';
  const cwd = wsl ? '/home/user/project with spaces' : 'E:\\project with spaces';
  const selected = workspace || { id: valid.workspaceId, profileId, cwd, panes: [{ id: 'existing-pane', cwd: 'other-cwd', profileId: 'codex' }] };
  const queue = screens ? [...screens] : [wsl ? 'bash-5.2$ ' : `PS ${cwd}> `];
  const calls = [];
  const client = { async request(method, params) {
    calls.push({ method, params });
    if (method === 'state') return { workspaces: [selected] };
    if (method === 'environment') return { profiles: profiles || [{ id: profileId, environment: wsl ? 'wsl' : 'windows' }] };
    if (method === 'pane.split') return split || { id: 'new-pane', status: 'running' };
    if (method === 'pane.screen') { const text = queue.shift(); if (text instanceof Error) throw text; return { text }; }
    if (method === 'pane.input') { if (inputError) throw inputError; return { ok: true }; }
    throw new Error(`Unexpected request: ${method}`);
  } };
  return { client, calls, cwd, profileId };
}

test('rejects malformed inputs and global overrides before any daemon call', async () => {
  const invalid = [null, [], 'source', {},
    ...['', '-repo/name', 'owner/repo;whoami', 'owner/repo\nwhoami', 'owner/repo\r', 'owner/repo\0', 'owner/../repo', '../repo', 'https://github.com/a/b', 'owner/repo --global', 'o/r$(whoami)', 'o/r`id`', 'o/r&whoami', 'o/r|whoami', 'o/r>file', ' owner/repo', 'owner/' + 'a'.repeat(101)].map(source => ({ ...valid, source })),
    ...['', '--global', '*', 'codex;whoami', 'unknown', 'codex\n', 1].map(agent => ({ ...valid, agent })),
    ...['', '--global', '*', 'a b', 'a\nb', 'a\r', '$(id)', 'a;pwd', "a'b", 'a"b', 'a`b', '../bad', 'a'.repeat(129), null, []].map(skill => ({ ...valid, skill })),
    ...['', '../id', 'id\n', 1, null].map(workspaceId => ({ ...valid, workspaceId })),
    { ...valid, global: true }, { ...valid, command: 'whoami' },
  ];
  for (const params of invalid) {
    const { client, calls } = fixture();
    await assert.rejects(installSkills(client, params), { code: 'INVALID_ARGUMENT' }, JSON.stringify(params));
    assert.deepEqual(calls, []);
  }
});

test('WSL waits through startup output and retains its distribution and startup cwd', async () => {
  const { client, calls, cwd, profileId } = fixture({ wsl: true, screens: ['', 'Starting WSL...', 'bash-5.2$ \n\n'] });
  const { skill, ...params } = valid;
  const command = 'npx skills add vercel-labs/agent-skills --agent codex --yes';
  assert.deepEqual(await installSkills(client, params), { workspaceId: valid.workspaceId, paneId: 'new-pane', command });
  assert.deepEqual(calls.slice(2), [
    { method: 'pane.split', params: { paneId: 'existing-pane', direction: 'horizontal', profileId, cwd } },
    ...Array.from({ length: 3 }, () => ({ method: 'pane.screen', params: { paneId: 'new-pane' } })),
    { method: 'pane.input', params: { paneId: 'new-pane', data: command + '\r' } },
  ]);
});

test('Windows does not mistake a startup banner for its prompt', async () => {
  const { client, calls } = fixture({ screens: ['PowerShell 7.5', 'PS E:\\project> '] });
  await installSkills(client, valid);
  assert.equal(calls.filter(call => call.method === 'pane.screen').length, 2);
});

test('missing workspace, pane or environment fails before creating a terminal', async () => {
  for (const [options, params, code] of [
    [{}, { ...valid, workspaceId: 'missing' }, 'NOT_FOUND'],
    [{ workspace: { id: valid.workspaceId, profileId: 'powershell', cwd: 'E:/project', panes: [] } }, valid, 'NO_PANES'],
    [{ profiles: [] }, valid, 'PROFILE_UNAVAILABLE'],
    [{ profiles: [{ id: 'powershell', environment: 'windows', available: false }] }, valid, 'PROFILE_UNAVAILABLE'],
    [{ workspace: { id: valid.workspaceId, profileId: 'powershell', cwd: '', panes: [{ id: 'old' }] } }, valid, 'INVALID_CWD'],
  ]) {
    const { client, calls } = fixture(options);
    await assert.rejects(installSkills(client, params), { code });
    assert.ok(!calls.some(call => call.method === 'pane.split' || call.method === 'pane.input'));
  }
});

test('readiness or shell failure never writes the command into an existing pane', async () => {
  for (const options of [
    { screens: [new Error('Snapshot unavailable')] },
    { split: { id: 'new-pane', status: 'exited' } },
    { split: { id: 'existing-pane', status: 'running' } },
  ]) {
    const { client, calls } = fixture(options);
    await assert.rejects(installSkills(client, valid));
    assert.ok(!calls.some(call => call.method === 'pane.input'));
  }
});

test('input failure is reported instead of claiming launch success', async () => {
  const { client } = fixture({ inputError: new Error('Terminal process has exited') });
  await assert.rejects(installSkills(client, valid), /Terminal process has exited/);
});

test('startup timeout leaves the new pane untouched', async t => {
  let reads = 0;
  t.mock.method(Date, 'now', () => reads++ === 0 ? 0 : 16000);
  const { client, calls } = fixture({ screens: ['Still starting'] });
  await assert.rejects(installSkills(client, valid), { code: 'SHELL_NOT_READY' });
  assert.ok(!calls.some(call => call.method === 'pane.input'));
});

test('settings form previews exact commands, submits bridge payloads and rerenders Russian', async () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const { build } = require('esbuild');
  const { chromium } = require('playwright');
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SkillsSettings } from './src/SkillsSettings';
      import { setLanguage } from './src/i18n';
      window.requests = []; window.started = [];
      window.winmux = { call: async (method, params) => {
        window.requests.push({method, params});
        if (window.failLaunch) throw new Error('Launch refused');
        return {workspaceId: params.workspaceId, paneId: 'new-pane'};
      }};
      const root = createRoot(document.getElementById('root'));
      window.renderSkills = (language = 'en', empty = false) => {
        setLanguage(language);
        root.render(<SkillsSettings workspaces={empty ? [] : [
          {id:'workspace-1',name:'Windows project',profileId:'powershell',cwd:'E:/project',panes:[{id:'old'}]},
          {id:'workspace-2',name:'WSL project',profileId:'wsl:Ubuntu',cwd:'/home/user/project',panes:[{id:'old2'}]}
        ]} activeWorkspaceId="workspace-2" onStarted={(workspaceId,paneId)=>window.started.push({workspaceId,paneId})} />);
      };
      window.renderSkills();
    `, resolveDir: path.resolve(__dirname, '..'), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
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
    await page.getByRole('heading', { name: 'Project skills' }).waitFor();
    assert.equal(await page.getByTestId('skills-workspace').inputValue(), 'workspace-2');
    assert.equal(await page.getByTestId('skills-command').textContent(), 'npx skills add vercel-labs/agent-skills --agent codex --yes');
    await page.getByTestId('skills-source').fill('owner/repo;whoami');
    assert.equal(await page.getByTestId('skills-launch').isDisabled(), true);
    await page.getByRole('button', { name: 'Anthropic · skills' }).click();
    await page.getByTestId('skills-name').fill('frontend-design');
    await page.getByTestId('skills-agent').selectOption('claude-code');
    assert.equal(await page.getByTestId('skills-command').textContent(), 'npx skills add anthropics/skills --agent claude-code --skill frontend-design --yes');
    await page.getByTestId('skills-launch').click();
    await page.getByRole('status').waitFor();
    assert.match(await page.getByRole('status').textContent(), /Command launched.*Inspect/);
    assert.deepEqual(await page.evaluate(() => window.requests), [{method:'skills.install',params:{workspaceId:'workspace-2',source:'anthropics/skills',agent:'claude-code',skill:'frontend-design'}}]);
    assert.deepEqual(await page.evaluate(() => window.started), [{workspaceId:'workspace-2',paneId:'new-pane'}]);
    await page.evaluate(() => window.renderSkills('ru'));
    await page.getByRole('heading', { name: 'Навыки проекта' }).waitFor();
    assert.match(await page.getByRole('status').textContent(), /Команда запущена/);
    await page.getByTestId('skills-name').fill('');
    await page.getByTestId('skills-workspace').selectOption('workspace-1');
    await page.evaluate(() => { window.failLaunch = true; });
    await page.getByTestId('skills-launch').click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /Не удалось запустить команду/);
    assert.equal(await page.getByRole('status').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.requests[1]), {method:'skills.install',params:{workspaceId:'workspace-1',source:'anthropics/skills',agent:'claude-code'}});
    await page.evaluate(() => window.renderSkills('en', true));
    await page.getByRole('heading', { name: 'Project skills' }).waitFor();
    assert.equal(await page.getByTestId('skills-launch').isDisabled(), true);
  } finally { await browser.close(); }
});

test('Windows launch creates a separate PowerShell pane at the workspace startup cwd', async () => {
  const { client, calls, cwd } = fixture();
  const command = 'npx skills add vercel-labs/agent-skills --agent codex --skill web-design-guidelines --yes';
  assert.deepEqual(await installSkills(client, valid), { workspaceId: valid.workspaceId, paneId: 'new-pane', command });
  assert.deepEqual(calls, [
    { method: 'state', params: undefined },
    { method: 'environment', params: undefined },
    { method: 'pane.split', params: { paneId: 'existing-pane', direction: 'horizontal', profileId: 'powershell', cwd } },
    { method: 'pane.screen', params: { paneId: 'new-pane' } },
    { method: 'pane.input', params: { paneId: 'new-pane', data: command + '\r' } },
  ]);
});
