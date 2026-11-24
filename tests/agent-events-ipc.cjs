'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');

const {
  eventPayload,
  claudePayload,
  deliver,
} = require('../electron/hooks/winmux-agent-event.cjs');

const baseEvent = {
  agentId: 'pi',
  event: 'tool_execution_start',
  sessionId: 'session-1',
  cwd: 'E:\\project',
  pid: 4242,
  stamp: '123456789',
  state: 'running',
  paneId: 'pane-1',
  phase: 'start',
  toolName: 'Read',
  toolId: 'tool-1',
};

function pipePath() {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\winmux-events-${randomUUID()}`
    : path.join(process.env.TMPDIR || '/tmp', `winmux-events-${randomUUID()}.sock`);
}

function parseFrame(text) {
  assert.ok(text.trim(), 'deliver must write a complete IPC frame');
  return JSON.parse(text.trim());
}

test('extension payloads keep only the documented metadata allowlist', () => {
  const event = eventPayload(JSON.stringify({
    ...baseEvent,
    prompt: 'secret prompt',
    command: 'secret command',
    args: { path: 'secret path' },
    result: 'secret result',
    transcript: 'secret transcript',
  }));
  assert.deepEqual(event, baseEvent);

  const claude = claudePayload(JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'claude-session',
    cwd: 'E:\\project',
    tool_name: 'Edit',
    tool_use_id: 'edit-1',
    tool_input: { file_path: 'secret path' },
    prompt: 'secret prompt',
    content: 'secret content',
  }), { WINMUX_PANE_ID: 'claude-pane' });
  assert.deepEqual(
    { ...claude, stamp: typeof claude.stamp },
    {
      agentId: 'claude',
      event: 'PreToolUse',
      sessionId: 'claude-session',
      cwd: 'E:\\project',
      stamp: 'string',
      state: 'running',
      paneId: 'claude-pane',
      phase: 'start',
      toolName: 'Edit',
      toolId: 'edit-1',
    },
  );
  assert.match(claude.stamp, /^\d{1,32}$/);
  assert.doesNotMatch(JSON.stringify([event, claude]), /secret/);
});

test('strict stamps are strings and nested Claude roots are filtered', () => {
  for (const stamp of [123456789, '', '12x', 'x'.repeat(33), null, undefined]) {
    const raw = { ...baseEvent };
    if (stamp === undefined) delete raw.stamp;
    else raw.stamp = stamp;
    assert.throws(
      () => eventPayload(JSON.stringify(raw)),
      /Invalid Winmux agent event/,
      `stamp ${String(stamp)} must be rejected`,
    );
  }

  const root = {
    hook_event_name: 'PostToolUse',
    session_id: 'root-session',
    cwd: 'E:\\project',
    tool_name: 'Read',
    tool_use_id: 'root-tool',
  };
  for (const nested of [
    { agent_id: 'child-agent' },
    { parent_session_id: 'parent-session' },
    { parent_thread_id: 'parent-thread' },
  ]) {
    assert.equal(claudePayload(JSON.stringify({ ...root, ...nested }), {}), null);
  }
});

test('extension events preserve only well-formed process identities', () => {
  const processIdentity = '638000000000000001';
  assert.equal(eventPayload(JSON.stringify({ ...baseEvent, processIdentity })).processIdentity, processIdentity);
  for (const invalid of ['', '12x', '1'.repeat(21), 42, null]) {
    assert.throws(() => eventPayload(JSON.stringify({ ...baseEvent, processIdentity: invalid })), /Invalid Winmux process identity/);
  }
});

test('deliver correlates a real named pipe response and rejects its own errors or close', async () => {
  const pipe = pipePath();
  const token = 'a'.repeat(64);
  const received = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = parseFrame(buffer.slice(0, newline));
      received.push(request);
      socket.write(`${JSON.stringify({ event: { type: 'state', state: { ignored: true } } })}\n`);
      socket.write(`${JSON.stringify({ id: `wrong-${randomUUID()}`, result: { ignored: true } })}\n`);
      if (request.params.scenario === 'success') {
        socket.write(`${JSON.stringify({ id: request.id, result: { accepted: true } })}\n`);
      } else if (request.params.scenario === 'error') {
        socket.write(`${JSON.stringify({ id: request.id, error: { code: 'REJECTED' } })}\n`);
      } else {
        socket.end();
      }
    });
  });
  try {
    server.listen(pipe);
    await once(server, 'listening');

    const success = { ...baseEvent, scenario: 'success' };
    await deliver(pipe, token, success);
    assert.equal(received.length, 1);
    assert.equal(received[0].token, token);
    assert.equal(received[0].method, 'agent.hook');
    assert.deepEqual(received[0].params, success);

    await assert.rejects(
      deliver(pipe, token, { ...baseEvent, scenario: 'error' }),
      /rejected the agent event/,
    );
    await assert.rejects(
      deliver(pipe, token, { ...baseEvent, scenario: 'close' }),
      /connection closed/,
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
