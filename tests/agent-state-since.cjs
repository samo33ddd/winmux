'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setAgentState } = require('../electron/backend.cjs');

test('repeated state reports keep the original timestamp and new identities reset it', () => {
  const original = Date.now;
  try {
    let now = 100;
    Date.now = () => now;
    const pane = { agentState: 'running' };
    setAgentState(pane, 'waiting');
    now = 200;
    setAgentState(pane, 'waiting');
    assert.equal(pane.agentStateSince, 100);
    setAgentState(pane, 'waiting', true);
    assert.equal(pane.agentStateSince, 200);
    now = 300;
    setAgentState(pane, 'running');
    assert.equal(pane.agentStateSince, 300);
  } finally { Date.now = original; }
});
