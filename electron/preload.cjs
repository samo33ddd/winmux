const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('winmux', {
  call: (method, params = {}) => ipcRenderer.invoke('winmux:call', method, params),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('winmux:event', listener);
    return () => ipcRenderer.removeListener('winmux:event', listener);
  },
  pickDirectory: () => ipcRenderer.invoke('winmux:directory'),
  openExternal: url => ipcRenderer.invoke('winmux:external', url)
});
