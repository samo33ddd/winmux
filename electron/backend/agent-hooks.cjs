'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./shared.cjs');
const { validTaskId } = require('./task-instructions.cjs');

const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const shQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
const wslPath = value => /^[A-Za-z]:[\\/]/.test(value) ? '/mnt/' + value[0].toLowerCase() + value.slice(2).replace(/\\/g, '/') : value;
// Forward Node mode through WSL interop only for this helper invocation.
const wslNodeEnv = 'ELECTRON_RUN_AS_NODE=1 WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE"';
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt'];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function completeHookContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) fail('AGENT_HOOKS_CONTEXT', 'Session hook context is required');
  const { paneId, launchId, dataDir, pipeName, taskId } = context;
  if (!IDENTIFIER.test(paneId || '') || !IDENTIFIER.test(launchId || '')) {
    fail('AGENT_HOOKS_CONTEXT', 'Session hook pane and launch identities are invalid');
  }
  const absolute = value => typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value));
  if (!absolute(dataDir) || dataDir.length > 1024 || dataDir.includes('\0')) {
    fail('AGENT_HOOKS_CONTEXT', 'Session hook data directory is invalid');
  }
  if (typeof pipeName !== 'string' || !pipeName || pipeName.length > 260 || pipeName.includes('\0')) {
    fail('AGENT_HOOKS_CONTEXT', 'Session hook pipe name is invalid');
  }
  if (taskId !== undefined && !validTaskId(taskId)) fail('AGENT_HOOKS_CONTEXT', 'Session hook task ID is invalid');
  return { version: 1, paneId, launchId, dataDir, pipeName, ...(taskId === undefined ? {} : { taskId }) };
}

function cleanupCodexHookArtifacts(artifacts) {
  for (const file of artifacts?.files || []) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') console.warn(`Winmux hook artifact cleanup: ${error.message}`); }
  }
}

