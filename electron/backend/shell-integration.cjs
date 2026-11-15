'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { fail, string } = require('./shared.cjs');

const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const powershellInit = String.raw`[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$global:__winmuxOriginalPrompt = $function:prompt
function global:prompt {
  $winmuxExitCode = $global:LASTEXITCODE
  $winmuxPromptText = & $global:__winmuxOriginalPrompt
  if ($PWD.Provider.Name -eq 'FileSystem') {
    [Console]::Write(([char]27 + ']7;' + ([System.Uri]::new($PWD.ProviderPath)).AbsoluteUri + [char]7))
  }
  $global:LASTEXITCODE = $winmuxExitCode
  $winmuxPromptText
}`;
// Encode bytes, not Unicode code points: OSC 7 carries a percent-encoded UTF-8 URL.
const bashInit = String.raw`_winmux_prompt() {
  local LC_ALL=C value="$PWD" encoded='' ch hex i
  for ((i=0; i<${'${'}#value}; i++)); do
    ch="${'${'}value:i:1}"
    case "$ch" in
      [a-zA-Z0-9/._~-]) encoded+="$ch" ;;
      *) printf -v hex '%%%02X' "'$ch"; encoded+="$hex" ;;
    esac
  done
  printf '\033]7;file://localhost%s\007' "$encoded"
}
export -f _winmux_prompt
export PROMPT_COMMAND=_winmux_prompt
_winmux_prompt
if [ -n "$1" ]; then
  printf '\033]1337;WinmuxAgent;%s;unknown;\007' "$WINMUX_AGENT_LAUNCH_ID"
  "$@"
  _winmux_exit=$?
  if [ "$_winmux_exit" -eq 0 ]; then _winmux_state=completed; else _winmux_state=failed; fi
  printf '\033]1337;WinmuxAgent;%s;%s;%s\007' "$WINMUX_AGENT_LAUNCH_ID" "$_winmux_state" "$_winmux_exit"
fi
exec /bin/bash --noprofile --norc -i`;

function selectedAgent(environment, profile, agentId) {
  if (agentId === undefined) return undefined;
  string(agentId, 'agentId', 256);
  const agent = environment.agents.find(item => item.id === agentId);
  if (!agent?.available || !agent.command) fail('AGENT_UNAVAILABLE', `Agent is unavailable: ${agentId}`);
  if (agent.profileId !== profile.id || agent.environment !== profile.environment) fail('AGENT_PROFILE_MISMATCH', 'Selected agent does not belong to the terminal profile');
  string(agent.command, 'agent command', 4096);
  if (/[\x00-\x1f\x7f]/.test(agent.command) || !(profile.environment === 'wsl' ? path.posix.isAbsolute(agent.command) : path.isAbsolute(agent.command))) fail('AGENT_UNAVAILABLE', 'Selected agent has no valid executable path');
  if (process.platform === 'win32' && profile.environment !== 'wsl' && !/\.(exe|cmd|bat|ps1)$/i.test(agent.command)) fail('AGENT_UNAVAILABLE', 'Selected agent is not a Windows executable or script');
  if (agent.args !== undefined && (!Array.isArray(agent.args) || agent.args.length > 64 || agent.args.some(arg => typeof arg !== 'string' || arg.length > 65536 || arg.includes('\0')))) fail('AGENT_UNAVAILABLE', 'Invalid agent argument vector');
  return agent;
}
function shellArgs(profile, agent, bashAvailable = true) {
  if (profile.environment === 'wsl') {
    if (!bashAvailable) {
      if (agent) fail('AGENT_UNAVAILABLE', 'Selected agent requires Bash in this distribution');
      return ['/bin/sh', '-i'];
    }
    // The executable is a positional argument, never part of shell source.
    return ['/bin/bash', '--noprofile', '--norc', '-c', bashInit, 'winmux-init', agent?.command || '', ...(agent?.args || [])];
  }
  if (process.platform !== 'win32') return [...profile.args];
  // -EncodedCommand keeps shell source, Unicode paths and argument arrays intact through ConPTY.
  // Honor a same-name function supplied by the user's profile (e.g. proxy wrappers),
  // otherwise use the selected executable literal rather than a PATH lookup.
  const invocation = agent ? String.raw`
prompt | Out-Null
$winmuxCommand = ${psQuote(agent.command)}
$winmuxName = ${psQuote(path.win32.basename(agent.command).replace(/\.(exe|cmd|bat|ps1)$/i, ''))}
$winmuxArgs = @(${(agent.args || []).map(psQuote).join(',')})
$winmuxWrapper = Get-Command -Name $winmuxName -CommandType Function -ErrorAction SilentlyContinue | Select-Object -First 1
if ($winmuxWrapper) { $winmuxCommand = $winmuxWrapper }
$winmuxOldPreference = $ErrorActionPreference
$winmuxOldArgumentPassing = $PSNativeCommandArgumentPassing
$winmuxCode = 1
[Console]::Write(([char]27 + ']1337;WinmuxAgent;' + $env:WINMUX_AGENT_LAUNCH_ID + ';unknown;' + [char]7))
try {
  $ErrorActionPreference = 'Stop'
  $PSNativeCommandArgumentPassing = 'Standard'
  ${agent.sessionHooks ? "if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Winmux session hooks require PowerShell 7.3 or later for reliable native argument passing' }" : ''}
  $global:LASTEXITCODE = 0
  & $winmuxCommand @winmuxArgs
  $winmuxSucceeded = $?
  $winmuxCode = if ($winmuxSucceeded -or $global:LASTEXITCODE -ne 0) { [int]$global:LASTEXITCODE } else { 1 }
} catch {
  $winmuxCode = if ($global:LASTEXITCODE -ne 0) { [int]$global:LASTEXITCODE } else { 1 }
  [Console]::Error.WriteLine(('Winmux agent launch failed: ' + $_.Exception.Message))
} finally {
  $ErrorActionPreference = $winmuxOldPreference
  $PSNativeCommandArgumentPassing = $winmuxOldArgumentPassing
  $winmuxState = if ($winmuxCode -eq 0) { 'completed' } else { 'failed' }
  [Console]::Write(([char]27 + ']1337;WinmuxAgent;' + $env:WINMUX_AGENT_LAUNCH_ID + ';' + $winmuxState + ';' + $winmuxCode + [char]7))
  $global:LASTEXITCODE = $winmuxCode
}` : '';
  const script = powershellInit + invocation;
  return ['-NoLogo', ...(profile.args.includes('-NoProfile') ? ['-NoProfile'] : []), '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
function cwdFromOsc(data, environment) {
  if (typeof data !== 'string' || data.length > 16384) return null;
  try {
    const url = new URL(data);
    if (url.protocol !== 'file:' || url.username || url.password || url.port || url.search || url.hash) return null;
    let cwd;
    if (environment === 'wsl') {
      if (url.hostname && url.hostname !== 'localhost' && url.hostname.toLowerCase() !== require('node:os').hostname().toLowerCase()) return null;
      cwd = decodeURIComponent(url.pathname);
      if (!path.posix.isAbsolute(cwd)) return null;
      cwd = path.posix.normalize(cwd);
    } else {
      cwd = fileURLToPath(url);
      if (!path.isAbsolute(cwd)) return null;
      cwd = path.normalize(cwd);
    }
    return cwd.length <= 4096 && !/[\x00-\x1f\x7f]/.test(cwd) ? cwd : null;
  } catch { return null; }
}
module.exports = { selectedAgent, shellArgs, cwdFromOsc };
