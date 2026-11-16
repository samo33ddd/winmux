'use strict';
// Authenticated, per-launch hook bridge. No prompt/transcript content is transmitted.
const fs = require('node:fs');
const path = require('node:path');
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
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event?.hook_event_name)) return 'running';
  if (['PermissionRequest', 'Interrupt'].includes(event?.hook_event_name)) return 'waiting';
  if (event?.hook_event_name === 'Stop') return 'completed';
  if (event?.hook_event_name === 'SessionStart') return 'idle';
  return null;
}
function hookActivity(event) {
  const phase = event?.hook_event_name === 'PreToolUse' ? 'start' : ['PostToolUse', 'PostToolUseFailure'].includes(event?.hook_event_name) ? 'end' : undefined;
  const toolName = event?.tool_name, toolId = event?.tool_use_id;
  if (!phase || typeof toolName !== 'string' || !toolName || toolName.length > 256 || toolName.includes('\0')
    || typeof toolId !== 'string' || !toolId || toolId.length > 256 || toolId.includes('\0')) return {};
  return { phase, toolName, toolId };
}
function validContext(value) {
  const keys = ['dataDir', 'launchId', 'paneId', 'pipeName', 'version'];
  const validId = item => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== keys.join('\0')
    || value.version !== 1
    || !validId(value.paneId) || !validId(value.launchId)
    || typeof value.dataDir !== 'string' || !path.win32.isAbsolute(value.dataDir) || value.dataDir.length > 4096 || value.dataDir.includes('\0')
    || typeof value.pipeName !== 'string' || !value.pipeName || value.pipeName.length > 260 || value.pipeName.includes('\0')) {
    throw new Error('Winmux hook context is invalid');
  }
  return value;
}
function readContextFile(file) {
  if (typeof file !== 'string' || !path.win32.isAbsolute(file) || file.length > 4096 || file.includes('\0')) throw new Error('Winmux hook context file is invalid');
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw new Error('Winmux hook context file is unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Winmux hook context file is invalid');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Winmux hook context is invalid'); }
  return validContext(parsed);
}
function launchContext(env, context) {
  return context || {
    paneId: env.WINMUX_PANE_ID,
    launchId: env.WINMUX_AGENT_LAUNCH_ID,
    dataDir: env.WINMUX_DATA_DIR,
    pipeName: env.WINMUX_PIPE_NAME,
  };
}
async function report(state, env = process.env, activity = {}, context = null) {
  const launch = launchContext(env, context);
  if (!launch.paneId || !launch.launchId || !launch.dataDir || !launch.pipeName) throw new Error('Winmux launch context is required');
  const client = await connect({ dataDir: launch.dataDir, pipeName: launch.pipeName, connectTimeout: 1500, requestTimeout: 1500 });
  try { return await client.request('agent.status', { paneId: launch.paneId, launchId: launch.launchId, state, ...activity }); }
  finally { client.close(); }
}
async function main() {
  let state, activity = {}, context = null;
  if (['--claude', '--codex'].includes(process.argv[2])) {
    const contextIndex = process.argv.indexOf('--context-file');
    if (contextIndex !== -1) context = readContextFile(process.argv[contextIndex + 1]);
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > LIMITS.request) throw new Error('Hook input is too large'); }
    const event = JSON.parse(input);
    if ((process.argv[2] === '--claude' && event.agent_id) || event.parent_thread_id || event.parent_session_id) return;
    state = (process.argv[2] === '--claude' ? claudeState : codexState)(event);
    activity = hookActivity(event);
    if (!state) return;
  } else if (process.argv[2] === '--state') state = process.argv[3];
  else throw new Error('Expected --claude/--codex (JSON on stdin) or --state <state>');
  await report(state, process.env, activity, context);
}
module.exports = { report, claudeState, codexState, hookActivity, readContextFile };
if (require.main === module) {
  const deadline = setTimeout(() => process.exit(1), 4000);
  main().then(() => clearTimeout(deadline), () => { clearTimeout(deadline); console.error('Winmux agent status could not be delivered'); process.exitCode = 1; });
}
