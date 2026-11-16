'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  taskInstruction,
  taskInstructionArgs,
  deliverySupportFor,
  codexUserPromptSubmitOutput,
} = require('../electron/backend/task-instructions.cjs');

test('task instructions are shared by Claude, OMP, and root Codex UserPromptSubmit', () => {
  const expected = taskInstruction('task-123');
  for (const id of ['claude', 'wsl:Ubuntu:claude', 'omp', 'wsl:Ubuntu:omp']) {
    const args = taskInstructionArgs({id}, 'task-123');
    assert.equal(args[0], '--append-system-prompt');
    assert.equal(args[1], expected);
  }
  assert.deepEqual(taskInstructionArgs({id:'codex'}, 'task-123'), []);
  assert.deepEqual(taskInstructionArgs({id:'claude'}), []);
  assert.deepEqual(codexUserPromptSubmitOutput('task-123'), {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: expected,
    },
  });
  assert.equal(codexUserPromptSubmitOutput(undefined), null);
  assert.match(expected, /independent review/);
  assert.match(expected, /Never push directly/);
  assert.equal(JSON.stringify(taskInstructionArgs({id:'codex'}, 'task-123')).includes('developer_instructions'), false);
});

test('task delivery support and task IDs are bounded', () => {
  assert.equal(deliverySupportFor('codex'), 'hooks');
  assert.equal(deliverySupportFor('wsl:Ubuntu:codex'), 'hooks');
  assert.equal(deliverySupportFor('claude'), 'instructions');
  assert.equal(deliverySupportFor('wsl:Ubuntu:omp'), 'instructions');
  assert.equal(deliverySupportFor('hermes'), 'unsupported');
  assert.throws(() => taskInstruction('bad task'), /task ID is invalid/);
  assert.throws(() => taskInstructionArgs({id:'claude'}, 'x'.repeat(129)), /task ID is invalid/);
  assert.throws(() => codexUserPromptSubmitOutput('task\ninjection'), /task ID is invalid/);
});
