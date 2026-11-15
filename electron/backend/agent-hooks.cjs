'use strict';
const path = require('node:path');
const { fail } = require('./shared.cjs');

const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const shQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
const wslPath = value => /^[A-Za-z]:[\\/]/.test(value) ? '/mnt/' + value[0].toLowerCase() + value.slice(2).replace(/\\/g, '/') : value;
// Forward Node mode through WSL interop only for this helper invocation.
const wslNodeEnv = 'ELECTRON_RUN_AS_NODE=1 WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE"';
function windowsHookCommand(adapter) {
  // Inherited per-launch paths also keep repeated hook config below the Windows
  // process command-line limit. The environment values are never shell source.
  // This PowerShell process belongs only to the hook, never the pane shell.
  const script = `$env:ELECTRON_RUN_AS_NODE='1'; & $env:WINMUX_AGENT_NODE $env:WINMUX_AGENT_HELPER --${adapter}`;
  return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function claudeSettings(profile) {
  const windows = profile.environment !== 'wsl' && process.platform === 'win32';
  const convert = profile.environment === 'wsl' ? wslPath : value => value;
  const quote = windows ? psQuote : shQuote;
  // WSL launches the Windows Electron executable through /mnt, but that
  // executable resolves its script argument using Windows path semantics.
  const executable = convert(process.execPath), helper = path.join(__dirname, 'agent-status.cjs');
  // Keep shell metacharacters out of npm .cmd argument vectors, even inside JSON.
  const command = windows ? windowsHookCommand('claude') : `${profile.environment === 'wsl' ? wslNodeEnv : 'ELECTRON_RUN_AS_NODE=1'} ${quote(executable)} ${quote(helper)} --claude`;
  const entry = matcher => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', ...(windows ? { shell: 'powershell' } : {}), command, timeout: 5 }] }];
  // https://code.claude.com/docs/en/hooks: entries merge across settings levels.
  // --settings is session-only; no user/project/global file is written or replaced.
  return { hooks: { UserPromptSubmit: entry(), PreToolUse: entry(), PostToolUse: entry(),
    PermissionRequest: entry(), Notification: [...entry('permission_prompt'), ...entry('idle_prompt')], Stop: entry(), StopFailure: entry() } };
}
function withSessionHooks(agent, profile, enabled) {
  const args = [...(agent.args || [])];
  if (enabled) {
    if (agent.hookAdapter === 'claude') args.push('--settings', JSON.stringify(claudeSettings(profile)));
    else if (agent.hookAdapter === 'codex') args.push(...codexHookArgs(profile));
    else fail('AGENT_HOOKS_UNSUPPORTED', 'Session hooks are supported only for Claude and Codex; other agents keep shell-confirmed status');
  }
  // Never supply Codex notify: replacing it could discard a user's existing notifier,
  // and legacy notify confirms only a completed turn, not running/waiting activity.
  return { ...agent, args, sessionHooks: enabled };
}
function codexHookArgs(profile) {
  const convert = profile.environment === 'wsl' ? wslPath : value => value;
  const helper = path.join(__dirname, 'agent-status.cjs'), executable = convert(process.execPath);
  const commandWindows = windowsHookCommand('codex');
  const command = profile.environment === 'wsl' ? `${wslNodeEnv} ${shQuote(executable)} ${shQuote(helper)} --codex` : commandWindows;
  // Native hook discovery collects each settings layer independently, including
  // SessionFlags from -c. Existing hooks and notify stay in their own layers.
  // https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs
  return ['UserPromptSubmit', 'PreModelRequest', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt'].flatMap(event =>
    ['-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},commandWindows=${JSON.stringify(commandWindows)},timeout=5}]}]`]);
}
module.exports = { claudeSettings, codexHookArgs, withSessionHooks };
