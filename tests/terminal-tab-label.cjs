'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const profiles = [{ id: 'powershell', label: 'PowerShell 7' }];
function owner(pane, tab) {
  return { id: 'w', name: 'winmux', cwd: 'E:/x', profileId: 'powershell', root: tab.root, panes: [pane], tabs: [tab], activeTabId: tab.id };
}

test('explicit custom title equal to the profile label stays put', async () => {
  const { terminalTabLabel } = await import('../src/workspaceTabs.ts');
  const pane = { id: 'p', title: 'Опиши проект | winmux', profileId: 'powershell', cwd: 'E:/x', pid: 1, status: 'running', cols: 80, rows: 24 };
  const tab = { id: 't', title: 'PowerShell 7', titleMode: 'custom', root: { type: 'leaf', paneId: 'p' } };
  assert.equal(terminalTabLabel(owner(pane, tab), tab, {}, profiles), 'PowerShell 7');
});

test('an automatic Codex launch follows the live pane title', async () => {
  const { terminalTabLabel } = await import('../src/workspaceTabs.ts');
  const pane = { id: 'p', title: 'Опиши проект | winmux', profileId: 'powershell', cwd: 'E:/x', pid: 1, status: 'running', cols: 80, rows: 24 };
  const tab = { id: 't', title: 'Codex', titleMode: 'auto', root: { type: 'leaf', paneId: 'p' } };
  assert.equal(terminalTabLabel(owner(pane, tab), tab, {}, profiles), 'Опиши проект | winmux');
});

test('a split follows the selected pane and a legacy title still uses the profile heuristic', async () => {
  const { terminalTabLabel } = await import('../src/workspaceTabs.ts');
  const first = { id: 'p1', title: 'first', profileId: 'powershell', cwd: 'E:/x', pid: 1, status: 'running', cols: 80, rows: 24 };
  const second = { id: 'p2', title: 'second', profileId: 'powershell', cwd: 'E:/x', pid: 2, status: 'running', cols: 80, rows: 24 };
  const tab = { id: 't', title: 'PowerShell 7', root: { type: 'split', id: 's', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', paneId: 'p1' }, second: { type: 'leaf', paneId: 'p2' } } };
  const workspace = { id: 'w', name: 'winmux', cwd: 'E:/x', profileId: 'powershell', root: tab.root, panes: [first, second], tabs: [tab], activeTabId: tab.id };
  assert.equal(terminalTabLabel(workspace, tab, {}, profiles), 'first');
  assert.equal(terminalTabLabel(workspace, tab, { t: 'p2' }, profiles), 'second');
  assert.equal(terminalTabLabel(workspace, { ...tab, title: 'PowerShell 7 notes' }, { t: 'p2' }, profiles), 'PowerShell 7 notes');
});
