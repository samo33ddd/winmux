#!/usr/bin/env node
'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function request(method, params = {}, options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.WINMUX_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Winmux'));
  let endpoint;
  try { endpoint = JSON.parse(await fs.readFile(path.join(dataDir, 'ui-control.json'), 'utf8')); }
  catch { throw new Error('Open the Winmux desktop first; its authenticated UI service is unavailable.'); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint.pipe);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Browser request timed out; inspect the page before retrying a mutation.')); }, 22000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({token:endpoint.token,method,params})+'\n'));
    socket.on('error', reject);
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); reject(new Error('Browser response exceeds 4 MB')); return; }
      const newline = buffer.indexOf('\n'); if (newline < 0) return;
      try { const message = JSON.parse(buffer.slice(0,newline)); if (message.error) reject(new Error(message.error)); else resolve(message.result); }
      catch(error) { reject(error); }
      socket.destroy();
    });
    socket.on('close', () => { clearTimeout(timer); reject(new Error('Browser connection closed before a response')); });
  });
}
async function main() {
  const [method, ...args] = process.argv.slice(2);
  if (!method || method === '--help' || method === 'help') {
    console.log(`Winmux browser — controls the desktop's real embedded pages
Usage: node scripts/browser.cjs METHOD [JSON]
  file.open  {"path":"./screenshot.png","paneId":"..."}
  open       {"url":"http://localhost:3000","workspaceId":"..."}
  list       {}
  snapshot   {"id":123}
  click      {"id":123,"ref":"e0"} or {"id":123,"selector":"#save"}
  fill       {"id":123,"ref":"e1","value":"Hello"}
  evaluate   {"id":123,"expression":"document.title"}
  screenshot {"id":123}
  captures.list
  captures.clear {"confirm":true}
Use browser ids returned by open/list. Re-snapshot after navigation.
WINMUX_DATA_DIR selects the same isolated instance as the terminal CLI.
Requires an open desktop; actions are never automatically retried.`);
    return;
  }
  console.log(JSON.stringify(await request(method, JSON.parse(args.join(' ') || '{}')), null, 2));
}
module.exports = { request };
if (require.main === module) main().catch(error => { console.error(`winmux browser: ${error.message}`); process.exitCode = 1; });
