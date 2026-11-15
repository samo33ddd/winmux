'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function piContext(overrides = {}) {
  return {
    hasUI: true,
    cwd: 'E:\\project',
    sessionManager: {
      getSessionId: () => 'pi-session-1',
    },
    isIdle: () => true,
    ...overrides,
  };
}

async function piFixture(options = {}) {
  const { createWinmuxPiExtension } = await import('../electron/hooks/winmux-pi-extension.mjs');
  const handlers = new Map();
  const sent = [];
  let tick = 1000n;
  const factory = createWinmuxPiExtension({}, {
    clock: options.clock || (() => ++tick),
    send: async payload => {
      if (options.delayFirst && sent.length === 0) await delay(25);
      sent.push(payload);
    },
  });
  factory({
    on(name, handler) {
      handlers.set(name, handler);
    },
  });
  async function emit(name, event = {}, ctx = piContext()) {
    const handler = handlers.get(name);
    assert.equal(typeof handler, 'function', `missing Pi handler ${name}`);
    return handler(event, ctx);
  }
  return { emit, handlers, sent };
}

test('Pi reports only the interactive root and ignores nested callbacks', async () => {
  const { emit, sent } = await piFixture();
  await emit('session_start', { reason: 'startup' }, piContext());
  await emit('session_start', { reason: 'new' }, piContext());
  await emit('session_start', { reason: 'startup' }, piContext({ hasUI: false }));
  await emit('agent_start', {}, piContext({ hasUI: false }));
  await emit('session_shutdown', {}, piContext({ hasUI: false }));
  assert.deepEqual(sent.map(item => [item.event, item.state, item.sessionId, item.pid]), [
    ['session_start', 'idle', 'pi-session-1', process.pid],
    ['session_switch', 'idle', 'pi-session-1', process.pid],
  ]);
});

test('Pi preserves overlapping tool identity and never serialises args or results', async () => {
  const { emit, sent } = await piFixture({ delayFirst: true });
  await emit('agent_start');
  const starts = Promise.all([
    emit('tool_execution_start', {
      toolName: 'read',
      toolCallId: 'call-1',
      args: { path: 'secret-engine' },
    }),
    emit('tool_execution_start', {
      toolName: 'bash',
      toolCallId: 'call-2',
      args: { command: 'secret-watch' },
    }),
  ]);
  await starts;
  await Promise.all([
    emit('tool_execution_end', {
      toolName: 'read',
      toolCallId: 'call-1',
      result: 'secret-blueprint',
      isError: true,
    }),
    emit('tool_execution_end', {
      toolName: 'bash',
      toolCallId: 'call-2',
      result: 'secret-password',
      isError: false,
    }),
  ]);
  assert.deepEqual(sent.slice(1).map(item => [
    item.event, item.toolName, item.toolId, item.phase, item.state,
  ]), [
    ['tool_execution_start', 'read', 'call-1', 'start', 'running'],
    ['tool_execution_start', 'bash', 'call-2', 'start', 'running'],
    ['tool_execution_end', 'read', 'call-1', 'end', 'running'],
    ['tool_execution_end', 'bash', 'call-2', 'end', 'running'],
  ]);
  assert.ok(BigInt(sent[3].stamp) > BigInt(sent[2].stamp));
  assert.ok(sent.every(item => /^\d+$/.test(item.stamp)));
  const serialised = JSON.stringify(sent);
  assert.equal(serialised.includes('secret-'), false);
  assert.equal(serialised.includes('args'), false);
  assert.equal(serialised.includes('result'), false);
});

