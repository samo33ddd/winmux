'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { withSessionHooks } = require('../electron/backend/agent-hooks.cjs');

const executable = process.env.WINMUX_CODEX_EXECUTABLE;

test('installed Codex appends trusted task hook context without replacing user instructions or starting a turn', {
  skip: process.platform !== 'win32' || !executable ? 'Set WINMUX_CODEX_EXECUTABLE to an installed Windows Codex executable' : false,
  timeout: 45000,
}, async t => {
  assert(path.win32.isAbsolute(executable) && executable.endsWith('.exe'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-codex-context-'));
  const dataDir = path.join(root, 'winmux');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(dataDir); fs.mkdirSync(codexHome);
  const taskId = 'task-installed-codex';
  const context = {paneId:'pane-installed', launchId:'launch-installed', dataDir, pipeName:`\\\\.\\pipe\\winmux-codex-context-${crypto.randomBytes(6).toString('hex')}`, taskId};
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'ipc-token'), token);
  const sockets = new Set(), reports = [];
  const pipeServer = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        assert(request.token === token, 'Expected the isolated fixture capability');
        if (request.method === 'state') {
          socket.write(JSON.stringify({id:request.id, result:{workspaces:[], notifications:[], settings:{}}}) + '\n');
          continue;
        }
        assert.equal(request.method, 'agent.status');
        assert.equal(request.params.paneId, context.paneId);
        assert.equal(request.params.launchId, context.launchId);
        assert.deepEqual(Object.keys(request.params).sort(), ['launchId','paneId','state']);
        reports.push(request.params);
        socket.write(JSON.stringify({id:request.id, result:{applied:true}}) + '\n');
      }
    });
  });
  await new Promise(resolve => pipeServer.listen(context.pipeName, resolve));
  let child;
  const captureServer = http.createServer();
  const agent = withSessionHooks({id:'codex', hookAdapter:'codex', command:executable, args:[]}, {environment:'windows'}, true, context);
  t.after(async () => {
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill(), 5000);
        child.once('close', () => {clearTimeout(timer);resolve();});
        child.stdin.end();
      });
    }
    for (const socket of sockets) socket.destroy();
    captureServer.closeAllConnections();
    await Promise.all([new Promise(resolve => pipeServer.close(resolve)), new Promise(resolve => captureServer.close(resolve))]);
    agent.cleanupHooks();
    fs.rmSync(root, {recursive:true, force:true, maxRetries:5, retryDelay:100});
  });
  await new Promise(resolve => captureServer.listen(0, '127.0.0.1', resolve));
  const original = 'PRESERVE_EXISTING_DEVELOPER_INSTRUCTIONS';
  const foreign = 'PRESERVE_EXISTING_SESSION_START_HOOK';
  const foreignScript = path.join(root, 'foreign-hook.ps1');
  fs.writeFileSync(foreignScript, `[Console]::Out.WriteLine('${foreign}')\n`);
  const foreignCommand = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(`& '${foreignScript.replaceAll("'", "''")}'`, 'utf16le').toString('base64');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    `developer_instructions = ${JSON.stringify(original)}`,
    'model = "gpt-5"', 'model_provider = "fixture"',
    '[model_providers.fixture]', 'name = "Local capture fixture"',
    `base_url = "http://127.0.0.1:${captureServer.address().port}/v1"`,
    'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0',
    '[[hooks.SessionStart]]', '[[hooks.SessionStart.hooks]]', 'type = "command"',
    `command = ${JSON.stringify(foreignCommand)}`, `commandWindows = ${JSON.stringify(foreignCommand)}`, '',
  ].join('\n'));

  let requests = 0, buffer = '', sequence = 0;
  const pending = new Map();
  let resolveCapture, rejectCapture;
  const captured = new Promise((resolve, reject) => {resolveCapture=resolve; rejectCapture=reject;});
  captured.catch(() => {});
  captureServer.on('request', (request, response) => {
    let body = '';
    request.on('data', chunk => {body += chunk;});
    request.on('end', () => {
      requests++;
      response.writeHead(500); response.end('Local fixture capture only; no model inference');
      try {resolveCapture(JSON.parse(body));} catch(error) {rejectCapture(error);}
    });
  });
  child = spawn(executable, ['app-server', '--stdio', ...agent.args], {
    cwd:root, env:{...process.env, CODEX_HOME:codexHome, WINMUX_TASK_ID:'stale-task', WINMUX_PANE_ID:'stale-pane'},
    stdio:['pipe','pipe','pipe'], windowsHide:true,
  });
  child.stderr.resume();
  const fail = error => {for(const {reject,timer} of pending.values()){clearTimeout(timer);reject(error);} pending.clear(); rejectCapture(error);};
  child.on('error', fail);
  child.on('exit', code => {if(pending.size)fail(new Error(`Codex fixture exited with ${code}`));});
  child.stdout.on('data', chunk => {
    buffer += chunk; let newline;
    while((newline=buffer.indexOf('\n'))!==-1){
      const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let message;
      try{message=JSON.parse(line);}catch{continue;}
      const waiter=pending.get(message.id);
      if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);if(message.error)waiter.reject(new Error(message.error.message));else waiter.resolve(message.result);}
    }
  });
  const rpc = (method, params) => new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`));},15000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  await rpc('initialize',{clientInfo:{name:'winmux-installed-context-test',version:'1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const inventory=await rpc('hooks/list',{cwds:[root]});
  const hooks=inventory.data.flatMap(entry=>entry.hooks).filter(hook=>hook.eventName==='userPromptSubmit'||hook.eventName==='sessionStart'&&hook.command===foreignCommand);
  assert.equal(hooks.length,2,'user and session hook layers must both remain');
  assert(hooks.every(hook=>hook.trustStatus==='untrusted'),'the application must not bypass hook trust');
  assert.equal(requests,0);
  // Trust only these two test-owned handlers in the disposable Codex home.
  await rpc('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map(hook=>[hook.key,{trusted_hash:hook.currentHash}])),mergeStrategy:'upsert'}],reloadUserConfig:true});
  const config=await rpc('config/read',{cwd:root});
  assert.equal(config.config.developer_instructions,original);
  assert.equal(config.config.model_provider,'fixture');
  const thread=await rpc('thread/start',{cwd:root});
  assert.equal(requests,0,'task instructions must not start an agent turn');
  const turn=rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Explicit local fixture context capture.'}]});
  const request=await captured;
  await turn;
  const input=JSON.stringify(request.input);
  assert(input.includes(taskId));
  assert(input.includes('task.delivery.merge'));
  assert(input.includes(original));
  assert(input.includes(foreign));
  assert((request.input||[]).some(item=>item.role==='developer'&&JSON.stringify(item).includes(taskId)));
  assert(reports.some(report=>report.state==='running'));
  assert.equal(requests,1);
});
