import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { registerIpc, shutdown } from './ipc'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Electron will not wait for an async `before-quit` listener, so hold the quit
// open, finish cleaning up, then exit for real. Without this the temp directory
// of an unsaved result usually survives the quit.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void shutdown().finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
