import type { CompressOutcome, CompressProgress, Rung } from '@shared/types'
import { FLOOR_INDEX, MAX_INDEX, RUNGS } from './ladder'

export interface RungResult {
  path: string
  bytes: number
}

export type RungRunner = (rung: Rung) => Promise<RungResult>

export interface CompressOptions {
  inputPath: string
  inputBytes: number
  targetBytes: number
  /** When true, search rungs 12-15 instead of 1-11. */
  allowSqueeze: boolean
  runRung: RungRunner
  onProgress?: (progress: CompressProgress) => void
}

/** Rung 0 + the floor probe + ceil(log2(21)) binary-search steps. */
export const ESTIMATED_ATTEMPTS = 7

/**
 * Squeeze mode probes rung 15 and binary-searches only three rungs [12..14],
 * so it never takes more than four passes. Reporting 6 would leave the progress
 * bar apparently stuck below half for the whole run.
 */
export const ESTIMATED_SQUEEZE_ATTEMPTS = 4

export async function compress(opts: CompressOptions): Promise<CompressOutcome> {
  const { targetBytes, allowSqueeze, runRung, onProgress } = opts

  // Cache results per rung to prevent re-execution. Today the three search phases
  // (rung 0, floor, binary search) are disjoint by construction, but this guard
  // protects against future ladder-bound changes.
  const measured = new Map<number, RungResult>()
  let attempts = 0

  const run = async (index: number): Promise<RungResult> => {
    const cached = measured.get(index)
    if (cached) return cached

    const rung = RUNGS[index]!
    attempts++
    // Each attempt reports twice: once on start so the UI can say what is
    // being tried during a pass that may take several seconds, and once on
    // completion carrying the measured size. The completion event is the only
    // place an intermediate attempt's real size is ever available.
    const event = {
      attempt: attempts,
      estimatedTotal: allowSqueeze ? ESTIMATED_SQUEEZE_ATTEMPTS : ESTIMATED_ATTEMPTS,
      rungIndex: index,
      rungLabel: rung.label,
      dpi: rung.dpi,
    }
    onProgress?.({ ...event, bytes: null })
    const result = await runRung(rung)
    measured.set(index, result)
    onProgress?.({ ...event, bytes: result.bytes })
    return result
  }

  const done = (
    status: CompressOutcome['status'],
    index: number,
    result: RungResult,
  ): CompressOutcome => ({
    status,
    outputPath: result.path,
    bytes: result.bytes,
    rungIndex: index,
    rungLabel: RUNGS[index]!.label,
    attempts,
  })

  if (!allowSqueeze) {
    if (opts.inputBytes <= targetBytes) {
      return {
        status: 'already-small',
        outputPath: null,
        bytes: opts.inputBytes,
        rungIndex: null,
        rungLabel: null,
        attempts: 0,
      }
    }

    // Structural pass first: if it fits, the target costs no quality at all.
    const structural = await run(0)
    if (structural.bytes <= targetBytes) return done('hit-target', 0, structural)
  }

  const lowest = allowSqueeze ? FLOOR_INDEX + 1 : 1
  const harshest = allowSqueeze ? MAX_INDEX : FLOOR_INDEX

  // If the harshest permitted rung still misses, nothing between it and rung 0 can fit.
  const harshestResult = await run(harshest)
  if (harshestResult.bytes > targetBytes) {
    return done(allowSqueeze ? 'impossible' : 'floor-reached', harshest, harshestResult)
  }

  // Binary search for the lowest index (= highest quality) that fits. `best` only
  // ever holds a rung whose output size was measured at or under target, so the
  // result stays correct even if the ladder is not perfectly monotonic.
  let bestIndex = harshest
  let best = harshestResult
  let low = lowest
  let high = harshest - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const result = await run(mid)
    if (result.bytes <= targetBytes) {
      bestIndex = mid
      best = result
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return done('hit-target', bestIndex, best)
}
