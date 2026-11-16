import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
async function createWindow() {
  const window = new BrowserWindow({
    width: 1380, height: 920, minWidth: 760, minHeight: 640,
    title: '息序', backgroundColor: '#FCFBF8',
    webPreferences: { preload: path.join(root, 'preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(process.env.VITE_DEV_SERVER_URL)
  else await window.loadFile(path.join(root, '../dist/index.html'))
}
app.whenReady().then(() => {
  ipcMain.handle('app:ping', () => '息序桌面已连接')
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
