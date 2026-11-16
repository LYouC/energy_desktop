import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { WorkspaceDatabase } from "./storage";
import { commandSchema } from "../shared/model";

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
