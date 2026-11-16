'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadState } = require('../electron/backend.cjs');

test('version 2 state is backed up unchanged before adding projects and tasks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-task-state-'));
  try {
    const file = path.join(dir, 'state.json');
    const previous = JSON.stringify({ version: 2, state: { workspaces: [], notifications: [], settings: { fontSize: 14, theme: 'dark' } } });
    fs.writeFileSync(file, previous);
    const state = loadState(file);
    assert.deepEqual(state.projects, []);
    assert.deepEqual(state.tasks, []);
    const backups = fs.readdirSync(dir).filter(name => name.startsWith('state.json.pre-tasks-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), previous);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('version 3 rejects task records with missing project ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-task-state-'));
  try {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ version: 3, state: { workspaces: [], projects: [], tasks: [{ id: 'task', name: 'Task', projectId: 'missing', cwd: 'C:/task', branch: 'task', base: 'main', managed: true, archived: false }], notifications: [], settings: { fontSize: 14, theme: 'dark' } } }));
    assert.throws(() => loadState(file), { code: 'STATE_INVALID' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('version 3 restores and normalizes exact-head task review evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-task-state-'));
  try {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 3,
      state: {
        workspaces: [],
        projects: [{ id: 'project', name: 'Winmux', root: 'C:/winmux', profileId: 'powershell', primaryBranch: 'main' }],
        tasks: [{
          id: 'task', name: 'Task', projectId: 'project', cwd: 'C:/task', branch: 'winmux/review', base: 'main',
          managed: true, archived: false, phase: 'ready',
          review: { sha: 'A'.repeat(40), reviewer: '  Sol reviewer  ', summary: '  Independent review  ', outcome: 'approved', reviewedAt: 123 },
        }],
        notifications: [],
        settings: { fontSize: 14, theme: 'dark' },
      },
    }));
    const state = loadState(file);
    assert.deepEqual(state.tasks[0].review, {
      sha: 'a'.repeat(40), reviewer: 'Sol reviewer', summary: 'Independent review', outcome: 'approved', reviewedAt: 123,
    });
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('state.json.recovery-')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('version 3 rejects malformed restored task review evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-task-state-'));
  try {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 3,
      state: {
        workspaces: [],
        projects: [{ id: 'project', name: 'Winmux', root: 'C:/winmux', profileId: 'powershell', primaryBranch: 'main' }],
        tasks: [{
          id: 'task', name: 'Task', projectId: 'project', cwd: 'C:/task', branch: 'winmux/review', base: 'main',
          managed: true, archived: false, phase: 'ready',
          review: { sha: 'a'.repeat(40), reviewer: 'reviewer', summary: 'summary', outcome: 'unknown', reviewedAt: 1 },
        }],
        notifications: [],
        settings: { fontSize: 14, theme: 'dark' },
      },
    }));
    assert.throws(() => loadState(file), { code: 'STATE_INVALID' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
