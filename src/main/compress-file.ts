import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CompressProgress, CompressResponse } from '@shared/types'
import { compress } from './compress'
import { classifyFailure } from './errors'
import { makeRungRunner } from './gs-run'

export interface CompressFileOptions {
  inputPath: string
  targetBytes: number
  allowSqueeze: boolean
  gsPath: string
  signal?: AbortSignal
  onProgress?: (progress: CompressProgress) => void
}

const WORK_PREFIX = 'pdf-compressor-'

export async function compressFile(opts: CompressFileOptions): Promise<CompressResponse> {
  // Reading the input is checked separately from everything else. Both a
  // missing input file and a missing Ghostscript binary raise ENOENT, and
  // `classifyFailure` sees only the code — so without this, a PDF the user
  // moved or renamed would be reported as "Something's wrong with this
  // installation — please reinstall.", sending them to reinstall a working app
  // while the real problem goes untouched.
  let inputBytes: number
  try {
    inputBytes = (await stat(opts.inputPath)).size
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'input-unreadable',
        message: "Couldn't open that file. It may have been moved, renamed, or deleted.",
        details: err instanceof Error ? (err.stack ?? err.message) : String(err),
      },
    }
  }

  let workDir: string | null = null
  try {
    workDir = await mkdtemp(join(tmpdir(), WORK_PREFIX))

    const outcome = await compress({
      inputPath: opts.inputPath,
      inputBytes,
      targetBytes: opts.targetBytes,
      allowSqueeze: opts.allowSqueeze,
      runRung: makeRungRunner({
        gsPath: opts.gsPath,
        inputPath: opts.inputPath,
        workDir,
        signal: opts.signal,
      }),
      onProgress: opts.onProgress,
    })

    // Nothing was produced, so nothing needs keeping.
    if (outcome.outputPath === null) {
      await rm(workDir, { recursive: true, force: true })
    }
    return { ok: true, outcome }
  } catch (err) {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, failure: classifyFailure(err) }
  }
}

/**
 * Removes the temp directory holding a compression result. Call once the user has
 * saved the file or dismissed the result. Refuses paths outside our own temp dirs.
 */
export async function cleanupWorkDir(outputPath: string): Promise<void> {
  const dir = dirname(outputPath)
  if (!dir.startsWith(join(tmpdir(), WORK_PREFIX))) return
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
