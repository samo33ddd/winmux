require('./stdio.cjs');
const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, shell, clipboard, session } = require('electron');
const { importCookies } = require('./cookie-import.cjs');
const { installSkills } = require('./skills-install.cjs');
const { installAgentHooks } = require('./agent-hooks-install.cjs');
const { appId, registerWindowsIdentity } = require('./windows-identity.cjs');
const { workspaceRequest, workspaceMethods } = require('./workspace.cjs');
const { startBrowserControl } = require('./browser-control.cjs');
const { readFilePreview, previewMetadata } = require('./file-preview.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./client.cjs');

let win;
let client;
let closingAll = false;
let browserControl;
const dataDir = process.env.WINMUX_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'Winmux');
const bundledIcon = app.isPackaged ? path.join(process.resourcesPath,'icon.ico') : path.join(__dirname,'../build/icon.ico');
const iconPath = path.join(dataDir,'icon.ico');
// Portable executables extract resources to a temporary directory. Taskbar and
// Start menu icons must survive after that directory disappears on exit.
fs.mkdirSync(dataDir,{recursive:true});
fs.copyFileSync(bundledIcon,iconPath);
app.setPath('userData', path.join(dataDir, 'ui'));
app.setAppUserModelId(appId);
app.setName('Winmux');
const devUrl = process.env.WINMUX_DEV_URL;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(devUrl)) throw new Error('WINMUX_DEV_URL must be a loopback origin');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(start).catch(async error => {
    await dialog.showMessageBox({type:'error', title:'Winmux — startup error', message:'Could not start terminal sessions.', detail:error.message});
    app.quit();
  });
}

