import { copyFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { CompressRequest, CompressResponse, PickedFile } from '@shared/types'
import { cleanupWorkDir, compressFile } from './compress-file'
import { resolveGhostscriptPath } from './gs-locate'

let active: AbortController | null = null

/**
 * Output path of the most recent successful run, whose temp directory is still
 * on disk because the user may yet save it.
 *
 * `compressFile` deliberately keeps that directory — the caller needs the file.
 * But a run the user never saves would otherwise leak it, and each one holds
 * every rung's output: roughly 27 MB for a 13.5 MB input. Someone compressing a
 * few documents a week and saving only some of them would quietly accumulate
 * hundreds of megabytes in a directory they will never think to look in.
 *
 * So the previous run's directory is removed when a new run starts, and any
 * outstanding one is removed on quit.
 */
let pendingOutputPath: string | null = null

async function discardPendingOutput(): Promise<void> {
  if (!pendingOutputPath) return
  const path = pendingOutputPath
  pendingOutputPath = null
  await cleanupWorkDir(path)
}

/** Electron-aware wrapper around the pure resolver in gs-locate.ts. */
function ghostscriptPath(): string {
  return resolveGhostscriptPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    // out/main/ipc.js -> out/main -> out -> project root
    projectRoot: join(import.meta.dirname, '..', '..'),
  })
}

async function statFile(path: string): Promise<PickedFile | null> {
  try {
    const { size } = await stat(path)
    return { path, bytes: size }
  } catch {
    return null
  }
}

export function registerIpc(): void {
  ipcMain.handle('file:pick', async (): Promise<PickedFile | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    const picked = result.filePaths[0]
    return result.canceled || !picked ? null : statFile(picked)
  })

  ipcMain.handle('file:stat', (_e, path: string) => statFile(path))

  ipcMain.handle('compress:start', async (event, req: CompressRequest): Promise<CompressResponse> => {
    active?.abort()
    // Whatever the last run produced is now superseded, saved or not.
    await discardPendingOutput()
    const controller = new AbortController()
    active = controller

    const response = await compressFile({
      inputPath: req.inputPath,
      targetBytes: req.targetBytes,
      allowSqueeze: req.allowSqueeze,
      gsPath: ghostscriptPath(),
      signal: controller.signal,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('compress:progress', progress)
      },
    })

    if (active === controller) active = null
    // Remember what to clean up if the user never saves this result.
    if (response.ok && response.outcome.outputPath) {
      pendingOutputPath = response.outcome.outputPath
    }
    return response
  })

  ipcMain.handle('compress:cancel', () => {
    active?.abort()
    active = null
  })

  ipcMain.handle('file:save', async (event, req: { tempPath: string; suggestedName: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath: req.suggestedName })
      : await dialog.showSaveDialog({ defaultPath: req.suggestedName })
    if (result.canceled || !result.filePath) return false
    await copyFile(req.tempPath, result.filePath)
    await cleanupWorkDir(req.tempPath)
    if (pendingOutputPath === req.tempPath) pendingOutputPath = null
    return true
  })
}

/**
 * Called on quit so a killed run leaves nothing behind — neither a running
 * Ghostscript process nor the temp directory of a result the user never saved.
 */
export function abortActiveCompression(): void {
  active?.abort()
  active = null
  // Fire-and-forget: `before-quit` will not await us, and leaving the directory
  // is a worse outcome than a slightly delayed deletion.
  void discardPendingOutput()
}
