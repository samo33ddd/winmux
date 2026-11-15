const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, shell, clipboard } = require('electron');
const { workspaceRequest, workspaceMethods } = require('./workspace.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./client.cjs');

let win;
let client;
let closingAll = false;
const dataDir = process.env.WINMUX_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'Winmux');
app.setPath('userData', path.join(dataDir, 'ui'));
app.setAppUserModelId('local.winmux.desktop');
const devUrl = process.env.WINMUX_DEV_URL;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(devUrl)) throw new Error('WINMUX_DEV_URL must be a loopback origin');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(start).catch(async error => {
    await dialog.showMessageBox({type:'error', title:'Winmux — ошибка запуска', message:'Не удалось запустить терминальные сессии.', detail:error.message});
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
  throw new Error(`Фоновый процесс не ответил. Журнал: ${path.join(dataDir,'daemon.log')}\n${lastError?.message || ''}`);
}

function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}
const allowedMethods = new Set(['state','environment','workspace.create','workspace.rename','workspace.close','pane.split','pane.close','pane.input','pane.resize','pane.snapshot','pane.screen','layout.ratio','notify','notifications.read','settings.update']);

async function start() {
  client = await ensureDaemon();
  ipcMain.handle('winmux:call', async (event, method, params) => {
    trusted(event);
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
    const result = await dialog.showOpenDialog(win, {title:'Каталог проекта Windows',properties:['openDirectory']});
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('winmux:external', async (event, value) => {
    trusted(event);
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol)) throw new Error('Разрешены только HTTP(S)-ссылки');
    const answer = await dialog.showMessageBox(win, {type:'question', buttons:['Открыть','Отмена'],defaultId:1,cancelId:1,message:'Открыть ссылку в браузере?', detail:url.href});
    if (answer.response===0) await shell.openExternal(url.href);
  });
  client.on('event', event => {
    if (win && !win.isDestroyed()) win.webContents.send('winmux:event', event);
    if (event.type === 'notification' && Notification.isSupported() && win && !win.isFocused()) {
      const n = event.notification;
      const notification = new Notification({title:`Winmux · ${n.title}`,body:n.body || 'Терминал требует внимания'});
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
    if (!closingAll && win && !win.isDestroyed()) win.webContents.send('winmux:event',{type:'connection-error',message:'Соединение с терминальными сессиями потеряно. Закрой и открой Winmux снова.'});
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Winmux',submenu:[
      {label:'Закрыть окно — сессии продолжат работу',role:'close'},
      {type:'separator'},
      {label:'Завершить все сессии и выйти…',click:quitAll}
    ]},
    {label:'Вид',submenu:[{role:'togglefullscreen',label:'Полный экран'},{role:'toggleDevTools',label:'Инструменты разработчика'}]},
    {label:'Справка',submenu:[{label:'Горячие клавиши',click:() => dialog.showMessageBox(win, {type:'info',message:'Winmux — горячие клавиши',detail:'Ctrl+Shift+N — новое пространство\nCtrl+Shift+D — разделить справа\nCtrl+Shift+E — разделить снизу\nCtrl+Shift+W — закрыть панель\nCtrl+Shift+F — поиск\nCtrl+Shift+Enter — развернуть панель\nAlt+стрелки — перейти к другой панели\nCtrl+Shift+C / V — копировать / вставить\nAlt — показать меню приложения'})}]}
  ]));
  win = new BrowserWindow({
    width:1360,height:880,minWidth:900,minHeight:600,title:'Winmux',backgroundColor:'#151719',autoHideMenuBar:true,show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,webviewTag:true}
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
  win.once('ready-to-show',() => win.show());
  win.on('closed',() => { win=null; });
  if (devUrl) await win.loadURL(devUrl); else await win.loadFile(path.join(__dirname,'../dist/index.html'));
}

async function quitAll() {
  if (closingAll) return;
  const answer = await dialog.showMessageBox(win, {type:'warning',buttons:['Отмена','Завершить всё'],defaultId:0,cancelId:0,message:'Остановить все терминалы?',detail:'Работающие команды и агенты будут остановлены. Чтобы сохранить их, просто закрой окно.'});
  if (answer.response!==1) return;
  closingAll=true;
  try { await client.request('daemon.shutdown',{}); app.quit(); }
  catch(error) { closingAll=false; await dialog.showMessageBox(win,{type:'error',message:'Не удалось остановить сессии',detail:error.message}); }
}
app.on('window-all-closed',() => app.quit());
app.on('before-quit',() => { client?.close(); });