async function ensureDaemon() {
  try { return await connect({dataDir}); } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOAUTH'].includes(error.code) && !/connect|token|ENOENT|ECONNREFUSED/i.test(error.message)) throw error;
  }
  fs.mkdirSync(dataDir, {recursive:true});
  const log = fs.openSync(path.join(dataDir, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'backend.cjs')], {
    detached:true, windowsHide:true, stdio:['ignore',log,log],
    env:{...process.env, ELECTRON_RUN_AS_NODE:'1', WINMUX_DATA_DIR:dataDir}
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  fs.closeSync(log);
  let lastError;
  for (let attempt=0; attempt<100; attempt++) {
    if (spawnError) throw spawnError;
    try { return await connect({dataDir}); } catch(error) { lastError=error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Background process did not respond. Log: ${path.join(dataDir,'daemon.log')}\n${lastError?.message || ''}`);
}

function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}
async function openFilePreview(params) {
  const preview = await readFilePreview({ ...(params || {}), client, dataDir });
  if (win && !win.isDestroyed()) win.webContents.send('winmux:event', { type:'file-preview', ...preview });
  return previewMetadata(preview);
}
const allowedMethods = new Set(['state','environment','project.inspect','task.create','task.open','task.archive','task.delivery.context','task.delivery.refresh','task.delivery.submit','task.delivery.merge','workspace.create','workspace.rename','workspace.close','tab.create','tab.select','tab.close','pane.split','pane.move','pane.close','pane.input','pane.resize','pane.snapshot','pane.screen','agent.status','agent.hook','agent.hooks.install','agent.sessions','agent.bind','codex.status','codex.bind','layout.ratio','notify','notifications.read','settings.update']);
function syncWindowTheme(theme) {
  const colors = {dark:['#101315','#e7eeea'],midnight:['#101523','#e1e9fa'],nord:['#252c38','#eceff4'],dracula:['#20212b','#f8f8f2'],light:['#e9eeeb','#202723'],sand:['#eee8dc','#3a3328']};
  const palette = colors[theme];
  if (!palette) throw new Error('Unknown window theme');
  if (win && !win.isDestroyed()) win.setTitleBarOverlay({color:palette[0],symbolColor:palette[1]});
}

async function start() {
  registerWindowsIdentity({app,shell,iconPath});
  client = await ensureDaemon();
  ipcMain.handle('winmux:window-theme', (event, colors) => {
    trusted(event);
    if (!colors || !/^#[a-f0-9]{6}$/i.test(colors.background) || !/^#[a-f0-9]{6}$/i.test(colors.foreground)) throw new Error('Invalid window colors');
    win.setTitleBarOverlay({color:colors.background,symbolColor:colors.foreground});
  });
  ipcMain.handle('winmux:call', async (event, method, params) => {
    trusted(event);
    if (method === 'cookies.import') return importCookies({dialog,session,win},params?.url);
    if (method === 'skills.install') return installSkills(client,params);
    if (method === 'agent.hooks.install') return installAgentHooks(client, params, { dataDir });
    if (method === 'file.open') return openFilePreview(params);
    if (method === 'theme.export') {
      if (typeof params?.json !== 'string' || params.json.length > 32768) throw new Error('Invalid theme export');
      JSON.parse(params.json);
      const output = await dialog.showSaveDialog(win,{title:'Export theme',defaultPath:'winmux-theme.json',filters:[{name:'Winmux theme',extensions:['json']}]});
      if (output.canceled || !output.filePath) return {canceled:true};
      await fs.promises.writeFile(output.filePath,params.json,'utf8');
      return {saved:true};
    }
    if (workspaceMethods.has(method)) return workspaceRequest(client, method, params || {});
    if (!allowedMethods.has(method)) throw new Error('Unsupported operation');
    return client.request(method, params || {});
  });
  ipcMain.handle('winmux:clipboard-write', (event, text) => {
    trusted(event);
    if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) throw new Error('Invalid clipboard text');
    clipboard.writeText(text);
  });
  ipcMain.handle('winmux:clipboard-read', event => { trusted(event); return clipboard.readText(); });
  ipcMain.handle('winmux:directory', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(win, {title:'Windows project directory',properties:['openDirectory']});
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('winmux:external', async (event, value) => {
    trusted(event);
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol)) throw new Error('Only HTTP(S) links are allowed');
    const answer = await dialog.showMessageBox(win, {type:'question', buttons:['Open','Cancel'],defaultId:1,cancelId:1,message:'Open link in your browser?', detail:url.href});
    if (answer.response===0) await shell.openExternal(url.href);
  });
  client.on('event', event => {

    if (win && !win.isDestroyed()) win.webContents.send('winmux:event', event);
    if (event.type === 'notification' && process.env.WINMUX_TEST_MODE !== '1' && Notification.isSupported() && win && !win.isFocused()) {
      const n = event.notification;
      const notification = new Notification({title:`Winmux · ${n.title}`,body:n.body || 'A terminal needs attention'});
      notification.on('click', () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore(); win.show(); win.focus();
        win.webContents.send('winmux:event',{type:'focus-pane',paneId:n.paneId,workspaceId:n.workspaceId});
      });
      notification.show();
    }
  });
  client.on('error', error => {
    if (win && !win.isDestroyed()) win.webContents.send('winmux:event',{type:'connection-error',message:error.message});
  });
  client.on('close', () => {
    if (!closingAll && win && !win.isDestroyed()) win.webContents.send('winmux:event',{type:'connection-error',message:'Connection to terminal sessions lost. Close and reopen Winmux.'});
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Winmux',submenu:[
      {label:'Close window — keep sessions running',role:'close'},
      {type:'separator'},
      {label:'Stop all sessions and exit…',click:quitAll}
    ]},
    {label:'View',submenu:[{role:'togglefullscreen',label:'Fullscreen'},{role:'toggleDevTools',label:'Developer tools'}]},
    {label:'Help',submenu:[{label:'Keyboard shortcuts',click:() => dialog.showMessageBox(win, {type:'info',message:'Winmux — keyboard shortcuts',detail:'Ctrl+Shift+N — New workspace\nCtrl+T — New terminal tab\nCtrl+Tab / Ctrl+Shift+Tab — Next / previous terminal tab\nCtrl+Shift+D — Split right\nCtrl+Shift+E — Split below\nCtrl+Shift+W — Close pane\nCtrl+Shift+F — Search\nCtrl+Shift+Enter — Zoom pane\nAlt+Arrows — Move focus\nCtrl+Shift+C / V — Copy / paste\nAlt — Show application menu'})}]}
  ]));
  win = new BrowserWindow({
    width:1360,height:880,minWidth:900,minHeight:600,title:'Winmux',backgroundColor:'#101315',autoHideMenuBar:true,show:false,
    icon:iconPath,titleBarStyle:'hidden',
    titleBarOverlay:{color:'#101315',symbolColor:'#e7eeea',height:48},
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,webviewTag:true}
  });
  if (process.platform === 'win32') win.setAppDetails({
    appId, appIconPath:iconPath, appIconIndex:0,
    relaunchCommand:`"${process.env.PORTABLE_EXECUTABLE_FILE || process.execPath}"${app.isPackaged ? '' : ` "${app.getAppPath()}"`}`,
    relaunchDisplayName:'Winmux'
  });
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    let valid=false;
    try { valid=['http:','https:'].includes(new URL(params.src).protocol) && params.partition === 'persist:winmux-browser'; } catch {}
    if (!valid) { event.preventDefault(); return; }
    delete preferences.preload;
    preferences.nodeIntegration=false; preferences.nodeIntegrationInSubFrames=false;
    preferences.contextIsolation=true; preferences.sandbox=true; preferences.webSecurity=true;
    preferences.webviewTag=false; preferences.allowRunningInsecureContent=false;
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({action:'deny'}));
    const guard=(event,url) => { try { if(!['http:','https:'].includes(new URL(url).protocol)) event.preventDefault(); } catch { event.preventDefault(); } };
    guest.on('will-navigate',guard); guest.on('will-redirect',guard);
    guest.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    guest.session.setPermissionCheckHandler(()=>false);
    guest.session.on('will-download',(event)=>event.preventDefault());
  });
  win.webContents.on('will-navigate',(event,url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.once('ready-to-show',() => { if (process.env.WINMUX_TEST_MODE !== '1') win.show(); });
  syncWindowTheme((await client.request('state',{})).settings.theme);
  browserControl = await startBrowserControl({win, client, dataDir, fileOpen:openFilePreview});
  win.on('closed',() => { win=null; });
  win.webContents.on('will-prevent-unload', event => {
    if (closingAll) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(win, { type:'warning', buttons:['Keep editing / Продолжить', 'Discard and close / Закрыть без сохранения'], defaultId:0, cancelId:0, message:'Unsaved file changes / Есть несохранённые изменения файлов' });
    if (choice === 1) event.preventDefault();
  });
  if (devUrl) await win.loadURL(devUrl); else await win.loadFile(path.join(__dirname,'../dist/index.html'));
}

async function quitAll() {
  if (closingAll) return;
  const answer = await dialog.showMessageBox(win, {type:'warning',buttons:['Cancel','Stop all'],defaultId:0,cancelId:0,message:'Stop all terminal sessions?',detail:'Running commands and agents will stop. Unsaved file changes will be discarded. To keep sessions running, close only the window.'});
  if (answer.response!==1) return;
  closingAll=true;
  try { await client.request('daemon.shutdown',{}); app.quit(); }
  catch(error) { closingAll=false; await dialog.showMessageBox(win,{type:'error',message:'Could not stop sessions',detail:error.message}); }
}
app.on('window-all-closed',() => app.quit());
app.on('will-quit',() => { browserControl?.close(); client?.close(); });
