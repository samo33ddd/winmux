'use strict';
// winmux-agent-event — metadata-only authenticated adapter transport.
// Standalone copy installed beside agent extensions; no checkout dependency.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AGENTS = new Set(['omp', 'pi', 'hermes']);
const EVENTS = new Set(['session_start', 'session_switch', 'session_shutdown', 'agent_start', 'agent_end', 'tool_execution_start', 'tool_execution_end', 'tool_approval_requested', 'tool_approval_resolved']);
const STATES = new Set(['running', 'waiting', 'idle', 'completed', 'failed']);
const CLAUDE_STATES = { SessionStart: 'idle', UserPromptSubmit: 'running', PreToolUse: 'running', PostToolUse: 'running', PostToolUseFailure: 'running', PermissionRequest: 'waiting', Stop: 'completed', StopFailure: 'failed', SessionEnd: 'idle' };
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') ? value : undefined;

function eventPayload(raw) {
  const input = JSON.parse(raw);
  if (!input || !AGENTS.has(input.agentId) || !EVENTS.has(input.event) || !STATES.has(input.state)
    || !bounded(input.sessionId, 128) || !bounded(input.cwd, 4096)
    || !Number.isSafeInteger(input.pid) || input.pid < 1 || typeof input.stamp !== 'string' || !/^\d{1,32}$/.test(input.stamp)) throw new Error('Invalid Winmux agent event');
  const output = { agentId: input.agentId, event: input.event, sessionId: input.sessionId, cwd: input.cwd, pid: input.pid, stamp: input.stamp, state: input.state };
  if (input.processIdentity !== undefined) {
    if (typeof input.processIdentity !== 'string' || !/^\d{1,20}$/.test(input.processIdentity)) throw new Error('Invalid Winmux process identity');
    output.processIdentity = input.processIdentity;
  }
  if (input.paneId !== undefined) {
    if (!bounded(input.paneId, 128)) throw new Error('Invalid Winmux pane identity');
    output.paneId = input.paneId;
  }
  if (input.phase !== undefined) {
    if ((input.phase === 'start' && input.event !== 'tool_execution_start') || (input.phase === 'end' && input.event !== 'tool_execution_end')
      || !['start', 'end'].includes(input.phase) || !bounded(input.toolName, 256) || !bounded(input.toolId, 256)) throw new Error('Invalid Winmux tool event');
    Object.assign(output, { phase: input.phase, toolName: input.toolName, toolId: input.toolId });
  }
  return output;
}
function claudePayload(raw, env = process.env) {
  const input = JSON.parse(raw);
  if (!input || input.agent_id || input.parent_session_id || input.parent_thread_id) return null;
  const state = CLAUDE_STATES[input.hook_event_name];
  if (!state || !bounded(input.session_id, 128) || !bounded(input.cwd, 4096)) return null;
  const paneId = bounded(env.WINMUX_PANE_ID, 128);
  const output = { agentId: 'claude', event: input.hook_event_name, sessionId: input.session_id, cwd: input.cwd, stamp: process.hrtime.bigint().toString(), state, ...(paneId ? { paneId } : {}) };
  let phase;
  if (input.hook_event_name === 'PreToolUse') phase = 'start';
  else if (['PostToolUse', 'PostToolUseFailure'].includes(input.hook_event_name)) phase = 'end';
  if (phase && bounded(input.tool_name, 256) && bounded(input.tool_use_id, 256)) Object.assign(output, { phase, toolName: input.tool_name, toolId: input.tool_use_id });
  return output;
}
function pipeName(dataDir) {
  const identity = `${os.userInfo().username}:${os.homedir()}:${dataDir.toLowerCase()}`;
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  // The Unix fallback socket lives in the user-private data directory:
  // a predictable name under os.tmpdir() can be pre-bound to steal the token.
  return process.platform === 'win32' ? `\\\\.\\pipe\\winmux-${suffix}` : path.join(dataDir, `winmux-${suffix}.sock`);
}
function deliver(pipe, token, params) {
  const id = crypto.randomUUID();
  const frame = `${JSON.stringify({ id, token, method: 'agent.hook', v: 1, params })}\n`;
  if (Buffer.byteLength(frame) > 16 * 1024) return Promise.reject(new Error('Winmux agent event is too large'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); socket.setEncoding('utf8'); let buffer = '', done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(new Error('Winmux agent event timed out')), 2500);
    socket.on('error', finish);
    socket.on('close', () => { if (!done) finish(new Error('Winmux agent connection closed')); });
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return finish(new Error('Winmux event response is too large'));
      let index;
      for (;;) {
        index = buffer.indexOf('\n');
        if (index === -1) break;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error('Invalid Winmux event response')); }
        if (message.id !== id) continue;
        return finish(message.error ? new Error('Winmux rejected the agent event') : undefined);
      }
    });
    socket.write(frame);
  });
}
async function main(argv = process.argv) {
  const value = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  const selected = bounded(value('--data-dir'), 4096);
  if (!selected || !path.isAbsolute(selected)) throw new Error('Winmux data directory is required');
  const dataDir = path.resolve(selected);
  const token = fs.readFileSync(path.join(dataDir, 'ipc-token'), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid Winmux capability');
  const claude = value('--agent') === 'claude';
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > (claude ? 4 * 1024 * 1024 : 16 * 1024)) throw new Error('Agent event is too large'); }
  const payload = claude ? claudePayload(raw) : eventPayload(raw);
  if (payload) await deliver(value('--pipe') || pipeName(dataDir), token, payload);
}
module.exports = { eventPayload, claudePayload, deliver };
if (require.main === module) main().catch(() => { console.error('Winmux agent event could not be delivered'); process.exitCode = 1; });
