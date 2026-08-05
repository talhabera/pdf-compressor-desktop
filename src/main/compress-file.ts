import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
      // Guarded like the catch-path rm below. Without this, a filesystem
      // hiccup while removing an empty temp dir would turn "your file is
      // already small enough" into "Compression failed on this file."
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
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
  // This deletes a directory recursively, so containment has to be exact.
  // `dir.startsWith(prefix)` is not: `dirname()` does not collapse `..`, so
  // `<tmp>/pdf-compressor-ABC/../../../../Users/me/.ssh/id_rsa` passes a prefix
  // test while resolving somewhere else entirely — and that is where `rm` would
  // operate. Resolve first, then require the parent to be exactly the temp
  // directory and the basename to carry our prefix.
  const dir = resolve(dirname(outputPath))
  if (dirname(dir) !== resolve(tmpdir())) return
  if (!basename(dir).startsWith(WORK_PREFIX)) return
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
