import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('desktop', {
  ping: () => ipcRenderer.invoke('app:ping'),
  load: () => ipcRenderer.invoke('workspace:load'),
  execute: (revision: number, command: unknown) => ipcRenderer.invoke('workspace:execute', revision, command),
})
