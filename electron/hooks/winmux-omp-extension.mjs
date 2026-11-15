// winmux-omp-extension
// Project-local OMP extension. This file is copied into <workspace>/.omp/extensions/winmux-status.mjs.
import { spawn } from 'node:child_process';

const MARKER = 'winmux-omp-extension';
const CONFIG_ENCODED = '__WINMUX_CONFIG_B64__';
const CONFIG = CONFIG_ENCODED === '__WINMUX_CONFIG_B64__'
  ? {}
  : JSON.parse(Buffer.from(CONFIG_ENCODED, 'base64').toString('utf8'));
const STATES = new Set(['idle', 'running', 'waiting', 'completed', 'failed']);

function validRootContext(ctx) {
  return ctx?.agent?.kind === 'main'
    && ctx?.mode === 'tui'
    && ctx?.hasUI === true;
}

function bounded(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
    ? value
    : undefined;
}

function payloadFor(ctx, event, state, tool) {
  const sessionId = bounded(ctx?.sessionManager?.getSessionId?.(), 128);
  const cwd = bounded(ctx?.cwd, 4096);
  if (!sessionId || !cwd || !STATES.has(state)) return null;
  const paneId = bounded(process.env.WINMUX_PANE_ID, 128);
  return {
    agentId: 'omp',
    event,
    sessionId,
    cwd,
    ...(paneId ? { paneId } : {}),
    pid: process.pid,
    stamp: process.hrtime.bigint().toString(),
    state,
    ...(tool ? { toolName: tool.toolName, toolId: tool.toolId, phase: tool.phase } : {}),
  };
}

function sendViaHelper(config, payload) {
  return new Promise((resolve, reject) => {
    if (!config || !bounded(config.nodePath, 4096) || !bounded(config.helperPath, 4096)
      || !bounded(config.dataDir, 4096)) {
      reject(new Error('Winmux OMP hook configuration is incomplete'));
      return;
    }
    const child = spawn(config.nodePath, [
      config.helperPath,
      '--data-dir',
      config.dataDir,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Winmux OMP hook delivery timed out'));
    }, 1500);
    child.once('error', finish);
    child.once('exit', code => {
      if (code === 0) finish();
      else finish(new Error('Winmux OMP hook delivery failed'));
    });
    child.stdin.once('error', finish);
    child.stdin.end(`${JSON.stringify(payload)}\n`, error => {
      if (error) finish(error);
    });
  });
}

export function createWinmuxOmpExtension(config = CONFIG, options = {}) {
  const send = typeof options.send === 'function'
    ? options.send
    : payload => sendViaHelper(config, payload);

  return function winmuxOmpExtension(pi) {
    if (!pi || typeof pi.on !== 'function') throw new TypeError('Winmux OMP extension requires ExtensionAPI.on');
    let tail = Promise.resolve();
    const approvals = new Set();
    const asks = new Set();

    function resetWaits() {
      approvals.clear();
      asks.clear();
    }

    function waitingState() {
      return approvals.size > 0 || asks.size > 0 ? 'waiting' : 'running';
    }

    function emit(ctx, event, state, tool) {
      const stamp = process.hrtime.bigint().toString();
      if (stamp.length > 30) return Promise.resolve(false);
      if (!validRootContext(ctx)) return Promise.resolve(false);
      const payload = payloadFor(ctx, event, state, tool);
      if (!payload) return Promise.resolve(false);
      payload.stamp = stamp;
      tail = tail.then(() => send(payload)).then(() => true, () => false);
      return tail;
    }

    function handleTool(event, ctx, phase) {
      if (!validRootContext(ctx)) return;
      const toolName = bounded(event?.toolName, 128);
      const toolId = bounded(event?.toolCallId, 256);
      if (!toolName || !toolId) return;
      if (toolName === 'ask') {
        if (phase === 'start') asks.add(toolId);
        else asks.delete(toolId);
      }
      const eventName = phase === 'start' ? 'tool_execution_start' : 'tool_execution_end';
      return emit(ctx, eventName, waitingState(), { toolName, toolId, phase });
    }

    pi.on('session_start', (_event, ctx) => {
      if (!validRootContext(ctx)) return;
      resetWaits();
      return emit(ctx, 'session_start', ctx?.isIdle?.() ? 'idle' : 'running');
    });

    pi.on('session_switch', (_event, ctx) => {
      if (!validRootContext(ctx)) return;
      resetWaits();
      return emit(ctx, 'session_switch', ctx?.isIdle?.() ? 'idle' : 'running');
    });

    pi.on('agent_start', (_event, ctx) => {
      if (!validRootContext(ctx)) return;
      resetWaits();
      return emit(ctx, 'agent_start', 'running');
    });

    pi.on('agent_end', (event, ctx) => {
      if (!validRootContext(ctx)) return;
      resetWaits();
      if (event?.willContinue || event?.awaitingAsyncWork) return emit(ctx, 'agent_end', 'running');
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      const lastAssistant = [...messages].reverse().find(message => message?.role === 'assistant');
      if (lastAssistant?.stopReason === 'error') return emit(ctx, 'agent_end', 'failed');
      if (lastAssistant?.stopReason === 'aborted') return emit(ctx, 'agent_end', 'idle');
      return emit(ctx, 'agent_end', 'completed');
    });

    pi.on('tool_execution_start', (event, ctx) => {
      return handleTool(event, ctx, 'start');
    });

    pi.on('tool_execution_end', (event, ctx) => {
      return handleTool(event, ctx, 'end');
    });

    pi.on('tool_approval_requested', (event, ctx) => {
      const toolId = bounded(event?.toolCallId, 256);
      if (!validRootContext(ctx) || !toolId) return;
      approvals.add(toolId);
      return emit(ctx, 'tool_approval_requested', 'waiting');
    });

    pi.on('tool_approval_resolved', (event, ctx) => {
      const toolId = bounded(event?.toolCallId, 256);
      if (!validRootContext(ctx) || !toolId) return;
      approvals.delete(toolId);
      return emit(ctx, 'tool_approval_resolved', waitingState());
    });

    pi.on('session_shutdown', (_event, ctx) => {
      if (!validRootContext(ctx)) return;
      resetWaits();
      return emit(ctx, 'session_shutdown', 'idle');
    });
  };
}

export { MARKER };
export default createWinmuxOmpExtension();
