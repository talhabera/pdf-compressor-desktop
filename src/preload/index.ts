import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CompressProgress, CompressRequest, RendererApi } from '@shared/types'

const api: RendererApi = {
  pickFile: () => ipcRenderer.invoke('file:pick'),
  statFile: (path) => ipcRenderer.invoke('file:stat', path),
  // Must run here, in the preload. `File.path` no longer exists in the renderer.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  compress: (req: CompressRequest) => ipcRenderer.invoke('compress:start', req),
  cancel: () => ipcRenderer.invoke('compress:cancel'),
  save: (req) => ipcRenderer.invoke('file:save', req),
  onProgress: (cb: (p: CompressProgress) => void) => {
    const listener = (_e: unknown, progress: CompressProgress) => cb(progress)
    ipcRenderer.on('compress:progress', listener)
    return () => { ipcRenderer.off('compress:progress', listener) }
  },
}

contextBridge.exposeInMainWorld('api', api)
