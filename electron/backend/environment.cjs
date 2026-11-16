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
const execFileAsync = promisify(execFile); // Argument arrays only; no shell interpolation.
const agentNames = ['claude', 'codex', 'hermes', 'omp', 'pi'];
const wslDiscoveryScript = 'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; for name in claude codex hermes omp pi; do location=$(command -v "$name" 2>/dev/null) || location=; printf "%s\\t%s\\n" "$name" "$location"; done';
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
  return { id: `${profile.id}:${name}`, label: name, environment: 'wsl', profileId: profile.id, distro: profile.distro, available, command, ...(['claude', 'codex'].includes(name) ? { hookAdapter: name } : {}) };
}
async function probeWslAgents(profile) {
  const output = await run(profile.command, [...profile.args, '--exec', 'sh', '-c', wslDiscoveryScript]);
  return new Map(lines(output).map(line => {
    const separator = line.indexOf('\t');
    return separator < 0 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
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
    return { id: name, label: name, environment: 'windows', profileId: 'powershell', available: Boolean(command), command, ...(['claude', 'codex'].includes(name) ? { hookAdapter: name } : {}) };
  }));
  for (const profile of profiles.filter(p => p.environment === 'wsl')) {
    if (!profile.running) {
      for (const name of agentNames) agents.push(wslAgent(profile, name, null, null));
      continue;
    }
    let discovered = new Map();
    try {
      discovered = await probeWslAgents(profile);
    } catch { /* Availability remains false when a distribution cannot be queried. */ }
    for (const name of agentNames) {
      const command = discovered.get(name) || null;
      agents.push(wslAgent(profile, name, Boolean(command), command));
    }
  }
  return { profiles, agents, defaultCwd: os.homedir(), platform: process.platform, capabilities: { terminalTabs: true, liveCwd: true, agentLaunch: true, agentStatus: true, sessionAgentHooks: true, nativeCodex: true, ompHooks: true, agentActivity: true, projectTasks: true, protocolVersion: 3 } };
}
function taskInstructionArgs(agent, taskId) {
  if (!taskId) return [];
  const name = agent?.id?.split(':').pop();
  if (!['claude', 'omp'].includes(name)) return [];
  return ['--append-system-prompt', `This terminal belongs to Winmux task ${taskId}. Follow the repository instructions. When the user's task is complete, use the installed winmux-terminal skill and task.delivery RPCs to create a PR into the primary branch, obtain independent review, resolve findings, wait for required CI on the current PR head, then merge through task.delivery.merge. Never push directly to the primary branch or bypass protection. If the skill, review, CI, or permissions are unavailable, explain the blocker. Do not treat agent completion as task delivery.`];
}
async function validateLaunch(environment, profileId, requestedCwd, agentId, agentHooks, taskId) {
  const profile = environment.profiles.find(p => p.id === profileId);
  if (!profile) fail('PROFILE_UNAVAILABLE', `Terminal profile is unavailable: ${profileId}`);
  if (agentHooks !== undefined && typeof agentHooks !== 'boolean') fail('INVALID_ARGUMENT', 'agentHooks must be a boolean');
  const selected = await selectedAgentForLaunch(environment, profile, agentId);
  const agent = selected && withSessionHooks(selected, profile, agentHooks === true);
  if (agent && taskId) agent.args.push(...taskInstructionArgs(agent, taskId));
  const agentFields = agent ? { agentId: agent.id, agentLabel: agent.label || agent.id, agentLaunchId: randomUUID(), agentSessionHooks: agent.sessionHooks === true } : {};
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
    return { profile, cwd, ...agentFields, spawnCwd: os.homedir(), args: [...profile.args, '--cd', cwd, '--exec', ...shellArgs(profile, agent, bashAvailable)] };
  }
  cwd ??= profile.cwd || environment.defaultCwd;
  string(cwd, 'cwd', 4096);
  if (!path.isAbsolute(cwd)) fail('INVALID_CWD', 'A terminal startup directory must be an absolute path');
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('not directory'); fs.accessSync(cwd, fs.constants.R_OK); }
  catch { fail('INVALID_CWD', `Directory does not exist or is inaccessible: ${cwd}`); }
  return { profile, cwd: path.resolve(cwd), ...agentFields, spawnCwd: path.resolve(cwd), args: shellArgs(profile, agent) };
}
module.exports = { discover, validateLaunch, executable, taskInstructionArgs };
