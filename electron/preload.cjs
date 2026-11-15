const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('winmux', {
  call: (method, params = {}) => ipcRenderer.invoke('winmux:call', method, params),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('winmux:event', listener);
    return () => ipcRenderer.removeListener('winmux:event', listener);
  },
  writeClipboard: text => ipcRenderer.invoke('winmux:clipboard-write', text),
  readClipboard: () => ipcRenderer.invoke('winmux:clipboard-read'),
  pickDirectory: () => ipcRenderer.invoke('winmux:directory'),
  openExternal: url => ipcRenderer.invoke('winmux:external', url)
});
