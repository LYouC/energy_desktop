import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { WorkspaceDatabase } from "../persistence/storage";
import { commandSchema } from "../domain/model";
import { AgentConfig } from "../agent/config";
import { AgentRuntime } from "../agent/runtime";

const root = path.dirname(fileURLToPath(import.meta.url));
let database: WorkspaceDatabase | undefined;
function getDatabase() {
  database ??= new WorkspaceDatabase(
    path.join(app.getPath("userData"), "workspace.db"),
  );
  return database;
}
if (process.env.XIXU_DATA_DIR) {
  mkdirSync(process.env.XIXU_DATA_DIR, { recursive: true });
  app.setPath("userData", process.env.XIXU_DATA_DIR);
}
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
async function createWindow() {
  const window = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 760,
    minHeight: 640,
    title: "息序",
    backgroundColor: "#FCFBF8",
    webPreferences: {
      preload: path.join(root, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.env.VITE_DEV_SERVER_URL)
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(root, "../dist/index.html"));
}
app.whenReady().then(() => {
  if (!primary) return;
  // 开发凭据由本地进程读取，配置文件不属于打包文件，也不传入模型上下文。
  if (!app.isPackaged) {
    try {
      process.loadEnvFile(path.join(app.getAppPath(), ".env.agent.local"));
    } catch {}
  }
  const agentConfig = new AgentConfig(app.getPath("userData"), safeStorage);
  const runtime = new AgentRuntime(
    {
      load: () => getDatabase().load(),
      execute: (revision, command) => getDatabase().execute(revision, command),
      commitAgentTurn: (revision, sessionId, text, turn, replyId) =>
        getDatabase().commitAgentTurn(revision, sessionId, text, turn, replyId),
    },
    () => agentConfig.connection(),
  );
  ipcMain.handle("agent:config", () => agentConfig.publicView());
  ipcMain.handle("agent:configure", (_event, input: unknown) =>
    agentConfig.save(input),
  );
  ipcMain.handle("agent:send", (event, input: unknown) =>
    runtime.send(input, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send("agent:event", chunk);
    }),
  );
  ipcMain.handle("agent:cancel", (_event, runId: string) =>
    runtime.cancel(runId),
  );
  ipcMain.handle("app:ping", () => "息序桌面已连接");
  ipcMain.handle("workspace:load", () => getDatabase().load());
  ipcMain.handle(
    "workspace:execute",
    (_event, revision: number, command: unknown) => {
      if (!Number.isSafeInteger(revision)) throw new Error("无效的数据版本。");
      return getDatabase().execute(revision, commandSchema.parse(command));
    },
  );
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => database?.close());
