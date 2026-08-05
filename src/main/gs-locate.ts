import { join } from 'node:path'

export interface GsEnv {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** Electron's `process.resourcesPath`. Only used when packaged. */
  resourcesPath: string
  /** Repository root. Only used in development. */
  projectRoot: string
}

export function resolveGhostscriptPath(env: GsEnv): string {
  const isWindows = env.platform === 'win32'
  const binary = isWindows ? 'gswin64c.exe' : 'gs'
  // electron-builder's ${os} macro flattens resources/gs/<os>/ to resources/gs/.
  if (env.isPackaged) return join(env.resourcesPath, 'gs', binary)
  const dir = isWindows ? 'win' : 'mac'
  return join(env.projectRoot, 'resources', 'gs', dir, binary)
}
