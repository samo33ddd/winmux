'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VALUE_OPTIONS = new Set(['data-dir', 'pipe', 'name', 'cwd', 'profile', 'agent', 'title', 'body', 'pane', 'workspace', 'direction', 'spec', 'timeout', 'after']);

function fail(message) {
  console.error(`winmux: ${message}`);
  process.exitCode = 1;
}

function isAbsolutePath(value) {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function linuxInteropExecutable(value) {
  const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!drivePath) return value;
  return `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2].replace(/\\/g, '/')}`;
}

function readConnection(scriptDirectory) {
  const file = path.join(scriptDirectory, 'connection.json');
  let value;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('connection metadata is not a regular file');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Installed Winmux connection metadata is unavailable (${file}): ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'cliPath,dataDir'
    || typeof value.dataDir !== 'string' || typeof value.cliPath !== 'string'
    || !isAbsolutePath(value.dataDir) || !isAbsolutePath(value.cliPath)
    || /[\x00-\x1f]/.test(value.dataDir + value.cliPath)) {
    throw new Error('Installed Winmux connection metadata is invalid.');
  }
  return value;
}

function terminalCommand(args) {
  let consumeValue = false;
  for (const value of args) {
    if (consumeValue) {
      consumeValue = false;
      continue;
    }
    if (value === '--') return null;
    if (value.startsWith('--')) {
      consumeValue = VALUE_OPTIONS.has(value.slice(2));
      continue;
    }
    return value;
  }
  return null;
}

function run(kind, scriptDirectory, args = process.argv.slice(2)) {
  const connection = readConnection(scriptDirectory);
  const browserCli = path.win32.isAbsolute(connection.cliPath)
    ? path.win32.join(path.win32.dirname(connection.cliPath), 'scripts', 'browser.cjs')
    : path.join(path.dirname(connection.cliPath), 'scripts', 'browser.cjs');
  if (kind === 'terminal' && terminalCommand(args) === 'start') {
    fail('Open the Winmux desktop to start its backend. The installed client runtime only connects to an existing Winmux instance.');
    return;
  }

  const windowsInterop = process.platform !== 'win32';
  const configuredExecutable = windowsInterop
    ? process.env.WINMUX_WINDOWS_NODE || process.env.WINMUX_AGENT_NODE || 'node.exe'
    : process.execPath;
  const executable = windowsInterop ? linuxInteropExecutable(configuredExecutable) : configuredExecutable;
  const runtime = kind === 'browser' ? browserCli : connection.cliPath;
  const runtimeArgs = kind === 'browser'
    ? [runtime, ...args]
    : [runtime, '--data-dir', connection.dataDir, ...args];
  const env = { ...process.env, WINMUX_DATA_DIR: connection.dataDir };
  if (windowsInterop && /electron(?:\.exe)?$/i.test(configuredExecutable)) env.ELECTRON_RUN_AS_NODE = '1';
  const result = spawnSync(executable, runtimeArgs, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    fail(`${windowsInterop ? 'Windows Node.js is unavailable. Set WINMUX_WINDOWS_NODE or use a Winmux WSL pane' : 'Node.js could not start'}: ${result.error.message}`);
    return;
  }
  if (result.signal) {
    console.error(`winmux: client terminated by ${result.signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

module.exports = { isAbsolutePath, linuxInteropExecutable, readConnection, run, terminalCommand };