test('Pi maps continuation, final error, abort, completion and shutdown', async () => {
  const { emit, sent } = await piFixture();
  const root = piContext();
  await emit('session_start', { reason: 'startup' }, root);
  await emit('agent_start', {}, root);
  await emit('agent_end', { willContinue: true, messages: [] }, root);
  await emit('agent_end', {
    messages: [{ role: 'assistant', stopReason: 'error', content: 'secret-error' }],
  }, root);
  await emit('agent_end', {
    messages: [{ role: 'assistant', stopReason: 'aborted' }],
  }, root);
  await emit('agent_end', {
    messages: [{ role: 'assistant', stopReason: 'stop' }],
  }, root);
  await emit('session_shutdown', { reason: 'quit' }, root);
  assert.deepEqual(sent.map(item => [item.event, item.state]), [
    ['session_start', 'idle'],
    ['agent_start', 'running'],
    ['agent_end', 'running'],
    ['agent_end', 'failed'],
    ['agent_end', 'idle'],
    ['agent_end', 'completed'],
    ['session_shutdown', 'idle'],
  ]);
  assert.equal(JSON.stringify(sent).includes('secret-error'), false);
});

test('Pi does not claim unsupported approval wait events or split argv tool IDs', async () => {
  const { handlers } = await piFixture();
  assert.equal(handlers.has('tool_approval_requested'), false);
  assert.equal(handlers.has('tool_approval_resolved'), false);
});

