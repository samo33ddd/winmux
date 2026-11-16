'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'agent-activity-'));
const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\winmux-activity-${randomUUID()}` : path.join(dataDir, 'daemon.sock');
const token = 'c'.repeat(64);
fs.writeFileSync(path.join(dataDir, 'ipc-token'), token);

const fixtureCwd = 'C:\\winmux-fixture\\agent-activity';
const agents = [
  { id: 'codex', label: 'Codex', activity: 'thinking', state: 'running', action: { en: 'Working on the task', ru: 'Обрабатывает задачу' } },
  { id: 'claude', label: 'Claude', activity: 'reading', state: 'running', action: { en: 'Reading files', ru: 'Читает файлы' } },
  { id: 'omp', label: 'OMP', activity: 'editing', state: 'running', action: { en: 'Editing files', ru: 'Изменяет файлы' } },
  { id: 'hermes', label: 'Hermes', activity: 'command', state: 'running', action: { en: 'Running a command', ru: 'Выполняет команду' } },
  { id: 'pi', label: 'Pi', activity: 'searching', state: 'running', action: { en: 'Searching', ru: 'Ищет информацию' } },
];
const themes = ['dark', 'midnight', 'nord', 'dracula', 'sand', 'light'];
const runningLabel = { en: 'Running', ru: 'Работает' };
const completedLabel = { en: 'Completed', ru: 'Завершено' };
const unknownLabel = { en: 'Activity unavailable', ru: 'Нет данных об активности' };

function pane(agent) {
  return {
    id: `pane-${agent.id}`, title: agent.label, profileId: 'powershell', cwd: fixtureCwd,
    pid: 1000, status: 'running', cols: 80, rows: 24, tabId: `tab-${agent.id}`, shellReady: true,
    agentId: agent.id, agentLabel: agent.label, agentState: agent.state, agentActivity: agent.activity,
  };
}
function workspace(agent) {
  const item = pane(agent);
  const leaf = { type: 'leaf', paneId: item.id };
  return {
    id: `workspace-${agent.id}`, name: agent.label, cwd: fixtureCwd, profileId: 'powershell', root: leaf,
    panes: [item], tabs: [{ id: item.tabId, title: 'Terminal', root: leaf }], activeTabId: item.tabId,
  };
}
const state = {
  workspaces: agents.map(workspace),
  notifications: [],
  settings: { theme: 'dark', fontSize: 14, activeWorkspaceId: 'workspace-codex', showWorkspacePaths: false },
};
const environment = {
  platform: process.platform, defaultCwd: fixtureCwd,
  profiles: [{ id: 'powershell', label: 'PowerShell', environment: 'windows', command: 'pwsh.exe', args: [], cwd: fixtureCwd }],
  agents: agents.map(agent => ({ id: agent.id, label: agent.label, profileId: 'powershell', environment: 'windows', available: true, command: null })),
  capabilities: { terminalTabs: true, agentLaunch: true, agentStatus: true, nativeCodex: true, ompHooks: true, agentActivity: true, projectTasks:true },
};
const taskRequests = [];
const gatewayStatus = {
  sessions: [{ agentId: 'hermes', sessionId: 'hermes-root-fixture', cwd: fixtureCwd, pid: 5000, state: 'running', lastSeen: Date.now() }],
  panes: [{ paneId: 'pane-hermes', agentId: 'hermes', sessionId: null }],
};
const bindings = [];
const sockets = new Set();
let desktop;
// Fake only the authenticated daemon boundary. Real Electron preload, IPC,
// client and renderer stay unchanged; no signed-in agent or inference runs.
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  socket.setEncoding('utf8'); let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      assert.equal(request.token, token);
      let result = { ok: true }, error;
      if (request.method === 'state') result = state;
      else if (request.method === 'environment') result = environment;
      else if (request.method === 'codex.status') result = { connection: 'disconnected', threads: [], panes: [] };
      else if (request.method === 'agent.sessions') result = gatewayStatus;
      else if (request.method === 'project.inspect') result = { root:fixtureCwd, commonDir:`${fixtureCwd}\\.git`, branches:['main'], primary:'main', worktrees:[] };
      else if (request.method === 'task.create') {
        taskRequests.push(request.params);
        const item = workspace({id:'task', label:'Safe agent', state:'running'});
        item.name = request.params.name; state.workspaces.push(item);
        state.projects = [{id:'project-1', name:'Fixture', root:fixtureCwd, profileId:'powershell', primaryBranch:'main'}];
        state.tasks = [{id:'task-1', name:request.params.name, projectId:'project-1', cwd:fixtureCwd, branch:'winmux/fixture', base:'main', managed:true, archived:false, workspaceId:item.id}];
        result = item;
      }
      else if (request.method === 'agent.bind') {
        assert.equal(request.params.paneId, 'pane-hermes');
        assert.equal(request.params.sessionId, 'hermes-root-fixture');
        bindings.push(request.params);
        gatewayStatus.panes[0].sessionId = request.params.sessionId;
        result = { applied: true, ...request.params };
      }
      else if (request.method === 'pane.snapshot') result = { data: '', seq: 0, cols: 80, rows: 24 };
      else if (request.method === 'pane.screen') result = { text: 'sanitised fixture', cursor: { x: 0, y: 0 } };
      else if (request.method === 'settings.update') Object.assign(state.settings, request.params);
      else if (['pane.resize', 'layout.ratio'].includes(request.method)) result = { ok: true };
      else error = { code: 'NOT_AVAILABLE', message: 'Isolated activity fixture does not execute this method' };
      socket.write(JSON.stringify({ id: request.id, result, error }) + '\n');
    }
  });
});
function publish(next) {
  const frame = JSON.stringify({ event: { type: 'state', state: next } }) + '\n';
  for (const socket of sockets) if (!socket.destroyed) socket.write(frame);
}
function caption(agent, language) {
  return `${agent.label} · ${runningLabel[language]} · ${agent.action[language]}`;
}
function workspaceButton(page, id) {
  return page.locator(`[data-testid="workspace-item"][data-workspace-id="${id}"]`);
}

async function run() {
  const shots = [];
  try {
    server.listen(pipeName); await once(server, 'listening');
    const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_PIPE_NAME: pipeName, WINMUX_TEST_MODE: '1' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.WINMUX_DEV_URL;
    desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await desktop.firstWindow({ timeout: 30000 });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForSelector('.xterm');
    await page.evaluate(() => localStorage.setItem('winmux.language', 'en'));
    await page.getByTestId('sidebar-expand').click();
    const handle = page.getByTestId('sidebar-resize');
    await handle.focus();
    for (let step = 0; step < 12; step += 1) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.sidebar')?.classList.contains('expanded'));

    for (const language of ['en', 'ru']) {
      await page.getByTestId('settings-open').click();
      await page.getByTestId(`language-${language}`).click();
      await page.keyboard.press('Escape');
      for (const agent of agents) {
        const row = workspaceButton(page, `workspace-${agent.id}`);
        const metadata = row.locator('[data-testid="agent-metadata"]');
        await metadata.waitFor();
        assert.equal(await metadata.locator('.agent-name').innerText(), agent.label);
        assert.equal(await metadata.locator('[data-testid="agent-action"] span').innerText(), agent.action[language]);
        assert.equal(await metadata.locator('[data-testid="agent-action"] svg').count(), 1);
        assert.equal(await metadata.getAttribute('title'), caption(agent, language));
      }
      const header = page.locator('.header-agent [data-testid="agent-metadata"]');
      assert.equal(await header.locator('.agent-name').innerText(), 'Codex');
      assert.equal(await header.locator('[data-testid="agent-action"] span').innerText(), agents[0].action[language]);
      assert.equal(await header.getAttribute('title'), caption(agents[0], language));
    }

    await page.getByTestId('settings-open').click();
    await page.getByTestId('settings-tab-behavior').click();
    const choices = page.getByTestId('agent-hooks-agent');
    assert.deepEqual((await choices.locator('option').evaluateAll(items => items.map(item => item.value))).sort(), ['claude', 'codex', 'hermes', 'omp', 'pi']);
    for (const agent of agents) {
      await choices.selectOption(agent.id);
      assert.equal(await choices.inputValue(), agent.id);
    }
    const sessionPicker = page.getByTestId('hermes-bind-pane-hermes');
    await sessionPicker.focus();
    assert.equal(await sessionPicker.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="hermes-bind-pane-hermes"]')?.value === 'hermes-root-fixture');
    assert.deepEqual(bindings, [{ paneId: 'pane-hermes', sessionId: 'hermes-root-fixture' }]);
    await choices.selectOption('hermes');
    await page.screenshot({ path: path.join(artifacts, 'agent-activity-connections.png') });
    await page.keyboard.press('Escape');

    for (const theme of themes) {
      await page.getByTestId('settings-open').click();
      await page.getByTestId(`theme-${theme}`).click();
      await page.waitForFunction(id => document.documentElement.dataset.theme === id, theme);
      await page.keyboard.press('Escape');
      await page.locator('.terminal-surface, .xterm').first().click();
      const file = path.join(artifacts, `agent-activity-${theme}.png`);
      await page.screenshot({ path: file });
      assert.ok(fs.statSync(file).size > 1000, `${theme} screenshot is empty`);
      shots.push(file);
    }

    await page.getByTestId('sidebar-expand').click();
    await page.waitForFunction(() => document.querySelector('.sidebar')?.classList.contains('rail'));
    for (const agent of agents) {
      const title = await workspaceButton(page, `workspace-${agent.id}`).getAttribute('title');
      assert.match(title, new RegExp(caption(agent, 'ru').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    const compactHeader = page.locator('.header-agent [data-testid="agent-metadata"]');
    assert.equal(await compactHeader.locator('[data-testid="agent-action"] span').innerText(), agents[0].action.ru);
    assert.equal(await compactHeader.getAttribute('title'), caption(agents[0], 'ru'));

    const hidden = [
      { id: 'codex', state: 'completed', label: completedLabel.ru, action: agents[0].action.ru },
      { id: 'claude', state: 'idle', label: 'Ожидает', action: agents[1].action.ru },
      { id: 'omp', state: 'waiting', label: 'Ожидает ввода', action: agents[2].action.ru },
      { id: 'hermes', state: 'failed', label: 'Ошибка', action: agents[3].action.ru },
      { id: 'pi', state: 'unknown', label: unknownLabel.ru, action: agents[4].action.ru },
    ];
    const stale = structuredClone(state);
    for (const item of hidden) {
      const pane = stale.workspaces.find(entry => entry.id === `workspace-${item.id}`).panes[0];
      pane.agentState = item.state;
      // A cached exit code from a previous launch must not appear on current
      // unknown/idle/waiting activity or be mistaken for an activity counter.
      if (!['completed', 'failed'].includes(item.state)) pane.agentExitCode = 0;
      if (item.state !== 'running') delete pane.agentActivity;
    }
    delete stale.workspaces[4].panes[0].agentActivity;
    publish(stale);
    await page.waitForFunction(label => {
      const title = document.querySelector('[data-testid="workspace-item"][data-workspace-id="workspace-codex"]')?.getAttribute('title') || '';
      return title.includes(label) && !title.includes('Обрабатывает задачу');
    }, completedLabel.ru);
    for (const item of hidden) {
      const title = await workspaceButton(page, `workspace-${item.id}`).getAttribute('title');
      assert.match(title, new RegExp(item.label));
      assert.doesNotMatch(title, new RegExp(item.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(await compactHeader.locator('[data-testid="agent-action"]').count(), 0);
    assert.doesNotMatch(await compactHeader.getAttribute('title'), /Обрабатывает задачу/);

    await page.getByTestId('sidebar-expand').click();
    await page.waitForFunction(() => document.querySelector('.sidebar')?.classList.contains('expanded'));
    for (const item of hidden) {
      const metadata = workspaceButton(page, `workspace-${item.id}`).locator('[data-testid="agent-metadata"]');
      await page.waitForFunction(({ id, label }) => document.querySelector(`[data-testid="workspace-item"][data-workspace-id="workspace-${id}"] .agent-state`)?.textContent === label, item);
      assert.equal(await metadata.locator('[data-testid="agent-action"]').count(), 0);
      assert.equal(await metadata.getAttribute('data-agent-state'), item.state);
    }
    await page.setViewportSize({ width: 900, height: 700 });
    await page.getByTestId('attention-toggle').click();
    const inbox = page.getByTestId('attention-inbox');
    assert.equal(await inbox.getByTestId('attention-item').count(), 5);
    assert.equal(await inbox.getByTestId('attention-item').first().getAttribute('data-attention-group'), 'waiting');
    await page.screenshot({ path: path.join(artifacts, 'attention-inbox-900.png') });
    await inbox.locator('[data-pane-id="pane-omp"]').click();
    await page.waitForFunction(() => document.querySelector('.header-agent [data-agent-id="omp"]'));
    assert.equal(await inbox.count(), 0);
    await page.getByTestId('projects-toggle').click();
    await page.getByRole('button', {name:'Новая задача'}).click();
    await page.getByTestId('task-name').fill('Fixture task');
    await page.getByTestId('task-agent').selectOption('codex');
    await page.getByRole('button', {name:'Проверить репозиторий'}).click();
    await page.getByTestId('task-base-branch').waitFor();
    await page.screenshot({ path:path.join(artifacts, 'task-dialog-900.png') });
    await page.getByTestId('task-create').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="workspace-item"][data-workspace-id="workspace-task"]'));
    assert.equal(taskRequests.length, 1);
    assert.equal(taskRequests[0].baseBranch, 'main');
    assert.equal(taskRequests[0].agentId, 'codex');
    await page.getByTestId('projects-toggle').click();
    assert.match(await page.getByTestId('project-tasks').innerText(), /Fixture task/);
    const visible = await page.locator('body').innerText();
    assert.doesNotMatch(visible, /krach|Users\\|Authorization|sk-|token/i);
    console.log(`PASS real Electron activity fixture: five agents, ru/en, six themes, stale actions hidden. Screenshots: ${shots.join(', ')}`);
  } finally {
    if (desktop) await desktop.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
