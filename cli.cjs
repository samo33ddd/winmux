#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { connect } = require('./electron/client.cjs');
const { locations } = require('./electron/backend/shared.cjs');
const { request:desktopRequest } = require('./scripts/browser.cjs');

const HELP = `Winmux — control persistent terminal sessions
Usage: node cli.cjs [--data-dir DIR] [--pipe NAME] COMMAND [arguments]

  start                              Start a detached daemon (Electron runtime)
  list                               List workspaces, panes and notifications as JSON
  environment                        List available Windows/WSL shell profiles
  new [--name NAME] [--cwd DIR] [--profile ID] [--agent ID]
  tab WORKSPACE [--pane PANE] [--cwd DIR] [--profile ID] [--agent ID]
                                     Create a terminal tab in this workspace
  split PANE [horizontal|vertical] [--cwd DIR] [--profile ID] [--agent ID]
  send PANE TEXT [--enter]            Send literal text; --enter submits it
  key PANE KEY                       Enter, Tab, Escape, Backspace, arrows,
                                     Home, End, Delete, PageUp/Down, Ctrl+A..Z
  read PANE [--snapshot]              Read screen text, or serialized VT snapshot JSON
  resize PANE COLS ROWS
  close PANE                         Close a pane and stop its process
  notify [PANE] --title TITLE [--body BODY]
                                     PANE defaults to WINMUX_PANE_ID
  open PATH [--pane ID] [--workspace ID]
                                     Preview a local file inside Winmux
  shutdown                           Stop daemon and ALL its terminal processes
  rpc METHOD [JSON]                   Call any method below; JSON defaults to {}

RPC methods: state, environment, workspace.create, workspace.rename,
workspace.close, tab.create, tab.select, tab.close, pane.split, pane.close, pane.input, pane.resize,
pane.snapshot, pane.screen, layout.ratio, notify, notifications.read,
agent.status, settings.update, daemon.shutdown.

Task delivery RPC: task.delivery.context, task.delivery.refresh,
task.delivery.submit, task.delivery.merge. A task terminal supplies
WINMUX_TASK_ID; otherwise pass taskId in the RPC JSON.

Windows cwd must be an existing absolute Windows path. WSL cwd must be an
existing absolute Linux path and --profile must be wsl:<distribution>.
Closing a CLI/client does not stop terminals. Restart restores fresh shells,
layout and metadata; it never reruns previous commands.
All commands use the local capability token. WINMUX_DATA_DIR and
WINMUX_PIPE_NAME may select a daemon. No commands are retried automatically.
Examples:
  node cli.cjs new --name Work --cwd E:/projects --profile powershell
  node cli.cjs open ./screenshot.png --pane PANE_ID
  node cli.cjs send PANE_ID "Write-Output 'ready'" --enter
  node cli.cjs notify PANE_ID --title "Build finished" --body "Tests passed"
  node cli.cjs rpc workspace.rename '{"workspaceId":"ID","name":"Work"}'
`;
function parse(argv) {
  const options = {}, positionals = [];
  const values = new Set(['data-dir', 'pipe', 'name', 'cwd', 'profile', 'agent', 'title', 'body', 'pane', 'workspace', 'direction']);
  const booleans = new Set(['enter', 'snapshot', 'json', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (value.startsWith('--')) {
      const key = value.slice(2);
      if (booleans.has(key)) options[key] = true;
      else if (values.has(key)) { if (++i >= argv.length) throw new Error(`Missing value for --${key}`); options[key] = argv[i]; }
      else throw new Error(`Unknown option: ${value}; use -- before literal text beginning with --`);
    } else positionals.push(value);
  }
  return { options, positionals };
}
function keySequence(value) {
  if (!value) throw new Error('key requires a key name');
  const key = value.toLowerCase();
  const keys = { enter: '\r', return: '\r', tab: '\t', escape: '\x1b', esc: '\x1b', backspace: '\x7f', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', delete: '\x1b[3~', pageup: '\x1b[5~', pagedown: '\x1b[6~' };
  if (keys[key]) return keys[key];
  const control = /^(?:ctrl[+-]|c-)([a-z])$/.exec(key);
  if (control) return String.fromCharCode(control[1].charCodeAt(0) - 96);
  throw new Error(`Unsupported key: ${value}`);
}
async function start(options) {
  try { const existing = await connect(options); existing.close(); return { ok: true, alreadyRunning: true }; }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOAUTH', 'CONNECTION_CLOSED'].includes(error.code)) throw error; }
  const loc = locations(options); fs.mkdirSync(loc.dataDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(loc.dataDir, 'daemon.log'), 'a', 0o600);
  let electron;
  try { electron = require('electron'); if (typeof electron !== 'string') electron = process.execPath; }
  catch { electron = process.execPath; }
  const child = spawn(electron, [path.join(__dirname, 'electron', 'backend.cjs')], {
    detached: true, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WINMUX_DATA_DIR: loc.dataDir, WINMUX_PIPE_NAME: loc.pipeName }, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  let launchError; child.on('error', error => { launchError = error; }); child.unref();
  for (let i = 0; i < 80; i++) {
    if (launchError) throw launchError;
    try { const client = await connect({ ...options, connectTimeout: 500 }); client.close(); return { ok: true, pid: child.pid }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Daemon did not become ready; inspect ${path.join(loc.dataDir, 'daemon.log')}`);
}
async function main(argv = process.argv.slice(2)) {
  const { options, positionals: args } = parse(argv);
  const command = args.shift();
  if (!command || command === 'help' || options.help || command === '-h') { process.stdout.write(HELP); return; }
  const connection = { dataDir: options['data-dir'], pipeName: options.pipe };
  if (command === 'start') { console.log(JSON.stringify(await start(connection), null, 2)); return; }
  const paneId = options.pane || args[0] || process.env.WINMUX_PANE_ID;
  let method, params = {}, plain = false;
  switch (command) {
    case 'list': method = 'state'; break;
    case 'environment': method = 'environment'; break;
    case 'new': method = 'workspace.create'; params = { name: options.name, cwd: options.cwd, profileId: options.profile, agentId: options.agent }; break;
    case 'tab': method = 'tab.create'; params = { workspaceId: args[0], sourcePaneId: options.pane, cwd: options.cwd, profileId: options.profile, agentId: options.agent, title: options.title }; break;
    case 'split': method = 'pane.split'; params = { paneId, direction: options.direction || args[1] || 'horizontal', cwd: options.cwd, profileId: options.profile, agentId: options.agent }; break;
    case 'send': method = 'pane.input'; if (args.length < 2) throw new Error('send requires PANE and TEXT'); params = { paneId, data: args.slice(1).join(' ') + (options.enter ? '\r' : '') }; break;
    case 'key': method = 'pane.input'; params = { paneId, data: keySequence(args[1]) }; break;
    case 'read': method = options.snapshot ? 'pane.snapshot' : 'pane.screen'; params = { paneId }; plain = !options.snapshot && !options.json; break;
    case 'resize': method = 'pane.resize'; params = { paneId, cols: Number(args[1]), rows: Number(args[2]) }; break;
    case 'close': method = 'pane.close'; params = { paneId }; break;
    case 'notify': method = 'notify'; params = { paneId, title: options.title || args[1], body: options.body || args.slice(2).join(' ') }; break;
    case 'open':
      if (!args[0]) throw new Error('open requires PATH');
      return console.log(JSON.stringify(await desktopRequest('file.open', {
        path:args[0],
        paneId:options.pane || process.env.WINMUX_PANE_ID,
        workspaceId:options.workspace,
      }, { dataDir:connection.dataDir }), null, 2));
    case 'shutdown': method = 'daemon.shutdown'; break;
    case 'rpc': method = args[0]; if (!method) throw new Error('rpc requires METHOD'); params = JSON.parse(args.slice(1).join(' ') || '{}'); if (method.startsWith('task.delivery.') && params && typeof params === 'object' && !Array.isArray(params) && params.taskId === undefined && process.env.WINMUX_TASK_ID) params.taskId = process.env.WINMUX_TASK_ID; break;
    default: throw new Error(`Unknown command: ${command}. Run node cli.cjs help`);
  }
  const client = await connect(connection);
  try { const result = await client.request(method, params); process.stdout.write((plain ? result.text : JSON.stringify(result, null, 2)) + '\n'); }
  finally { client.close(); }
}
module.exports = { main, keySequence };
if (require.main === module) main().catch(error => { console.error(`winmux: ${error.message}${error.code ? ` (${error.code})` : ''}`); process.exitCode = 1; });
