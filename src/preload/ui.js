// Bridge for the privileged browser UI only (ADR 0008).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('veilUI', {
  invoke: (cmd, ...args) => ipcRenderer.invoke('veil:ui', cmd, ...args),
  onState: cb => ipcRenderer.on('veil:state', (e, state) => cb(state)),
  onFocusAddress: cb => ipcRenderer.on('veil:focus-address', () => cb()),
  onFocusFind: cb => ipcRenderer.on('veil:focus-find', () => cb()),
  onFindStep: cb => ipcRenderer.on('veil:find-step', (e, forward) => cb(forward)),
})
