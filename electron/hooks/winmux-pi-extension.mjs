// winmux-pi-extension
// Project-local Pi extension for Winmux lifecycle reporting. The installer
// replaces the configuration placeholder before copying this file into
// <workspace>/.pi/extensions/winmux-status.js.
import { execFile, spawn } from 'node:child_process';

function captureProcessIdentity() {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise(resolve => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 }, (error, stdout) => {
        const identity = typeof stdout === 'string' ? stdout.trim() : '';
        resolve(!error && /^\d{1,20}$/.test(identity) ? identity : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

const processIdentity = captureProcessIdentity();

export const MARKER = 'winmux-pi-extension';
const CONFIG_ENCODED = '__WINMUX_CONFIG_B64__';
const CONFIG = CONFIG_ENCODED === '__WINMUX_CONFIG_B64__'
  ? {}
  : JSON.parse(Buffer.from(CONFIG_ENCODED, 'base64').toString('utf8'));
const STATES = new Set(['idle', 'running', 'waiting', 'completed', 'failed']);
const TOOL_EVENTS = new Set(['tool_execution_start', 'tool_execution_end']);
const EVENTS = new Set([
  'session_start', 'session_switch', 'session_shutdown',
  'agent_start', 'agent_end',
  'tool_execution_start', 'tool_execution_end',
]);

function bounded(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
    ? value
    : undefined;
}

function payloadFor(ctx, event, state, tool) {
  if (!ctx || ctx.hasUI !== true || !EVENTS.has(event) || !STATES.has(state)) return null;
  const sessionId = bounded(ctx.sessionManager?.getSessionId?.(), 128);
  const cwd = bounded(ctx.cwd, 4096);
  const stamp = process.hrtime.bigint().toString();
  if (!sessionId || !cwd || stamp.length > 30) return null;
  const paneId = bounded(process.env.WINMUX_PANE_ID, 128);
  const payload = {
    agentId: 'pi',
    event,
    sessionId,
    cwd,
    ...(paneId ? { paneId } : {}),
    pid: process.pid,
    stamp,
    state,
  };
  if (tool) {
    if (!TOOL_EVENTS.has(event) || !bounded(tool.toolName, 128) || !bounded(tool.toolId, 256)
      || !['start', 'end'].includes(tool.phase)) return null;
    payload.toolName = tool.toolName;
    payload.toolId = tool.toolId;
    payload.phase = tool.phase;
  }
  return payload;
}

function sendViaHelper(config, payload) {
  return new Promise((resolve, reject) => {
    if (!config || !bounded(config.nodePath, 4096) || !bounded(config.helperPath, 4096)
      || !bounded(config.dataDir, 4096)) {
      reject(new Error('Winmux Pi hook configuration is incomplete'));
      return;
    }
    const child = spawn(config.nodePath, [
      config.helperPath,
      '--data-dir',
      config.dataDir,
      ...(bounded(config.pipeName, 4096) ? ['--pipe', config.pipeName] : []),
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
      finish(new Error('Winmux Pi hook delivery timed out'));
    }, 1500);
    child.once('error', finish);
    child.once('exit', code => {
      if (code === 0) finish();
      else finish(new Error('Winmux Pi hook delivery failed'));
    });
    child.stdin.once('error', finish);
    child.stdin.end(`${JSON.stringify(payload)}\n`, error => {
      if (error) finish(error);
    });
  });
}

export function createWinmuxPiExtension(config = CONFIG, options = {}) {
  const send = typeof options.send === 'function'
    ? options.send
    : payload => sendViaHelper(config, payload);
  const clock = typeof options.clock === 'function'
    ? options.clock
    : () => process.hrtime.bigint();
  const identity = Promise.resolve(options.processIdentity ?? processIdentity)
    .then(value => typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : undefined, () => undefined);

  return function winmuxPiExtension(pi) {
    if (!pi || typeof pi.on !== 'function') {
      throw new TypeError('Winmux Pi extension requires ExtensionAPI.on');
    }
    let tail = Promise.resolve();

    function emit(ctx, event, state, tool) {
      const payload = payloadFor(ctx, event, state, tool);
      if (!payload) return Promise.resolve(false);
      // Capture the event order before serialising delivery.
      payload.stamp = clock().toString();
      if (!/^\d{1,30}$/.test(payload.stamp)) return Promise.resolve(false);
      tail = tail.then(async () => {
        const value = await identity;
        if (value !== undefined) payload.processIdentity = value;
        return send(payload);
      }).then(() => true, () => false);
      return tail;
    }

    function handleTool(event, ctx, phase) {
      const toolName = bounded(event?.toolName, 128);
      const toolId = bounded(event?.toolCallId, 256);
      if (!toolName || !toolId) return;
      return emit(
        ctx,
        phase === 'start' ? 'tool_execution_start' : 'tool_execution_end',
        'running',
        { toolName, toolId, phase },
      );
    }

    pi.on('session_start', (event, ctx) => {
      const switched = ['new', 'resume', 'fork'].includes(event?.reason);
      return emit(ctx, switched ? 'session_switch' : 'session_start', 'idle');
    });

    pi.on('session_shutdown', (_event, ctx) => emit(ctx, 'session_shutdown', 'idle'));
    pi.on('agent_start', (_event, ctx) => emit(ctx, 'agent_start', 'running'));

    pi.on('agent_end', (event, ctx) => {
      if (event?.willContinue || event?.awaitingAsyncWork) {
        return emit(ctx, 'agent_end', 'running');
      }
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      const lastAssistant = [...messages].reverse()
        .find(message => message?.role === 'assistant');
      if (lastAssistant?.stopReason === 'error') return emit(ctx, 'agent_end', 'failed');
      if (lastAssistant?.stopReason === 'aborted') return emit(ctx, 'agent_end', 'idle');
      return emit(ctx, 'agent_end', 'completed');
    });

    pi.on('tool_execution_start', (event, ctx) => handleTool(event, ctx, 'start'));
    pi.on('tool_execution_end', (event, ctx) => handleTool(event, ctx, 'end'));
  };
}

export default createWinmuxPiExtension();
