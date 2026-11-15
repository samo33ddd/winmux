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
        const distros = (await run(wsl, ['--list', '--quiet'])).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        for (const distro of distros) profiles.push({ id: `wsl:${distro}`, label: distro, environment: 'wsl', command: wsl, args: ['--distribution', distro], distro });
      } catch (error) { console.warn(`WSL discovery unavailable: ${error.message.split('\n')[0]}`); }
    }
  } else {
    profiles.push({ id: 'powershell', label: 'System shell', environment: 'windows', command: process.env.SHELL || '/bin/sh', args: [], cwd: os.homedir() });
  }
  // Discovery only: never run an agent, even with --version. A shell remains the
  // persisted launch profile, so a daemon restart cannot resume arbitrary work.
  const agentNames = ['claude', 'codex', 'hermes', 'omp', 'pi'];
  const agents = await Promise.all(agentNames.map(async name => {
    const command = await executable(name);
    return { id: name, label: name, environment: 'windows', profileId: 'powershell', available: Boolean(command), command, ...(['claude', 'codex'].includes(name) ? { hookAdapter: name } : {}) };
  }));
  for (const profile of profiles.filter(p => p.environment === 'wsl')) {
    let discovered = new Map();
    try {
      const output = await run(profile.command, [...profile.args, '--exec', 'sh', '-c', 'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; for name in claude codex hermes omp pi; do location=$(command -v "$name" 2>/dev/null) || location=; printf "%s\\t%s\\n" "$name" "$location"; done']);
      discovered = new Map(output.split(/\r?\n/).map(line => line.split('\t')));
    } catch { /* Availability remains false when a distribution cannot be queried. */ }
    for (const name of agentNames) agents.push({ id: `${profile.id}:${name}`, label: name, environment: 'wsl', profileId: profile.id, distro: profile.distro, available: Boolean(discovered.get(name)), command: discovered.get(name) || null, ...(['claude', 'codex'].includes(name) ? { hookAdapter: name } : {}) });
  }
  return { profiles, agents, defaultCwd: os.homedir(), platform: process.platform, capabilities: { terminalTabs: true, liveCwd: true, agentLaunch: true, agentStatus: true, sessionAgentHooks: true, nativeCodex: true, protocolVersion: 3 } };
}
async function validateLaunch(environment, profileId, requestedCwd, agentId, agentHooks) {
  const profile = environment.profiles.find(p => p.id === profileId);
  if (!profile) fail('PROFILE_UNAVAILABLE', `Terminal profile is unavailable: ${profileId}`);
  if (agentHooks !== undefined && typeof agentHooks !== 'boolean') fail('INVALID_ARGUMENT', 'agentHooks must be a boolean');
  const selected = selectedAgent(environment, profile, agentId);
  const agent = selected && withSessionHooks(selected, profile, agentHooks === true);
  const agentFields = agent ? { agentId: agent.id, agentLabel: agent.label || agent.id, agentLaunchId: randomUUID() } : {};
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
module.exports = { discover, validateLaunch, executable };
