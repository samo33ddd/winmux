'use strict';
// Single source for supported agent ids, display labels, hook capabilities and
// install destinations. Standalone copies under electron/hooks keep their own
// literals; nothing here is read by the installed helpers.
const EXTENSION_EVENTS = Object.freeze([
  'session_start', 'session_switch', 'session_shutdown', 'agent_start', 'agent_end',
  'tool_execution_start', 'tool_execution_end', 'tool_approval_requested', 'tool_approval_resolved',
]);
const HOOK_STATES = Object.freeze(['running', 'waiting', 'idle', 'completed', 'failed']);

const AGENTS = Object.freeze({
  claude: Object.freeze({
    label: 'Claude',
    hookAdapter: 'claude',
    deliverySupport: 'instructions',
    eventStates: Object.freeze({
      SessionStart: 'idle', UserPromptSubmit: 'running', PreToolUse: 'running', PostToolUse: 'running',
      PostToolUseFailure: 'running', PermissionRequest: 'waiting', Stop: 'completed', StopFailure: 'failed', SessionEnd: 'idle',
    }),
    hookEvents: Object.freeze([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
      'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd',
    ]),
    install: Object.freeze({
      projectDir: '.claude',
      configFile: 'settings.local.json',
      helper: 'winmux-agent-event.cjs',
      helperMarker: 'winmux-agent-event',
      marker: 'winmux-claude-hook',
      ownedStatus: 'Winmux Claude activity [winmux-owned]',
    }),
  }),
  codex: Object.freeze({
    label: 'Codex',
    hookAdapter: 'codex',
    deliverySupport: 'hooks',
    eventStates: Object.freeze({
      UserPromptSubmit: 'running', PreToolUse: 'running', PostToolUse: 'running',
      PermissionRequest: 'waiting', Interrupt: 'waiting', Stop: 'completed', SessionStart: 'idle',
    }),
    sessionHookEvents: Object.freeze([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt',
    ]),
    hookEvents: Object.freeze([
      'SessionStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit',
      'PreModelRequest', 'PostModelRequest', 'Stop', 'Interrupt', 'SessionEnd',
    ]),
    install: Object.freeze({
      projectDir: '.codex',
      configFile: 'hooks.json',
      helper: 'winmux-agent-hook.cjs',
      helperMarker: 'winmux-codex-hook',
      marker: 'winmux-codex-hook',
      ownedStatus: 'Winmux Codex activity [winmux-owned]',
    }),
  }),
  hermes: Object.freeze({
    label: 'Hermes',
    deliverySupport: 'unsupported',
    extensionEvents: EXTENSION_EVENTS,
    hookEvents: Object.freeze([
      'on_session_open', 'on_session_reset', 'on_session_finalize', 'pre_llm_call',
      'pre_tool_call', 'post_tool_call', 'on_session_end', 'subagent_start',
      'subagent_stop', 'on_human_input_request', 'on_human_input_resolved',
    ]),
    install: Object.freeze({
      helper: 'winmux-agent-event.cjs',
      helperMarker: 'winmux-agent-event',
      marker: 'winmux-hermes-plugin',
    }),
  }),
  omp: Object.freeze({
    label: 'OMP',
    deliverySupport: 'instructions',
    extensionEvents: EXTENSION_EVENTS,
    install: Object.freeze({
      extensionDir: ['.omp', 'extensions'],
      extensionFile: 'winmux-status.ts',
      template: 'winmux-omp-extension.mjs',
      marker: 'winmux-omp-extension',
      helper: 'winmux-omp-hook.cjs',
      helperMarker: 'winmux-omp-hook',
      stagePrefix: 'winmux-status',
    }),
  }),
  pi: Object.freeze({
    label: 'Pi',
    deliverySupport: 'unsupported',
    extensionEvents: EXTENSION_EVENTS,
    install: Object.freeze({
      extensionDir: ['.pi', 'extensions'],
      extensionFile: 'winmux-status.ts',
      template: 'winmux-pi-extension.mjs',
      marker: 'winmux-pi-extension',
      helper: 'winmux-agent-event.cjs',
      helperMarker: 'winmux-agent-event',
      stagePrefix: 'winmux-pi',
    }),
  }),
});

const AGENT_IDS = Object.freeze(Object.keys(AGENTS));
// Project hooks installed through agent.hooks.install; codex is handled by its own native controller.
const HOOK_AGENT_IDS = Object.freeze(new Set(AGENT_IDS.filter(id => id !== 'codex')));

function agentEntry(id) {
  return AGENTS[String(id || '').split(':').pop()];
}

module.exports = { AGENTS, AGENT_IDS, HOOK_AGENT_IDS, HOOK_STATES, EXTENSION_EVENTS, agentEntry };
