'use strict';
const fs = require('node:fs');
const path = require('node:path');
const appId = 'io.github.samo33ddd.winmux';

function registerWindowsIdentity({app, shell, iconPath}) {
  if (process.platform !== 'win32' || process.env.WINMUX_TEST_MODE === '1') return;
  const directory=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs');
  fs.mkdirSync(directory,{recursive:true});
  const shortcut=path.join(directory,'Winmux.lnk');
  const target=process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const details={target,cwd:path.dirname(target),args:app.isPackaged?'':`"${app.getAppPath()}"`,description:'Winmux',icon:iconPath,iconIndex:0,appUserModelId:appId};
  if(!shell.writeShortcutLink(shortcut,fs.existsSync(shortcut)?'update':'create',details)) throw new Error('Could not register the Winmux shortcut');
  const saved=shell.readShortcutLink(shortcut);
  if(saved.appUserModelId!==appId || path.resolve(saved.target)!==path.resolve(target) || path.resolve(saved.icon)!==path.resolve(iconPath)) throw new Error('Winmux shortcut verification failed');
  // Electron notifications may have registered this application's ID against
  // the development executable. Remove only that exact stale association.
  const legacy=path.join(directory,'Electron.lnk');
  if(fs.existsSync(legacy)) {
    const old=shell.readShortcutLink(legacy);
    if([appId,'local.winmux.desktop'].includes(old.appUserModelId) && path.basename(old.target).toLowerCase()==='electron.exe') fs.unlinkSync(legacy);
  }
  return shortcut;
}
module.exports={appId,registerWindowsIdentity};
