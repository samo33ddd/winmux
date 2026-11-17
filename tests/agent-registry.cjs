'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AGENTS, AGENT_IDS, HOOK_AGENT_IDS, HOOK_STATES, EXTENSION_EVENTS } = require('../electron/backend/agent-registry.cjs');

test('registry covers every supported agent with discovery order and labels', () => {
  assert.deepEqual(AGENT_IDS, ['claude', 'codex', 'hermes', 'omp', 'pi']);
  assert.deepEqual([...HOOK_AGENT_IDS].sort(), ['claude', 'hermes', 'omp', 'pi']);
  for (const id of AGENT_IDS) {
    assert.equal(typeof AGENTS[id].label, 'string');
    assert.ok(AGENTS[id].label);
  }
  assert.equal(AGENTS.claude.hookAdapter, 'claude');
  assert.equal(AGENTS.codex.hookAdapter, 'codex');
  assert.equal(AGENTS.omp.hookAdapter, undefined);
});

test('installed winmux-agent-event helper literals stay in sync with the registry', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'hooks', 'winmux-agent-event.cjs'), 'utf8');
  const literal = name => new RegExp(`const ${name} = new Set\\(\\[(.*?)]\\)`).exec(source)[1]
    .match(/'[^']+'/g).map(item => item.slice(1, -1));
  const states = literal('STATES');
  assert.deepEqual(states.sort(), [...HOOK_STATES].sort());
  assert.deepEqual(literal('EVENTS').sort(), [...EXTENSION_EVENTS].sort());
  // The installed copy accepts only agents that post generic extension events.
  assert.deepEqual(literal('AGENTS').sort(), AGENT_IDS.filter(id => AGENTS[id].extensionEvents === EXTENSION_EVENTS).sort());
  const statesMap = /const CLAUDE_STATES = \{([^}]+)\}/.exec(source)[1];
  const helperStates = Object.fromEntries([...statesMap.matchAll(/(\w+):\s*'(\w+)'/g)].map(([, event, state]) => [event, state]));
  assert.deepEqual(helperStates, AGENTS.claude.eventStates);
});
