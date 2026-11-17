'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { fail, string } = require('./shared.cjs');
const { selectedAgent, shellArgs } = require('./shell-integration.cjs');
const { withSessionHooks } = require('./agent-hooks.cjs');
const { installProjectAgentHooks } = require('../agent-hooks-install.cjs');
const { taskInstructionArgs } = require('./task-instructions.cjs');
const { AGENTS, AGENT_IDS } = require('./agent-registry.cjs');
const execFileAsync = promisify(execFile); // Argument arrays only; no shell interpolation.
const agentNames = AGENT_IDS;
const wslAgentScript = 'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; command -v "$1" 2>/dev/null || true';
async function run(command, args, timeout = 8000) {
  const { stdout } = await execFileAsync(command, args, { windowsHide: true, timeout, maxBuffer: 256 * 1024, encoding: 'buffer' });
  return (stdout.includes(0) ? stdout.toString('utf16le') : stdout.toString('utf8')).replace(/^\uFEFF/, '').trim();
}
async function executable(name, candidates = []) {
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  try {
    const found = await run(process.platform === 'win32' ? 'where.exe' : 'which', [name], 3000);
    const paths = found.split(/\r?\n/).filter(p => p && fs.existsSync(p));
    // npm also installs an extensionless POSIX shell shim. It is not a Windows executable.
    if (process.platform === 'win32') return paths.find(p => /\.exe$/i.test(p)) || paths.find(p => /\.(cmd|bat)$/i.test(p)) || paths.find(p => /\.ps1$/i.test(p)) || null;
    return paths[0] || null;
  } catch { return null; }
}
const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
function wslAgent(profile, name, available, command) {
  const entry = AGENTS[name];
  return { id: `${profile.id}:${name}`, label: entry.label, environment: 'wsl', profileId: profile.id, distro: profile.distro, available, command, ...(entry.hookAdapter ? { hookAdapter: entry.hookAdapter } : {}) };
}
async function probeWslAgent(profile, name) {
  return run(profile.command, [...profile.args, '--exec', 'sh', '-c', wslAgentScript, 'winmux-agent-probe', name]);
}
async function selectedAgentForLaunch(environment, profile, agentId) {
  if (agentId === undefined || profile.environment !== 'wsl') return selectedAgent(environment, profile, agentId);
  string(agentId, 'agentId', 256);
  const agent = environment.agents.find(item => item.id === agentId);
  if (!agent || agent.available !== null) return selectedAgent(environment, profile, agentId);
  if (agent.profileId !== profile.id || agent.environment !== profile.environment) fail('AGENT_PROFILE_MISMATCH', 'Selected agent does not belong to the terminal profile');
  const prefix = `${profile.id}:`;
  if (!agent.id.startsWith(prefix) || agent.id.length === prefix.length) fail('AGENT_UNAVAILABLE', `Agent is unavailable: ${agentId}`);
  let command;
  try { command = await probeWslAgent(profile, agent.id.slice(prefix.length)); }
  catch { fail('AGENT_UNAVAILABLE', `Agent is unavailable: ${agentId}`); }
  const resolved = { ...agent, available: Boolean(command), command: command || null };
  return selectedAgent({ ...environment, agents: environment.agents.map(item => item === agent ? resolved : item) }, profile, agentId);
}
// Session hook launches need PowerShell 7.3+ for reliable native argument
// passing. Probe the actual hook shell before any state mutation so an
// incompatible profile is a pre-flight rejection, not a mid-launch failure.
async function validateSessionHookShell(profile) {
  if (profile.environment !== 'windows') return;
  const output = await run(profile.command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
    .catch(error => { fail('AGENT_HOOKS_UNSUPPORTED', `Session hooks require PowerShell 7.3 or later; cannot probe the hook shell: ${String(error.message || error).split('\n')[0]}`); });
  const parsed = /^(\d+)\.(\d+)/.exec(output.trim());
  if (!parsed || Number(parsed[1]) < 7 || (Number(parsed[1]) === 7 && Number(parsed[2]) < 3)) {
    fail('AGENT_HOOKS_UNSUPPORTED', 'Session hooks require PowerShell 7.3 or later');
  }
}
async function discover() {
  const profiles = [];
  if (process.platform === 'win32') {
    const pwsh = await executable('pwsh.exe', [path.join(process.env.ProgramFiles || 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe')]);
    const fallback = !pwsh && await executable('powershell.exe', [path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
    if (pwsh || fallback) profiles.push({ id: 'powershell', label: pwsh ? 'PowerShell 7' : 'Windows PowerShell', environment: 'windows', command: pwsh || fallback,
      // Static initialization only: ConPTY must receive UTF-8, including native CLI output.
      args: ['-NoLogo', ...(process.env.WINMUX_NO_PROFILE === '1' ? ['-NoProfile'] : []), '-NoExit'], cwd: os.homedir() });
    const wsl = await executable('wsl.exe', [path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'wsl.exe')]);
    if (wsl) {
      try {
        const distros = lines(await run(wsl, ['--list', '--quiet']));
        let running = new Set();
        try { running = new Set(lines(await run(wsl, ['--list', '--running', '--quiet']))); }
        catch (error) { console.warn(`WSL running-state discovery unavailable: ${error.message.split('\n')[0]}`); }
        for (const distro of distros) profiles.push({ id: `wsl:${distro}`, label: distro, environment: 'wsl', command: wsl, args: ['--distribution', distro], distro, running: running.has(distro) });
      } catch (error) { console.warn(`WSL discovery unavailable: ${error.message.split('\n')[0]}`); }
    }
  } else {
    profiles.push({ id: 'powershell', label: 'System shell', environment: 'windows', command: process.env.SHELL || '/bin/sh', args: [], cwd: os.homedir() });
  }
  // Discovery only: never run an agent, even with --version. A shell remains the
  // persisted launch profile, so a daemon restart cannot resume arbitrary work.
  const agents = await Promise.all(agentNames.map(async name => {
    const command = await executable(name);
    const entry = AGENTS[name];
    return { id: name, label: entry.label, environment: 'windows', profileId: 'powershell', available: Boolean(command), command, ...(entry.hookAdapter ? { hookAdapter: entry.hookAdapter } : {}) };
  }));
  for (const profile of profiles.filter(p => p.environment === 'wsl')) {
    // Never probe inside a distribution during discovery: `wsl --exec` boots
    // the distro, starts its systemd stack and writes to journal. Agent
    // availability is resolved lazily in selectedAgentForLaunch when the user
    // actually launches a WSL pane or task.
    for (const name of agentNames) agents.push(wslAgent(profile, name, null, null));
  }
  return { profiles, agents, defaultCwd: os.homedir(), platform: process.platform, capabilities: { paneMove: true, terminalTabs: true, liveCwd: true, agentLaunch: true, agentStatus: true, sessionAgentHooks: true, projectAgentHooks: true, nativeCodex: true, ompHooks: true, agentActivity: true, projectTasks: true, protocolVersion: 3 } };
}
async function validateLaunch(environment, profileId, requestedCwd, agentId, agentHooks, hookContext, taskId) {
  const profile = environment.profiles.find(p => p.id === profileId);
  if (!profile) fail('PROFILE_UNAVAILABLE', `Terminal profile is unavailable: ${profileId}`);
  if (agentHooks !== undefined && typeof agentHooks !== 'boolean') fail('INVALID_ARGUMENT', 'agentHooks must be a boolean');
  const selected = await selectedAgentForLaunch(environment, profile, agentId);
  const paneId = randomUUID();
  const agentLaunchId = selected ? randomUUID() : undefined;
  const context = selected && {
    paneId,
    launchId: agentLaunchId,
    dataDir: hookContext?.dataDir,
    pipeName: hookContext?.pipeName,
    ...(taskId === undefined ? {} : { taskId }),
  };
  const prepare = () => selected && withSessionHooks(selected, profile, agentHooks === true && Boolean(selected.hookAdapter), context);
  const ensureProjectHooks = async agent => {
    if (agentHooks !== true || !agent || agent.hookAdapter || profile.environment !== 'windows') return;
    try {
      await installProjectAgentHooks({
        projectRoot: cwd,
        dataDir: hookContext?.dataDir,
        pipeName: hookContext?.pipeName,
        agent: agent.id.split(':').pop(),
        helperRoot: path.join(__dirname, '..', 'hooks'),
      });
    } catch (error) {
      console.warn(`Winmux ${agent.id} status hooks were not installed: ${error.message}`);
    }
  };
  const fields = agent => agent ? {
    agentId: agent.id, agentLabel: agent.label || agent.id, agentLaunchId,
    agentSessionHooks: agent.sessionHooks === true, hookArtifacts: agent.hookArtifacts, cleanupHooks: agent.cleanupHooks,
  } : {};
  const argsFor = (agent, bashAvailable) => {
    try {
      if (agent) agent = { ...agent, args: [...(agent.args || []), ...taskInstructionArgs(agent, taskId)] };
      return shellArgs(profile, agent, bashAvailable);
    }
    catch (error) { agent?.cleanupHooks?.(); throw error; }
  };
  let cwd = requestedCwd;
  if (profile.environment === 'wsl') {
    if (cwd === undefined || cwd === '~') {
      try { cwd = await run(profile.command, [...profile.args, '--exec', 'sh', '-c', 'printf "%s" "$HOME"']); }
      catch (error) { fail('CWD_UNAVAILABLE', `Cannot determine home directory in ${profile.distro}: ${error.message.split('\n')[0]}`); }
    }
    string(cwd, 'cwd', 4096);
    if (!cwd.startsWith('/')) fail('INVALID_CWD', 'WSL requires an absolute Linux directory, for example /home/your-user');
    try { await run(profile.command, [...profile.args, '--exec', 'test', '-d', cwd]); }
    catch { fail('INVALID_CWD', `Directory does not exist or is inaccessible in ${profile.distro}: ${cwd}`); }
    let bashAvailable = true;
    try { await run(profile.command, [...profile.args, '--exec', 'test', '-x', '/bin/bash']); }
    catch { bashAvailable = false; }
    // WSL uses an isolated Bash startup; PowerShell honors the user's own profiles.
    const agent = prepare();
    return { paneId, profile, cwd, ...fields(agent), spawnCwd: os.homedir(), args: [...profile.args, '--cd', cwd, '--exec', ...argsFor(agent, bashAvailable)] };
  }
  cwd ??= profile.cwd || environment.defaultCwd;
  string(cwd, 'cwd', 4096);
  if (!path.isAbsolute(cwd)) fail('INVALID_CWD', 'A terminal startup directory must be an absolute path');
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('not directory'); fs.accessSync(cwd, fs.constants.R_OK); }
  catch { fail('INVALID_CWD', `Directory does not exist or is inaccessible: ${cwd}`); }
  if (agentHooks === true && selected?.hookAdapter) await validateSessionHookShell(profile);
  const agent = prepare();
  await ensureProjectHooks(agent);
  return { paneId, profile, cwd: path.resolve(cwd), ...fields(agent), spawnCwd: path.resolve(cwd), args: argsFor(agent) };
}
module.exports = { discover, validateLaunch, validateSessionHookShell, executable, taskInstructionArgs };
