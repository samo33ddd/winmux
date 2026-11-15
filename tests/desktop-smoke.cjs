const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const {request:browserRequest} = require('../scripts/browser.cjs');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(artifacts, 'desktop-test-'));
const env = { ...process.env, WINMUX_DATA_DIR: dataDir, WINMUX_NO_PROFILE: '1', WINMUX_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
// Agent launch is exercised with a local fixture, never a signed-in AI account.
const fixtureBin=path.join(dataDir,'agent-fixture'); fs.mkdirSync(fixtureBin);
fs.writeFileSync(path.join(fixtureBin,'codex.cmd'),'@echo off\r\necho WINMUX_AGENT_FIXTURE_OK\r\n');
// npm installs both a POSIX shim and a Windows shim; discovery must choose the latter.
fs.writeFileSync(path.join(fixtureBin,'codex'),'#!/bin/sh\necho WRONG_POSIX_SHIM\nexit 1\n');
const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path');
const originalPath=env[pathKey] || '';
for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
env.PATH=fixtureBin+path.delimiter+originalPath;
const findings = [];
const errors = [];
let desktop;
let page;
let fixtureServer;
const browser = (method,params) => browserRequest(method,params,{dataDir});
async function closeDesktop() {
  if (!desktop) return;

  let timer;
  try {
    await Promise.race([desktop.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Desktop close exceeded 10 seconds')), 10000);
    })]);
  } finally { clearTimeout(timer); desktop = null; }
}
async function launch() {
  desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
  page = await desktop.firstWindow({ timeout: 30000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.winmux, { timeout: 20000 });
  await page.waitForSelector('#root > *', { timeout: 20000 });
  return page;
}
async function rpc(method, params = {}) {
  return page.evaluate(({method,params}) => window.winmux.call(method, params), {method,params});
}
async function waitScreen(paneId, text) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const screen = await rpc('pane.screen', {paneId});
    if (screen.text.includes(text)) return screen;
    await new Promise(resolve => setTimeout(resolve,150));
  }
  throw new Error(`Terminal did not show ${text}`);
}
async function main() {
  // Start the independent daemon outside Playwright's Windows process tree:
  // its extra fd 3/4 handles otherwise outlive the GUI and delay app.close().
  const start = spawnSync(require('electron'), [path.join(root,'cli.cjs'),'start'], {
    cwd:root, env:{...env,ELECTRON_RUN_AS_NODE:'1'}, encoding:'utf8', timeout:20000
  });
  assert.equal(start.status,0,start.stderr || start.error?.message || start.stdout);
  await launch();
  const environment = await rpc('environment');
  assert(environment.profiles.some(profile => profile.id === 'powershell'));
  await page.screenshot({path:path.join(artifacts,'empty-desktop.png')});
  const workspace = await rpc('workspace.create', {name:'Winmux',cwd:root,profileId:'powershell'});
  const first = workspace.panes[0];
  await rpc('settings.update',{activeWorkspaceId:workspace.id});
  await page.waitForSelector('.xterm', {timeout:15000});
  await rpc('pane.input',{paneId:first.id,data:"Write-Output ('WINMUX_' + 'DESKTOP_OK'); Write-Output 'Привет, Коля — Unicode ✓'\r"});
  await waitScreen(first.id,'WINMUX_DESKTOP_OK');
  await waitScreen(first.id,'Привет, Коля');
  findings.push('Real PowerShell ConPTY output and Unicode displayed through Electron preload/RPC.');
  const second = await rpc('pane.split',{paneId:first.id,direction:'horizontal'});
  await rpc('pane.input',{paneId:second.id,data:"Write-Output ('SPLIT_' + 'OK')\r"});
  await waitScreen(second.id,'SPLIT_OK');
  await page.waitForFunction(() => document.querySelectorAll('.xterm').length >= 2);
  findings.push('Split created two mounted terminal surfaces with independent shell output.');
  const wsl = environment.profiles.find(profile => profile.environment === 'wsl');
  if (wsl) {
    const wslPane = await rpc('pane.split',{paneId:second.id,direction:'vertical',profileId:wsl.id,cwd:'~'});
    await rpc('pane.input',{paneId:wslPane.id,data:"printf 'WSL_%s\\n' 'DESKTOP_OK'; printf 'Linux environment: '; uname -s\r"});
    await waitScreen(wslPane.id,'WSL_DESKTOP_OK');
    findings.push(`Real WSL pane verified: ${wsl.id}.`);
  } else findings.push('WSL not available; WSL verification skipped.');
  await rpc('notify',{paneId:first.id,title:'Проверка завершена',body:'Настоящее событие через локальный API'});
  const state = await rpc('state');
  assert(state.notifications.some(item => item.title === 'Проверка завершена'));
  await page.waitForTimeout(350);
  await page.screenshot({path:path.join(artifacts,'desktop-dark.png')});
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,640));
  await page.waitForTimeout(350);
  await page.screenshot({path:path.join(artifacts,'desktop-compact.png')});
  await rpc('settings.update',{theme:'light',fontSize:15});
  await page.waitForTimeout(350);
  await page.screenshot({path:path.join(artifacts,'desktop-light.png')});
  await rpc('settings.update',{theme:'dark',fontSize:14});
  await closeDesktop();
  await launch();
  const reconnected = await rpc('state');
  const livePane = reconnected.workspaces.flatMap(item=>item.panes).find(item=>item.id===first.id);
  assert.equal(livePane.pid,first.pid,'Closing and reopening UI must preserve shell PID');
  await waitScreen(first.id,'WINMUX_DESKTOP_OK');
  await page.waitForSelector('.xterm');
  await rpc('pane.input',{paneId:first.id,data:"Write-Output ('RECONNECT_' + 'OK')\r"});
  await waitScreen(first.id,'RECONNECT_OK');
  findings.push(`Close/reopen preserved PowerShell PID ${first.pid}, screen and working input.`);
  await page.getByTestId('settings-open').click();
  for (const theme of ['midnight','nord','dracula','sand','light','dark']) {
    await page.getByTestId(`theme-${theme}`).click();
    await page.waitForFunction(id => document.documentElement.dataset.theme === id,theme);
  }
  await page.getByTestId('language-ru').click();
  assert.equal(await page.locator('[role="dialog"] h2').innerText(),'Настройки');
  await page.getByTestId('language-en').click();
  assert.equal(await page.locator('[role="dialog"] h2').innerText(),'Settings');
  await page.screenshot({path:path.join(artifacts,'settings-themes.png')});
  await page.getByTestId('theme-create').click();
  await page.getByTestId('theme-name').fill('Test custom palette');
  await page.getByTestId('theme-save').click();
  const customId=await page.evaluate(()=>document.documentElement.dataset.theme);
  assert(customId.startsWith('custom-'));
  await page.getByTestId('settings-tab-terminal').click();
  await page.getByTestId('font-family').selectOption('Consolas');
  await page.getByTestId('line-height').selectOption('1.3');
  await page.getByTestId('cursor-style').selectOption('underline');
  await page.getByTestId('cursor-blink').click();
  await page.getByTestId('settings-tab-behavior').click();
  await page.getByTestId('copy-on-select').click();
  await page.getByTestId('scrollback').selectOption('5000');
  await page.reload();
  await page.waitForFunction(id=>document.documentElement.dataset.theme===id,customId);
  const preferences=await page.evaluate(()=>JSON.parse(localStorage.getItem('winmux.appearance')));
  assert.equal(preferences.fontFamily,'Consolas');assert.equal(preferences.lineHeight,1.3);
  assert.equal(preferences.cursorStyle,'underline');assert.equal(preferences.cursorBlink,false);
  assert.equal(preferences.copyOnSelect,false);assert.equal(preferences.scrollback,5000);
  assert.equal(preferences.customThemes[0].name,'Test custom palette');
  findings.push('Six themes, English/Russian, custom theme creation and terminal preferences survive renderer reload.');
  await page.getByTestId('settings-open').click();
  const exportedTheme=path.join(dataDir,'exported-theme.json');
  await desktop.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exportedTheme);
  await page.getByTestId('theme-export').click();
  await page.waitForTimeout(150);
  assert.equal(JSON.parse(fs.readFileSync(exportedTheme,'utf8')).theme.name,'Test custom palette');
  await page.getByTestId('theme-file').setInputFiles(exportedTheme);
  await page.getByTestId('theme-save').click();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('winmux.appearance')).customThemes.length),2);
  await page.getByTestId('theme-dark').click();
  await page.keyboard.press('Escape');
  findings.push('Custom theme export writes a real JSON file; importing it creates a separate saved theme.');
  const beforeTabs = await rpc('state');
  const firstTabId = beforeTabs.workspaces.find(item=>item.id===workspace.id).activeTabId;
  assert(firstTabId,'Each workspace has an active terminal tab');
  await page.getByTestId('new-terminal-tab').click();
  await page.waitForFunction(({id,count})=>document.querySelectorAll('[data-testid="terminal-tab"]').length===count && document.querySelector(`[data-testid="workspace-item"][data-workspace-id="${id}"]`),{id:workspace.id,count:2});
  const afterTabs=await rpc('state'), tabWorkspace=afterTabs.workspaces.find(item=>item.id===workspace.id);
  assert.equal(afterTabs.workspaces.length,beforeTabs.workspaces.length,'Adding a terminal tab must not create another workspace');
  assert.equal(tabWorkspace.tabs.length,2);
  const secondTabId=tabWorkspace.activeTabId;
  const secondTabPane=tabWorkspace.panes.find(item=>item.tabId===secondTabId);
  assert(secondTabPane); assert.equal(secondTabPane.cwd,root,'New tab inherits the active terminal directory');
  await rpc('pane.input',{paneId:secondTabPane.id,data:"Write-Output ('TAB_' + 'PRESERVED')\r"});
  await waitScreen(secondTabPane.id,'TAB_PRESERVED');
  await page.locator(`[data-testid="terminal-tab"][data-tab-id="${firstTabId}"]`).click();
  await page.locator(`[data-pane-id="${first.id}"] .xterm-helper-textarea`).focus();
  const beforeSidebar=await page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().width);
  await page.getByTestId('sidebar-resize').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().width),beforeSidebar+20);
  await page.getByTestId('launch-agent').selectOption('codex');
  await page.waitForFunction(()=>document.querySelector('[data-testid="terminal-tab"][aria-selected="true"]')?.textContent?.toLowerCase().includes('codex'));
  const agentState=await rpc('state'), agentWorkspace=agentState.workspaces.find(item=>item.id===workspace.id);
  assert.equal(agentState.workspaces.length,beforeTabs.workspaces.length,'Launching an agent stays in the selected workspace');
  const agentPane=agentWorkspace.panes.find(item=>item.agentId==='codex');
  assert(agentPane); await waitScreen(agentPane.id,'WINMUX_AGENT_FIXTURE_OK');
  await page.locator('[data-testid="agent-metadata"][data-agent-id="codex"][data-agent-state="completed"]').first().waitFor();
  await page.screenshot({path:path.join(artifacts,'terminal-tabs-agent.png')});
  assert.match(environment.agents.find(item=>item.id==='codex').command,/codex\.cmd$/i,'Windows discovery must prefer the executable shim');
  await page.waitForFunction(()=>document.querySelector('[data-testid="workspace-item"]')?.textContent?.toLowerCase().includes('codex'));
  await rpc('tab.close',{workspaceId:workspace.id,tabId:agentPane.tabId});
  await page.locator(`[data-testid="terminal-tab"][data-tab-id="${secondTabId}"]`).click();
  assert.equal((await rpc('state')).workspaces.find(item=>item.id===workspace.id).panes.find(item=>item.id===secondTabPane.id).pid,secondTabPane.pid,'Switching tabs preserves the same shell process');
  await waitScreen(secondTabPane.id,'TAB_PRESERVED');
  await page.reload();
  await page.locator(`[data-testid="terminal-tab"][data-tab-id="${secondTabId}"][aria-selected="true"]`).waitFor();
  await page.locator(`[data-testid="terminal-tab"][data-tab-id="${firstTabId}"]`).click();
  await page.locator(`[data-pane-id="${first.id}"] .xterm-helper-textarea`).focus();
  findings.push('Terminal tabs and agent launch stay inside one workspace; Windows npm shim selection, independent shell PID/output and active-tab restoration survive switching and reload.');
  await page.getByTestId('files-toggle').click();
  const tools=page.locator(`[data-testid="workspace-tools"][data-workspace-id="${workspace.id}"]`);
  const beforeTools=await tools.evaluate(el=>el.getBoundingClientRect().width);
  const resize=await page.getByTestId('tools-resize').boundingBox();
  await page.mouse.move(resize.x+resize.width/2,resize.y+80); await page.mouse.down();
  await page.mouse.move(resize.x-70,resize.y+80,{steps:5}); await page.mouse.up();
  assert((await tools.evaluate(el=>el.getBoundingClientRect().width))>beforeTools+50);
  fs.writeFileSync(path.join(dataDir,'follow-me.txt'),'Current terminal directory fixture');
  await rpc('pane.input',{paneId:first.id,data:`Set-Location -LiteralPath '${dataDir.replace(/'/g,"''")}'\r`});
  await page.locator('[data-testid="file-entry"][data-path="follow-me.txt"]').waitFor();
  await page.locator(`[data-testid="terminal-tab"][data-tab-id="${secondTabId}"]`).click();
  await page.locator('[data-testid="file-entry"][data-path="README.md"]').waitFor();
  assert.equal(await page.locator('[data-testid="file-entry"][data-path="follow-me.txt"]').count(),0,'File tree switches to the selected terminal tab root');
  await page.locator(`[data-testid="terminal-tab"][data-tab-id="${firstTabId}"]`).click();
  await page.locator('[data-testid="file-entry"][data-path="follow-me.txt"]').waitFor();
  await rpc('pane.input',{paneId:first.id,data:`Set-Location -LiteralPath '${root.replace(/'/g,"''")}'\r`});
  findings.push('Sidebar keyboard resize and tools pointer resize work; file root follows cd and switching between terminal tabs without stale entries.');
  await page.locator('[data-testid="file-entry"][data-path="README.md"]').click();
  await page.getByTestId('text-preview').waitFor();
  await page.locator('[data-testid="file-entry"][data-path="build"]').click();
  await page.locator('[data-testid="file-entry"][data-path="build/icon.png"]').click();
  await page.getByTestId('image-preview').waitFor();
  await page.screenshot({path:path.join(artifacts,'project-tools.png')});
  await page.getByTestId('git-toggle').click();
  assert.equal((await rpc('git.status',{workspaceId:workspace.id})).available,true);
  findings.push('File tree opens README text and real application PNG; Git status is available.');
  fixtureServer=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Winmux browser fixture</title><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button><p id="result"></p>');});
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${fixtureServer.address().port}/`;
  const target=await browser('open',{url,workspaceId:workspace.id});
  const snapshot=await browser('snapshot',{id:target.id});assert.equal(snapshot.title,'Winmux browser fixture');
  await browser('fill',{id:target.id,selector:'#name',value:'BROWSER_OK'});
  await browser('click',{id:target.id,selector:'#save'});
  assert.equal(await browser('evaluate',{id:target.id,expression:'document.querySelector("#result").textContent'}),'BROWSER_OK');
  const capture=await browser('screenshot',{id:target.id});assert(fs.statSync(capture.path).size>100);
  const cookieFile=path.join(dataDir,'fixture-cookies.json');
  fs.writeFileSync(cookieFile,JSON.stringify([{name:'winmux_test',value:'fixture-only',domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Lax'}]));
  await desktop.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});},cookieFile);
  const imported=await rpc('cookies.import',{url});assert.equal(imported.imported,1);assert.equal(imported.failed,0);
  const cookieVerified=await desktop.evaluate(async({session},url)=>(await session.fromPartition('persist:winmux-browser').cookies.get({url})).some(c=>c.name==='winmux_test'&&c.value==='fixture-only'&&c.httpOnly),url);
  assert.equal(cookieVerified,true);
  assert.equal(await browser('evaluate',{id:target.id,expression:'document.cookie.includes("winmux_test")'}),false);
  findings.push('Real embedded browser open/snapshot/fill/click/evaluate/screenshot and domain-scoped HttpOnly cookie import verified.');
  await page.getByTestId('browser-tab-add').click();
  assert.equal(await page.getByTestId('browser-tab').count(),2);
  const secondTarget=await browser('open',{url:url+'?second',workspaceId:workspace.id});
  assert.notEqual(secondTarget.id,target.id,'Each browser tab must own a separate guest');
  await browser('fill',{id:secondTarget.id,selector:'#name',value:'SECOND_TAB'});
  await page.getByTestId('browser-tab').first().click();
  assert.equal(await browser('evaluate',{id:target.id,expression:'document.querySelector("#result").textContent'}),'BROWSER_OK');
  const activeTarget=await browser('open',{url:url+'?active',workspaceId:workspace.id});
  assert.equal(activeTarget.id,target.id,'Browser open must target the visible tab');
  await page.getByTestId('browser-tab').nth(1).click();
  assert.equal(await browser('evaluate',{id:secondTarget.id,expression:'document.querySelector("#name").value'}),'SECOND_TAB');
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1360,900));
  await page.waitForTimeout(200);
  await page.screenshot({path:path.join(artifacts,'browser-tabs-desktop.png')});
  await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,640));
  await page.waitForTimeout(200);
  await page.screenshot({path:path.join(artifacts,'browser-tabs-compact.png')});
  await page.getByTestId('browser-tab-close').nth(1).click();
  assert.equal(await page.getByTestId('browser-tab').count(),1);
  findings.push('Two real browser guests retain independent form state; tab switching, closing and CLI targeting verified at 1360x900 and 960x640.');
  await desktop.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(320,360);window.setSize(390,844);});
  await page.waitForTimeout(200);
  await page.screenshot({path:path.join(artifacts,'mobile-stress.png')});
  const narrow=await page.evaluate(()=>({width:innerWidth,contentWidth:document.documentElement.scrollWidth}));
  findings.push(`Unsupported phone-width stress render observed: ${JSON.stringify(narrow)}; production minimum window width remains 900px.`);
  assert.equal(errors.length,0,`Renderer errors: ${errors.join('; ')}`);
  assert.equal(await page.locator('.error-banner').count(),0,'No caught UI errors should remain after tab lifecycle operations');
  findings.push('No uncaught renderer exceptions during verified flows.');
  const report = {status:'passed',dataDir,findings,rendererErrors:errors,screenshots:['empty-desktop.png','desktop-dark.png','desktop-compact.png','desktop-light.png']};
  fs.writeFileSync(path.join(artifacts,'desktop-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{
  console.error(error);
  fs.writeFileSync(path.join(artifacts,'desktop-report.json'),JSON.stringify({status:'failed',error:error.stack,dataDir,findings,rendererErrors:errors},null,2));
  process.exitCode=1;
}).finally(async()=>{
  fixtureServer?.closeAllConnections(); fixtureServer?.close();
  await closeDesktop().catch(error=>console.error('Close failed:',error.message));
  const stop = spawnSync(require('electron'),[path.join(root,'cli.cjs'),'shutdown'],{cwd:root,env:{...env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:15000});
  if(stop.status!==0) console.error('Isolated daemon shutdown:',stop.stderr || stop.error?.message || stop.stdout);
});