function prepareCodexHookArtifacts(context, withWrapper = true) {
  if (process.platform !== 'win32') fail('AGENT_HOOKS_CONTEXT', 'Windows session hook artifacts require Windows');
  const value = completeHookContext(context);
  const root = path.resolve(value.dataDir, 'hooks', 'session');
  const relative = path.relative(path.resolve(value.dataDir), root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('AGENT_HOOKS_CONTEXT', 'Session hook directory is outside the Winmux data directory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const contextPath = path.join(root, `codex-${value.launchId}.json`);
  const wrapperPath = withWrapper ? path.join(root, `codex-${value.launchId}.ps1`) : null;
  const artifacts = { contextPath, wrapperPath, files: [contextPath, ...(wrapperPath ? [wrapperPath] : [])] };
  try {
    fs.writeFileSync(contextPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (!wrapperPath) return artifacts;
    const wrapper = [
      "$ErrorActionPreference = 'Stop'",
      "$env:ELECTRON_RUN_AS_NODE = '1'",
      `& ${psQuote(process.execPath)} ${psQuote(path.join(__dirname, 'agent-status.cjs'))} --codex --context-file ${psQuote(contextPath)}`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n');
    fs.writeFileSync(wrapperPath, wrapper, { flag: 'wx', mode: 0o600 });
    return artifacts;
  } catch (error) {
    cleanupCodexHookArtifacts(artifacts);
    fail('AGENT_HOOKS_ARTIFACT', `Cannot create session hook artifacts: ${error.message}`);
  }
}

function windowsClaudeHookCommand() {
  // Inherited per-launch paths also keep repeated hook config below the Windows
  // process command-line limit. The environment values are never shell source.
  // This PowerShell process belongs only to the hook, never the pane shell.
  const script = `$env:ELECTRON_RUN_AS_NODE='1'; & $env:WINMUX_AGENT_NODE $env:WINMUX_AGENT_HELPER --claude`;
  return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function windowsCodexHookCommand(wrapperPath) {
  const script = `& ${psQuote(wrapperPath)}`;
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function claudeSettings(profile) {
  const windows = profile.environment !== 'wsl' && process.platform === 'win32';
  const convert = profile.environment === 'wsl' ? wslPath : value => value;
  const quote = windows ? psQuote : shQuote;
  // WSL launches the Windows Electron executable through /mnt, but that
  // executable resolves its script argument using Windows path semantics.
  const executable = convert(process.execPath), helper = path.join(__dirname, 'agent-status.cjs');
  // Keep shell metacharacters out of npm .cmd argument vectors, even inside JSON.
  const command = windows ? windowsClaudeHookCommand() : `${profile.environment === 'wsl' ? wslNodeEnv : 'ELECTRON_RUN_AS_NODE=1'} ${quote(executable)} ${quote(helper)} --claude`;
  const entry = matcher => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', ...(windows ? { shell: 'powershell' } : {}), command, timeout: 5 }] }];
  // https://code.claude.com/docs/en/hooks: entries merge across settings levels.
  // --settings is session-only; no user/project/global file is written or replaced.
  return { hooks: { UserPromptSubmit: entry(), PreToolUse: entry(), PostToolUse: entry(), PostToolUseFailure: entry(),
    PermissionRequest: entry(), Notification: [...entry('permission_prompt'), ...entry('idle_prompt')], Stop: entry(), StopFailure: entry() } };
}
function withSessionHooks(agent, profile, enabled, context) {
  const args = [...(agent.args || [])];
  let hookArtifacts = null;
  if (enabled) {
    if (agent.hookAdapter === 'claude') args.push('--settings', JSON.stringify(claudeSettings(profile)));
    else if (agent.hookAdapter === 'codex') {
      if (process.platform === 'win32' && profile.environment !== 'wsl') hookArtifacts = prepareCodexHookArtifacts(context);
      else if (process.platform === 'win32' && profile.environment === 'wsl' && context?.taskId !== undefined) {
        hookArtifacts = prepareCodexHookArtifacts(context, false);
      }
      args.push(...codexHookArgs(profile, hookArtifacts?.wrapperPath, hookArtifacts?.contextPath));
    }
    else fail('AGENT_HOOKS_UNSUPPORTED', 'Session hooks are supported only for Claude and Codex; other agents keep shell-confirmed status');
  }
  // Never supply Codex notify: replacing it could discard a user's existing notifier,
  // and legacy notify confirms only a completed turn, not running/waiting activity.
  return { ...agent, args, sessionHooks: enabled, hookArtifacts, cleanupHooks: hookArtifacts ? () => cleanupCodexHookArtifacts(hookArtifacts) : undefined };
}
function codexHookArgs(profile, wrapperPath, contextPath) {
  const convert = profile.environment === 'wsl' ? wslPath : value => value;
  const helper = path.join(__dirname, 'agent-status.cjs'), executable = convert(process.execPath);
  const windows = process.platform === 'win32' && profile.environment !== 'wsl';
  if (windows && !wrapperPath) fail('AGENT_HOOKS_CONTEXT', 'Windows Codex session hooks require a per-launch wrapper');
  const commandWindows = windows ? windowsCodexHookCommand(wrapperPath) : null;
  const contextArg = profile.environment === 'wsl' && contextPath ? ` --context-file ${shQuote(contextPath)}` : '';
  const command = profile.environment === 'wsl' ? `${wslNodeEnv} ${shQuote(executable)} ${shQuote(helper)} --codex${contextArg}` : commandWindows;
  // Native hook discovery collects each settings layer independently, including
  // SessionFlags from -c. Existing hooks and notify stay in their own layers.
  // https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs
  const args = CODEX_EVENTS.flatMap(event => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},${commandWindows ? `commandWindows=${JSON.stringify(commandWindows)},` : ''}timeout=5}]}]`]);
  if (args.reduce((total, arg) => total + Buffer.byteLength(arg) + 3, 0) > 30000) fail('AGENT_HOOKS_TOO_LARGE', 'Codex session hook arguments exceed the Windows command-line budget');
  return args;
}
module.exports = {
  claudeSettings,
  codexHookArgs,
  withSessionHooks,
  prepareCodexHookArtifacts,
  cleanupCodexHookArtifacts,
};
