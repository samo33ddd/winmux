'use strict';
const path = require('node:path');

const MAX_NODES = 64;
const MAX_DEPTH = 8;
const SHELLS = new Set([
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'wsl.exe',
  'node.exe', 'python.exe', 'pythonw.exe', 'bun.exe', 'conhost.exe',
]);
const LABELS = { codex: 'Codex', claude: 'Claude', omp: 'OMP', hermes: 'Hermes', pi: 'Pi' };

function windowsPath(value) {
  return String(value || '').replace(/\//g, '\\').replace(/"/g, '').trim();
}
function baseName(value) {
  const normalized = windowsPath(value);
  return normalized ? path.win32.basename(normalized).toLowerCase() : '';
}
function processName(proc) {
  return baseName(proc?.executable) || String(proc?.name || '').toLowerCase();
}
function quotedCommand(proc) {
  return windowsPath(proc?.commandLine).toLowerCase();
}
function argumentParts(commandLine) {
  const parts = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(commandLine || '')))) parts.push(windowsPath(match[1] ?? match[2]));
  return parts;
}
function moduleEntry(parts) {
  const codeFlags = new Set(['-c', '-e', '--eval']);
  let entry = '';
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    const lower = part.toLowerCase();
    if (lower === '-i' || lower === '--isolated' || lower === '--' || lower === '-m') continue;
    if (codeFlags.has(lower)) return '';
    if (lower.startsWith('-')) continue;
    entry = part;
    break;
  }
  return entry;
}
function pathEndsWith(value, suffix) {
  const normalized = windowsPath(value).toLowerCase();
  const expected = windowsPath(suffix).toLowerCase();
  return normalized === expected || normalized.endsWith(`\\${expected}`);
}
function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return path.win32.normalize(windowsPath(value)).toLowerCase();
}
function nativeOmpPath(env = process.env) {
  const root = env.LOCALAPPDATA;
  return typeof root === 'string' && root.trim() ? path.win32.join(root, 'omp', 'omp.exe') : '';
}
function classify(proc, env = process.env) {
  const name = processName(proc);
  const executable = windowsPath(proc?.executable);
  const command = quotedCommand(proc);
  if ((name === 'codex.exe' || name === 'codex') && !/\bapp-server\b/i.test(command)) return 'codex';
  if (name === 'claude.exe' || name === 'claude') return 'claude';
  const nativeOmp = canonicalPath(nativeOmpPath(env));
  if (name === 'omp.exe' && nativeOmp && canonicalPath(executable) === nativeOmp) return 'omp';
  if (name === 'hermes.exe' && pathEndsWith(executable, 'AppData\\Local\\hermes\\bin\\hermes.exe')) return 'hermes';
  if (name === 'pi.exe') return 'pi';

  const parts = argumentParts(proc?.commandLine);
  const runtime = baseName(parts[0] || executable);
  const entry = moduleEntry(parts);
  if (runtime === 'node.exe' || runtime === 'node' || runtime === 'bun.exe' || runtime === 'bun') {
    if (pathEndsWith(entry, '@openai\\codex\\bin\\codex.js') && !/\bapp-server\b/i.test(command)) return 'codex';
    if (pathEndsWith(entry, '@anthropic-ai\\claude-code\\cli.js')) return 'claude';
    if (pathEndsWith(entry, '@mariozechner\\pi-coding-agent\\dist\\cli.js')) return 'pi';
  }
  if ((runtime === 'python.exe' || runtime === 'pythonw.exe' || runtime === 'python') && /^hermes_cli(?:\.main)?$/i.test(entry)) return 'hermes';
  return '';
}
function isWrapper(proc, env) {
  return !classify(proc, env) && SHELLS.has(processName(proc));
}
function identity(proc, agentId) {
  const row = { agentId, label: LABELS[agentId], pid: Number(proc.pid) };
  if (proc?.createdAt) row.generation = proc.createdAt;
  return row;
}
function findPrimaryAgents(rootPid, processes, options = {}) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0 || !Array.isArray(processes)) return [];
  const env = options.env || process.env;
  const children = new Map();
  for (const proc of processes) {
    const pid = Number(proc?.pid);
    const ppid = Number(proc?.ppid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid) || [];
    list.push(proc);
    children.set(ppid, list);
  }
  const found = [];
  const queue = [{ pid: root, depth: 0 }];
  const seen = new Set([root]);
  let walked = 0;
  while (queue.length && walked < MAX_NODES) {
    const current = queue.shift();
    for (const child of children.get(current.pid) || []) {
      const pid = Number(child.pid);
      if (seen.has(pid)) continue;
      seen.add(pid);
      walked += 1;
      const agentId = classify(child, env);
      if (agentId) found.push(identity(child, agentId));
      else if (isWrapper(child, env) && current.depth + 1 < MAX_DEPTH) queue.push({ pid, depth: current.depth + 1 });
      if (walked >= MAX_NODES) break;
    }
  }
  return found;
}

module.exports = { findPrimaryAgents };
