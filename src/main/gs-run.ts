import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Rung } from '@shared/types'
import type { RungResult, RungRunner } from './compress'
import { buildGsArgs } from './ladder'

export class GsError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    /**
     * The originating Node error code when the process could not be started
     * at all — `ENOENT` for a missing binary, `EACCES` for one that isn't
     * executable. Without this, a spawn failure and a user cancellation are
     * indistinguishable downstream (both carry `exitCode: null`), and a broken
     * installation gets reported to the user as "Cancelled."
     */
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'GsError'
  }
}

export function runGs(gsPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GsError('Cancelled before starting.', null, ''))
      return
    }

    const child = spawn(gsPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let cancelled = false

    child.stderr.on('data', (chunk: Buffer) => {
      // Ghostscript is chatty on malformed input; cap what we hold in memory.
      if (stderr.length < 64_000) stderr += chunk.toString()
    })

    const onAbort = () => {
      cancelled = true
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => signal?.removeEventListener('abort', onAbort)

    child.on('error', (err) => {
      cleanup()
      // Carry the Node error code through. `errors.ts` checks it before it
      // checks `exitCode === null`, so this is what distinguishes "Ghostscript
      // is missing" from "the user pressed Cancel".
      reject(new GsError(err.message, null, stderr, (err as NodeJS.ErrnoException).code ?? null))
    })

    child.on('close', (code) => {
      cleanup()
      if (cancelled) reject(new GsError('Cancelled.', null, stderr))
      else if (code === 0) resolve()
      else reject(new GsError(`Ghostscript exited with code ${code}.`, code, stderr))
    })
  })
}

export interface RungRunnerConfig {
  gsPath: string
  inputPath: string
  /** Directory for intermediate files. Caller owns creation and cleanup. */
  workDir: string
  signal?: AbortSignal
}

export function makeRungRunner(cfg: RungRunnerConfig): RungRunner {
  return async (rung: Rung): Promise<RungResult> => {
    const outputPath = join(cfg.workDir, `rung-${rung.index}.pdf`)
    await runGs(cfg.gsPath, buildGsArgs(rung, cfg.inputPath, outputPath), cfg.signal)
    const { size } = await stat(outputPath)
    return { path: outputPath, bytes: size }
  }
}
