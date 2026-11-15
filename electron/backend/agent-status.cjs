'use strict';
// Authenticated, per-launch hook bridge. No prompt/transcript content is transmitted.
const { connect } = require('../client.cjs');
const { LIMITS } = require('./shared.cjs');

function claudeState(event) {
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event?.hook_event_name)) return 'running';
  if (event?.hook_event_name === 'PermissionRequest') return 'waiting';
  if (event?.hook_event_name === 'Notification' && ['permission_prompt', 'idle_prompt'].includes(event.notification_type)) return 'waiting';
  if (event?.hook_event_name === 'Stop') return 'completed';
  if (event?.hook_event_name === 'StopFailure') return 'failed';
  return null;
}
function codexState(event) {
  if (['UserPromptSubmit', 'PreModelRequest', 'PreToolUse', 'PostToolUse'].includes(event?.hook_event_name)) return 'running';
  if (['PermissionRequest', 'Interrupt'].includes(event?.hook_event_name)) return 'waiting';
  if (event?.hook_event_name === 'Stop') return 'completed';
  return null;
}
function hookActivity(event) {
  const phase = event?.hook_event_name === 'PreToolUse' ? 'start' : ['PostToolUse', 'PostToolUseFailure'].includes(event?.hook_event_name) ? 'end' : undefined;
  const toolName = event?.tool_name, toolId = event?.tool_use_id;
  if (!phase || typeof toolName !== 'string' || !toolName || toolName.length > 256 || toolName.includes('\0')
    || typeof toolId !== 'string' || !toolId || toolId.length > 256 || toolId.includes('\0')) return {};
  return { phase, toolName, toolId };
}
async function report(state, env = process.env, activity = {}) {
  if (!env.WINMUX_PANE_ID || !env.WINMUX_AGENT_LAUNCH_ID || !env.WINMUX_DATA_DIR || !env.WINMUX_PIPE_NAME) throw new Error('Winmux launch context is required');
  const client = await connect({ dataDir: env.WINMUX_DATA_DIR, pipeName: env.WINMUX_PIPE_NAME, connectTimeout: 1500, requestTimeout: 1500 });
  try { return await client.request('agent.status', { paneId: env.WINMUX_PANE_ID, launchId: env.WINMUX_AGENT_LAUNCH_ID, state, ...activity }); }
  finally { client.close(); }
}
async function main() {
  let state, activity = {};
  if (['--claude', '--codex'].includes(process.argv[2])) {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > LIMITS.request) throw new Error('Hook input is too large'); }
    const event = JSON.parse(input);
    if ((process.argv[2] === '--claude' && event.agent_id) || event.parent_thread_id || event.parent_session_id) return;
    state = (process.argv[2] === '--claude' ? claudeState : codexState)(event);
    activity = hookActivity(event);
    if (!state) return;
  } else if (process.argv[2] === '--state') state = process.argv[3];
  else throw new Error('Expected --claude/--codex (JSON on stdin) or --state <state>');
  await report(state, process.env, activity);
}
module.exports = { report, claudeState, codexState, hookActivity };
if (require.main === module) {
  const deadline = setTimeout(() => process.exit(1), 4000);
  main().then(() => clearTimeout(deadline), () => { clearTimeout(deadline); console.error('Winmux agent status could not be delivered'); process.exitCode = 1; });
}