function findPython() {
  for (const command of process.platform === 'win32' ? ['python.exe', 'python', 'py'] : ['python3', 'python']) {
    const result = spawnSync(command, ['-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout.trim() === '3') return command;
  }
  return null;
}

test('Hermes uses installed callback signatures and fails closed without a proven CLI root', async () => {
  const python = findPython();
  assert.ok(python, 'Python 3 is required to exercise the Hermes plugin');
  const plugin = path.resolve(__dirname, '..', 'electron', 'hooks', 'winmux-hermes-plugin.py');
  const fixture = String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
path = sys.argv[1]
spec = importlib.util.spec_from_file_location("winmux_hermes_plugin", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

sent = []
handlers = {}
clock = iter(range(5000, 6000))

class Context:
    def register_hook(self, name, callback):
        handlers[name] = callback

adapter = module.WinmuxHermesPlugin(
    send=sent.append,
    monotonic_ns=lambda: next(clock),
    get_pid=lambda: 4242,
    get_cwd=lambda: r"E:\project",
    delegated_context=lambda: False,
    environ={"WINMUX_PANE_ID": "pane-1"},
    async_delivery=False,
)
adapter.register(Context())

def emit(name, **fields):
    handlers[name](**fields)

root_session = "9ad03f6a-37b1-4fb1-a7a2-026b8e688c44"
rotated_session = "e88e228b-0cdf-4717-a7b9-5f58ea127f7c"

# Actual on_session_open payload. Only cli is allowed to own a Winmux pane.
emit("on_session_open", session_id=root_session, platform="cli", reason="create")
emit("on_session_open", session_id="desktop-chat", platform="desktop", reason="create")
emit("on_session_open", session_id="telegram-chat", platform="telegram", reason="create")

# Unknown and shared-surface sessions cannot self-promote, even when a later
# callback happens to omit delegation fields.
emit("pre_tool_call", tool_name="terminal", tool_call_id="unknown-tool",
     session_id="unknown-session", conversation_id="unknown-conversation")
emit("pre_llm_call", session_id="desktop-chat", parent_session_id="",
     platform="desktop", agent_id="root")
emit("pre_llm_call", session_id="telegram-chat", parent_session_id="",
     platform="telegram", agent_id="root")

# Installed agent/turn_context.py payload for a real root: no agent_id.
emit("pre_llm_call", session_id=root_session, task_id="task-1", turn_id="turn-1",
     user_message="secret-prompt-root", conversation_history=[{"content": "secret-history"}],
     is_first_turn=True, model="metadata-only", platform="cli",
     parent_session_id="", sender_id="user-1")

# Installed model_tools.py tool payload. conversation_id is the documented
# compression-stable root and is used only after this root is already trusted.
emit("pre_tool_call", tool_name="read_file", tool_call_id="tool-1", session_id=root_session,
     task_id="task-1", turn_id="turn-1", api_request_id="api-1",
     conversation_id="root-conversation", middleware_trace=[],
     args={"path": "secret-path"})
emit("subagent_start", parent_session_id=root_session,
     parent_turn_id="turn-1", parent_subagent_id="", child_session_id="child-session",
     child_subagent_id="child-1", child_role="leaf", child_goal="secret-goal")
emit("pre_tool_call", tool_name="terminal", tool_call_id="child-tool", session_id="child-session",
     task_id="task-child", turn_id="turn-child", api_request_id="api-child",
     conversation_id="root-conversation", args={"command": "secret-command"})
emit("post_tool_call", tool_name="terminal", tool_call_id="child-tool", session_id="child-session",
     conversation_id="root-conversation", result="secret-result", status="ok")
emit("pre_llm_call", session_id="metadata-child", parent_session_id="root-session",
     platform="cli", agent_id="subagent")
emit("pre_tool_call", tool_name="terminal", tool_call_id="metadata-tool",
     session_id="metadata-child", conversation_id="root-conversation")
emit("on_human_input_request", kind="approval", request_id="approval-1",
     session_id=root_session, session_key="root-key", platform="cli",
     prompt="secret-prompt")
emit("on_human_input_request", kind="sudo", request_id="approval-2",
     session_id=root_session, session_key="root-key", platform="cli",
     prompt="secret-password")
emit("on_human_input_resolved", kind="approval", request_id="approval-1",
     session_id=root_session, session_key="root-key", outcome="once")
emit("on_human_input_resolved", kind="sudo", request_id="approval-2",
     session_id=root_session, session_key="root-key", outcome="provided")
emit("on_human_input_request", kind="clarify", request_id="clarify-1",
     session_id=root_session, prompt="secret-question")
emit("post_tool_call", tool_name="read_file", tool_call_id="tool-1", session_id=root_session,
     conversation_id="root-conversation", result={"content": "secret-content"}, status="error",
     error_message="secret-error")

# Actual gateway /new reset payload. The old session proves the root lineage.
emit("on_session_reset", session_id=rotated_session, reason="new_session",
     platform="cli", old_session_id=root_session, new_session_id=rotated_session)
emit("pre_llm_call", session_id=rotated_session, task_id="task-2", turn_id="turn-2",
     user_message="secret-prompt-rotated", conversation_history=[],
     is_first_turn=True, model="metadata-only", platform="cli",
     parent_session_id="", sender_id="user-1")
emit("post_tool_call", tool_name="read_file", tool_call_id="tool-2",
     session_id=rotated_session, conversation_id="root-conversation",
     result="secret-rotated-result", status="ok")
emit("on_session_end", session_id=rotated_session, completed=False, failed=True,
     interrupted=False, conversation_id="root-conversation", platform="cli")
emit("on_session_finalize", session_id=rotated_session, platform="cli",
     conversation_id="root-conversation")

# Missing delegated-context proof, or an explicit delegated marker, must also
# stop an otherwise valid candidate before any root event is emitted.
for delegated_value in (None, True):
    sent_before = len(sent)
    isolated = module.WinmuxHermesPlugin(
        send=sent.append,
        monotonic_ns=lambda: next(clock),
        get_pid=lambda: 4242,
        get_cwd=lambda: r"E:\project",
        delegated_context=lambda value=delegated_value: value,
        environ={},
        async_delivery=False,
    )
    isolated.on_session_open(session_id="blocked-root", platform="cli", reason="create")
    isolated.pre_llm_call(session_id="blocked-root", parent_session_id="", platform="cli")
    assert len(sent) == sent_before, (delegated_value, sent[sent_before:])

print(json.dumps({"events": sent, "root": root_session, "rotated": rotated_session},
                 separators=(",", ":")))
`;
  const result = spawnSync(python, ['-c', fixture, plugin], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const sent = output.events;
  assert.deepEqual(sent.map(item => [item.event, item.state]), [
    ['session_start', 'idle'],
    ['agent_start', 'running'],
    ['tool_execution_start', 'running'],
    ['tool_approval_requested', 'waiting'],
    ['tool_approval_requested', 'waiting'],
    ['tool_approval_resolved', 'waiting'],
    ['tool_approval_resolved', 'running'],
    ['tool_execution_end', 'running'],
    ['session_switch', 'idle'],
    ['agent_start', 'running'],
    ['tool_execution_end', 'running'],
    ['agent_end', 'failed'],
    ['session_shutdown', 'idle'],
  ]);
  assert.equal(sent.every(item => item.agentId === 'hermes'), true);
  assert.equal(sent.every(item => item.sessionId === output.root), true);
  assert.equal(sent.some(item => ['desktop-chat', 'telegram-chat', 'unknown-session'].includes(item.sessionId)), false);
  assert.equal(sent.every(item => item.pid === 4242), true);
  assert.equal(sent.every(item => item.paneId === 'pane-1'), true);
  assert.match(sent[0].stamp, /^\d+$/);
  assert.deepEqual(
    sent.filter(item => item.toolName).map(item => [
      item.event, item.toolName, item.toolId, item.phase, item.state,
    ]),
    [
      ['tool_execution_start', 'read_file', 'tool-1', 'start', 'running'],
      ['tool_execution_end', 'read_file', 'tool-1', 'end', 'running'],
      ['tool_execution_end', 'read_file', 'tool-2', 'end', 'running'],
    ],
  );
  const serialised = JSON.stringify(sent);
  for (const secret of [
    'secret-path', 'secret-goal', 'secret-command', 'secret-result',
    'secret-prompt', 'secret-password', 'secret-question', 'secret-content',
    'secret-error', 'secret-prompt-root', 'secret-history', 'secret-prompt-rotated',
    'secret-rotated-result', 'child-session', 'metadata-child',
    'root-conversation',
  ]) assert.equal(serialised.includes(secret), false, `leaked ${secret}`);
});

test('Hermes keeps independent CLI roots isolated and reporting IDs stable through compression and reset', () => {
  const python = findPython();
  assert.ok(python, 'Python 3 is required to exercise the Hermes plugin');
  const plugin = path.resolve(__dirname, '..', 'electron', 'hooks', 'winmux-hermes-plugin.py');
  const fixture = String.raw`
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("winmux_hermes_plugin", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

sent = []
handlers = {}
delegated = False
clock = iter(range(10000, 11000))

class Context:
    def register_hook(self, name, callback):
        handlers[name] = callback

adapter = module.WinmuxHermesPlugin(
    send=sent.append, monotonic_ns=lambda: next(clock),
    get_pid=lambda: 4242, get_cwd=lambda: r"E:\project",
    delegated_context=lambda: delegated, environ={}, async_delivery=False,
)
adapter.register(Context())

def emit(name, **fields):
    handlers[name](**fields)

for sid in ("cli-root-a", "cli-root-b"):
    emit("on_session_open", session_id=sid, platform="cli", reason="create")
    # A candidate alone cannot emit a tool event before pre_llm_call proves it.
    emit("pre_tool_call", session_id=sid, conversation_id="unproven-" + sid,
         tool_name="terminal", tool_call_id="unproven-tool")
    emit("pre_llm_call", session_id=sid, platform="cli", parent_session_id="",
         task_id="task-" + sid, turn_id="turn-" + sid, user_message="secret-prompt",
         conversation_history=[], is_first_turn=True, model="metadata-only", sender_id="")

# Both roots stay eligible after the second one is proven. Waiting is per root.
emit("pre_tool_call", session_id="cli-root-a", conversation_id="conversation-a",
     tool_name="read_file", tool_call_id="a-1")
emit("on_human_input_request", session_id="cli-root-a", kind="approval",
     request_id="wait-a", platform="cli", prompt="secret-approval")
emit("pre_tool_call", session_id="cli-root-b", conversation_id="conversation-b",
     tool_name="terminal", tool_call_id="b-1")
emit("pre_tool_call", session_id="unknown", conversation_id="unknown-conversation",
     tool_name="terminal", tool_call_id="unknown-tool")
emit("subagent_start", parent_session_id="cli-root-b", child_session_id="child-b",
     child_subagent_id="sa-child", child_role="leaf", child_goal="secret-goal")
emit("pre_tool_call", session_id="child-b", conversation_id="conversation-b",
     tool_name="terminal", tool_call_id="child-tool")
delegated = True
emit("pre_tool_call", session_id="delegated-a", conversation_id="conversation-a",
     tool_name="terminal", tool_call_id="delegated-tool")
delegated = False

# Compression changes native session_id, but retains the proven conversation ID.
emit("pre_tool_call", session_id="cli-compressed-a", conversation_id="conversation-a",
     tool_name="read_file", tool_call_id="a-2")
emit("post_tool_call", session_id="cli-compressed-a", conversation_id="conversation-a",
     tool_name="read_file", tool_call_id="a-2", status="ok", result="secret-result")
emit("post_tool_call", session_id="cli-root-b", conversation_id="conversation-b",
     tool_name="terminal", tool_call_id="b-1", status="ok")

# Explicit reset follows the native compressed ID and carries its reporting ID.
emit("on_session_reset", session_id="cli-reset-a", platform="cli", reason="new_session",
     old_session_id="cli-compressed-a", new_session_id="cli-reset-a")
emit("pre_llm_call", session_id="cli-reset-a", platform="cli", parent_session_id="")
emit("pre_tool_call", session_id="cli-root-b", conversation_id="conversation-b",
     tool_name="read_file", tool_call_id="b-2")
emit("on_session_end", session_id="cli-reset-a", completed=True)
emit("on_session_finalize", session_id="cli-reset-a", platform="cli")
emit("post_tool_call", session_id="cli-root-b", conversation_id="conversation-b",
     tool_name="read_file", tool_call_id="b-2", status="ok")
emit("on_session_end", session_id="cli-root-b", failed=True)
emit("on_session_finalize", session_id="cli-root-b", platform="cli")
print(json.dumps(sent))
`;
  const result = spawnSync(python, ['-c', fixture, plugin], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const sent = JSON.parse(result.stdout);
  assert.deepEqual(sent.map(item => [item.sessionId, item.event, item.state, item.toolId || null]), [
    ['cli-root-a', 'session_start', 'idle', null],
    ['cli-root-a', 'agent_start', 'running', null],
    ['cli-root-b', 'session_start', 'idle', null],
    ['cli-root-b', 'agent_start', 'running', null],
    ['cli-root-a', 'tool_execution_start', 'running', 'a-1'],
    ['cli-root-a', 'tool_approval_requested', 'waiting', null],
    ['cli-root-b', 'tool_execution_start', 'running', 'b-1'],
    ['cli-root-a', 'session_switch', 'idle', null],
    ['cli-root-a', 'tool_execution_start', 'running', 'a-2'],
    ['cli-root-a', 'tool_execution_end', 'running', 'a-2'],
    ['cli-root-b', 'tool_execution_end', 'running', 'b-1'],
    ['cli-root-a', 'session_switch', 'idle', null],
    ['cli-root-a', 'agent_start', 'running', null],
    ['cli-root-b', 'tool_execution_start', 'running', 'b-2'],
    ['cli-root-a', 'agent_end', 'completed', null],
    ['cli-root-a', 'session_shutdown', 'idle', null],
    ['cli-root-b', 'tool_execution_end', 'running', 'b-2'],
    ['cli-root-b', 'agent_end', 'failed', null],
    ['cli-root-b', 'session_shutdown', 'idle', null],
  ]);
  assert.equal(sent.every(item => item.pid === 4242), true);
  assert.equal(JSON.stringify(sent).includes('secret-'), false);
});

test('Hermes and Pi monotonic stamps share the Windows clock origin', {
  skip: process.platform !== 'win32',
}, () => {
  const python = findPython();
  assert.ok(python, 'Python 3 is required for the Windows clock comparison');
  const result = spawnSync(python, ['-c', 'import time; print(time.monotonic_ns())'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const pythonStamp = BigInt(result.stdout.trim());
  const nodeStamp = process.hrtime.bigint();
  const delta = pythonStamp > nodeStamp ? pythonStamp - nodeStamp : nodeStamp - pythonStamp;
  assert.ok(delta <= 1_000_000_000n, `clock delta was ${delta}ns`);
});
