import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("desktop", {
  ping: () => ipcRenderer.invoke("app:ping"),
  isWindowMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  controlWindow: (action: string) => ipcRenderer.send("window:control", action),
  onWindowMaximized: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: boolean) =>
      callback(value);
    ipcRenderer.on("window:maximized", listener);
    return () => ipcRenderer.removeListener("window:maximized", listener);
  },
  agentConfig: () => ipcRenderer.invoke("agent:config"),
  agentContext: (sessionId: string) =>
    ipcRenderer.invoke("agent:context", sessionId),
  configureAgent: (input: unknown) =>
    ipcRenderer.invoke("agent:configure", input),
  sendAgent: (input: unknown) => ipcRenderer.invoke("agent:send", input),
  cancelAgent: (runId: string) => ipcRenderer.invoke("agent:cancel", runId),
  onAgentEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
      callback(value);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  load: () => ipcRenderer.invoke("workspace:load"),
  execute: (revision: number, command: unknown) =>
    ipcRenderer.invoke("workspace:execute", revision, command),
});
