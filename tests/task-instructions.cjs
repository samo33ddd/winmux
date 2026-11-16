'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taskInstructionArgs } = require('../electron/backend/environment.cjs');

test('task instructions are appended only for supported agents and never start a user turn', () => {
  for (const id of ['claude', 'wsl:Ubuntu:claude', 'omp', 'wsl:Ubuntu:omp']) {
    const args = taskInstructionArgs({id}, 'task-123');
    assert.equal(args[0], '--append-system-prompt');
    assert.match(args[1], /task-123/);
    assert.match(args[1], /independent review/);
    assert.match(args[1], /Never push directly/);
  }
  assert.deepEqual(taskInstructionArgs({id:'codex'}, 'task-123'), []);
  assert.deepEqual(taskInstructionArgs({id:'claude'}), []);
});
