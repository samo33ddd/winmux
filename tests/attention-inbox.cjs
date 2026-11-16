'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

function pane(id, extra) {
  return { id, title: id, profileId: 'powershell', cwd: 'E:/project', pid: 1, status: 'running', cols: 80, rows: 24, ...extra };
}

function state(workspaces) {
  return { workspaces, notifications: [], settings: {} };
}

test('attention groups confirmed states and keeps unknown separate', async () => {
  const { attentionSections } = await import('../src/attentionGrouping.ts');
  const sections = attentionSections(state([{
    id: 'w', name: 'winmux', cwd: 'E:/project', profileId: 'powershell', root: { type: 'leaf', paneId: 'shell' },
    panes: [
      pane('shell'),
      pane('wait', { agentId: 'codex', agentLabel: 'Codex', agentState: 'waiting', agentStateSince: 1_000 }),
      pane('bad', { agentId: 'claude', agentState: 'failed', agentUpdatedAt: 50 }),
      pane('done', { agentId: 'codex', agentState: 'completed' }),
      pane('boot', { agentId: 'codex', agentState: 'starting', agentUpdatedAt: 20 }),
      pane('work', { agentId: 'codex', agentState: 'running', agentUpdatedAt: 40, agentStateSince: 500 }),
      pane('quiet', { agentId: 'codex', agentState: 'idle' }),
      pane('mystery', { agentId: 'codex', agentState: 'bogus' }),
      pane('blank', { agentId: 'codex' }),
    ],
  }]), 61_000);
  assert.deepEqual(sections.map(section => [section.group, section.entries.map(entry => entry.paneId)]), [
    ['waiting', ['wait']],
    ['failed', ['bad']],
    ['completed', ['done']],
    ['active', ['work', 'boot']],
    ['idle', ['quiet']],
    ['unknown', ['mystery', 'blank']],
  ]);
  assert.equal(sections[0].entries[0].elapsedMs, 60_000);
  assert.equal(sections[1].entries[0].elapsedMs, null);
  assert.equal(sections[3].entries[0].elapsedMs, 60_500);
  assert.equal(sections[3].entries[1].elapsedMs, null);
  assert.equal(sections.flat().some(section => section.entries.some(entry => entry.paneId === 'shell')), false);
});

test('longest confirmed waiting time sorts first without inventing a missing timestamp', async () => {
  const { attentionSections } = await import('../src/attentionGrouping.ts');
  const sections = attentionSections(state([{
    id: 'a', name: 'older', cwd: 'E:/a', profileId: 'powershell', root: { type: 'leaf', paneId: 'first' },
    panes: [
      pane('first', { agentId: 'codex', agentState: 'waiting' }),
      pane('second', { agentId: 'codex', agentState: 'waiting', agentUpdatedAt: 30, agentStateSince: 10 }),
    ],
  }, {
    id: 'b', name: 'newer', cwd: 'E:/b', profileId: 'powershell', root: { type: 'leaf', paneId: 'third' },
    panes: [pane('third', { agentId: 'codex', agentState: 'waiting', agentUpdatedAt: 10, agentStateSince: 20 })],
  }]));
  const waiting = sections[0];
  assert.deepEqual(waiting.entries.map(entry => entry.paneId), ['second', 'third', 'first']);
  assert.equal(waiting.entries[2].updatedAt, undefined);
  assert.equal(waiting.entries[2].stateSince, undefined);
  assert.equal(waiting.entries.every(entry => entry.elapsedMs === null), true);
});
