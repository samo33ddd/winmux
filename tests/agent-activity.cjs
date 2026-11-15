'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { activityForTool, createActivityTracker, ACTIVITY_KINDS } = require('../electron/agent-activity.cjs');

test('tool identifiers become bounded activity categories without copying content', () => {
  const expected = { Read: 'reading', Edit: 'editing', apply_patch: 'editing', exec_command: 'command', Bash: 'command', Grep: 'searching', 'browser.navigate': 'browser', spawn_agent: 'delegating', unknown: 'thinking' };
  for (const [tool, kind] of Object.entries(expected)) assert.equal(activityForTool(tool), kind);
  assert.equal(activityForTool(null), 'thinking');
  assert.equal(activityForTool('secret'.repeat(500)), 'thinking');
  for (const tool of Object.keys(expected)) assert.ok(ACTIVITY_KINDS.has(activityForTool(tool)));
});

test('a late tool end does not erase the newer active action', () => {
  const tracker = createActivityTracker();
  assert.equal(tracker.update({ phase: 'start', toolName: 'Read', toolId: 'one' }), 'reading');
  assert.equal(tracker.update({ phase: 'start', toolName: 'Bash', toolId: 'two' }), 'command');
  assert.equal(tracker.update({ phase: 'end', toolId: 'one' }), 'command');
  assert.equal(tracker.update({ phase: 'end', toolId: 'foreign' }), 'command');
  assert.equal(tracker.update({ phase: 'end', toolId: 'two' }), 'thinking');
});

test('clearing a session drops old actions and malformed IDs cannot replace them', () => {
  const tracker = createActivityTracker();
  tracker.update({ phase: 'start', toolName: 'Edit', toolId: 'old' });
  tracker.clear();
  assert.equal(tracker.current(), 'thinking');
  assert.equal(tracker.update({ phase: 'start', toolName: 'Read', toolId: 'x'.repeat(257) }), 'thinking');
  assert.equal(tracker.update({ phase: 'start', toolName: 'Read', toolId: 'bad\0id' }), 'thinking');
  assert.equal(tracker.update({ phase: 'end', toolId: 'old' }), 'thinking');
});

test('a bounded tracker keeps live entries when excess tool starts arrive', () => {
  const tracker = createActivityTracker();
  for (let i = 0; i < 64; i++) tracker.update({ phase: 'start', toolName: 'Read', toolId: String(i) });
  assert.equal(tracker.update({ phase: 'start', toolName: 'Edit', toolId: 'excess' }), 'reading');
  tracker.update({ phase: 'end', toolId: '0' });
  assert.equal(tracker.update({ phase: 'start', toolName: 'Edit', toolId: 'accepted' }), 'editing');
});
