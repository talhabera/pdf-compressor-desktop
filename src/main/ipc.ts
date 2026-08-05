import { copyFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
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

/**
 * The path a save dialog is currently open for, if any.
 *
 * A native save dialog can stay open for minutes. Without this, starting a new
 * compression while one is open would delete the very file the user is about to
 * save, and their Save would fail on a file that existed when they clicked.
 */
let savingPath: string | null = null

async function discardPendingOutput(): Promise<void> {
  const path = pendingOutputPath
  if (!path) return
  pendingOutputPath = null
  // Deferred: `file:save` completes the discard once its dialog closes.
  if (path === savingPath) return
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

    // Both writes are guarded by the same check. An aborted run can still
    // resolve `ok: true` — SIGKILL is not synchronous, so a run whose last
    // Ghostscript process already closed successfully settles normally — and
    // whichever handler settles last would otherwise win the write. That would
    // point `pendingOutputPath` at a superseded run, leaving the current run's
    // ~27 MB untracked and never cleaned up.
    const isCurrent = active === controller
    if (isCurrent) {
      active = null
      // Remember what to clean up if the user never saves this result.
      if (response.ok && response.outcome.outputPath) {
        pendingOutputPath = response.outcome.outputPath
      }
    } else if (response.ok && response.outcome.outputPath) {
      // Superseded: nobody will ever save this, so release it now.
      await cleanupWorkDir(response.outcome.outputPath)
    }
    return response
  })

  ipcMain.handle('compress:cancel', () => {
    active?.abort()
    active = null
  })

  ipcMain.handle('file:save', async (event, req: { tempPath: string; suggestedName: string }) => {
    savingPath = req.tempPath
    let saved = false
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = { defaultPath: basename(req.suggestedName) }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return false
      await copyFile(req.tempPath, result.filePath)
      saved = true
      return true
    } catch {
      // The source can legitimately be gone by now. Report a clean failure
      // rather than letting a raw IPC rejection reach the renderer.
      return false
    } finally {
      savingPath = null
      if (saved) {
        if (pendingOutputPath === req.tempPath) pendingOutputPath = null
        await cleanupWorkDir(req.tempPath)
      } else if (pendingOutputPath !== req.tempPath) {
        // A newer run superseded this one while the dialog was open, and
        // `discardPendingOutput` deferred to us. Complete the discard.
        await cleanupWorkDir(req.tempPath)
      }
      // Cancelled but still the pending result: keep it, the user may retry.
    }
  })
}

/**
 * Called on quit so nothing is left behind — neither a running Ghostscript
 * process nor the temp directory of a result the user never saved.
 *
 * This is async and must be awaited. Electron does not hold up quit for a
 * `before-quit` listener unless that listener calls `preventDefault()` and
 * quits again itself, so a fire-and-forget `rm` here is not "slightly delayed"
 * — it usually does not happen at all.
 */
export async function shutdown(): Promise<void> {
  active?.abort()
  active = null
  savingPath = null
  await discardPendingOutput()
}
