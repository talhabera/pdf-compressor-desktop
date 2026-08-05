import { describe, expect, it, vi } from 'vitest'
import { compress } from '../../src/main/compress'
import { FLOOR_INDEX, MAX_INDEX, RUNGS } from '../../src/main/ladder'
import type { Rung } from '../../src/shared/types'

/** Builds a runner returning sizes from a per-rung table, recording call order. */
function fakeRunner(sizes: Record<number, number>) {
  const calls: number[] = []
  const run = async (rung: Rung) => {
    calls.push(rung.index)
    const bytes = sizes[rung.index]
    if (bytes === undefined) throw new Error(`no size defined for rung ${rung.index}`)
    return { path: `/tmp/rung-${rung.index}.pdf`, bytes }
  }
  return { run, calls }
}

/** A smooth, monotonically shrinking curve: rung 0 = `start`, each rung -`step`. */
function curve(start: number, step: number): Record<number, number> {
  const out: Record<number, number> = {}
  for (let i = 0; i <= MAX_INDEX; i++) out[i] = start - i * step
  return out
}

const base = {
  inputPath: '/tmp/in.pdf',
  allowSqueeze: false,
}

describe('compress', () => {
  it('does no work when the input is already at or under target', async () => {
    const { run, calls } = fakeRunner({})
    const outcome = await compress({
      ...base, inputBytes: 900_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('already-small')
    expect(outcome.outputPath).toBeNull()
    expect(outcome.bytes).toBe(900_000)
    expect(outcome.attempts).toBe(0)
    expect(calls).toEqual([])
  })

  it('returns rung 0 when structural compression alone hits the target', async () => {
    const { run, calls } = fakeRunner({ 0: 1_000_000 })
    const outcome = await compress({
      ...base, inputBytes: 5_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.rungIndex).toBe(0)
    expect(outcome.rungLabel).toBe(RUNGS[0]!.label)
    expect(outcome.bytes).toBe(1_000_000)
    expect(calls).toEqual([0])
  })

  it('picks the highest-quality rung that fits on a monotonic curve', async () => {
    // rung 0 = 10MB, each rung sheds 500k. Rung 5 = 7.5MB, rung 6 = 7.0MB.
    // Target 7.2MB => rung 6 is the highest quality that fits.
    const { run } = fakeRunner(curve(10_000_000, 500_000))
    const outcome = await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.rungIndex).toBe(6)
    expect(outcome.bytes).toBeLessThanOrEqual(7_200_000)
  })

  it('never runs the same rung twice', async () => {
    const { run, calls } = fakeRunner(curve(10_000_000, 500_000))
    await compress({ ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run })
    expect(new Set(calls).size).toBe(calls.length)
  })

  it('probes rung 0 and the floor before binary searching between them', async () => {
    const { run, calls } = fakeRunner(curve(10_000_000, 500_000))
    await compress({ ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run })
    expect(calls[0]).toBe(0)
    expect(calls[1]).toBe(FLOOR_INDEX)
    expect(calls.every((c) => c <= FLOOR_INDEX)).toBe(true)
  })

  it('reports floor-reached and keeps the floor output when the target is unsafe', async () => {
    // Every rung stays above target.
    const { run, calls } = fakeRunner(curve(50_000_000, 100_000))
    const outcome = await compress({
      ...base, inputBytes: 60_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('floor-reached')
    expect(outcome.rungIndex).toBe(FLOOR_INDEX)
    expect(outcome.outputPath).toBe(`/tmp/rung-${FLOOR_INDEX}.pdf`)
    expect(outcome.bytes).toBeGreaterThan(1_750_000)
    expect(calls).toEqual([0, FLOOR_INDEX])
  })

  it('searches only rungs 12-15 when squeeze is allowed', async () => {
    const sizes = curve(50_000_000, 100_000)
    sizes[15] = 1_000_000
    sizes[14] = 1_400_000
    sizes[13] = 1_600_000
    sizes[12] = 2_000_000
    const { run, calls } = fakeRunner(sizes)
    const outcome = await compress({
      ...base, allowSqueeze: true,
      inputBytes: 60_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.rungIndex).toBe(13)
    expect(calls.every((c) => c > FLOOR_INDEX)).toBe(true)
    expect(calls).not.toContain(0)
  })

  it('reports impossible when even rung 15 misses the target', async () => {
    const { run } = fakeRunner(curve(50_000_000, 100_000))
    const outcome = await compress({
      ...base, allowSqueeze: true,
      inputBytes: 60_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('impossible')
    expect(outcome.rungIndex).toBe(MAX_INDEX)
  })

  it('reports a smaller attempt estimate in squeeze mode', async () => {
    // Squeeze searches only four rungs, so reporting the normal-mode estimate
    // of 6 would leave the progress bar apparently stuck below half throughout.
    const onProgress = vi.fn()
    const sizes = curve(50_000_000, 100_000)
    sizes[15] = 1_000_000
    const { run } = fakeRunner(sizes)
    await compress({
      ...base, allowSqueeze: true, inputBytes: 60_000_000,
      targetBytes: 1_750_000, runRung: run, onProgress,
    })
    for (const call of onProgress.mock.calls) {
      expect(call[0].estimatedTotal).toBe(4)
    }
  })

  it('returns a measured under-target file even when the curve is not monotonic', async () => {
    // Pathological: rung 6 is LARGER than rung 5, and rung 3 is tiny.
    const sizes = curve(10_000_000, 400_000)
    sizes[6] = 9_900_000
    sizes[3] = 1_000_000
    sizes[FLOOR_INDEX] = 1_500_000
    const { run } = fakeRunner(sizes)
    const outcome = await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 1_700_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    // The invariant that matters: whatever it returned, it measured it and it fits.
    expect(outcome.bytes).toBeLessThanOrEqual(1_700_000)
    expect(outcome.outputPath).toBe(`/tmp/rung-${outcome.rungIndex}.pdf`)
  })

  it('reports progress twice per rung: once starting, once measured', async () => {
    const onProgress = vi.fn()
    const { run, calls } = fakeRunner(curve(10_000_000, 500_000))
    await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run, onProgress,
    })
    expect(onProgress).toHaveBeenCalledTimes(calls.length * 2)

    const first = onProgress.mock.calls[0]![0]
    expect(first.attempt).toBe(1)
    expect(first.rungIndex).toBe(0)
    expect(first.estimatedTotal).toBeGreaterThan(0)
    expect(first.rungLabel).toBe(RUNGS[0]!.label)
    expect(first.bytes).toBeNull()

    const second = onProgress.mock.calls[1]![0]
    expect(second.attempt).toBe(1)
    expect(second.rungIndex).toBe(0)
    expect(second.bytes).toBe(10_000_000)
  })

  it('never reports a size it did not measure', async () => {
    // Every populated `bytes` must equal what the runner actually returned for
    // that rung. A progress display showing inferred sizes as measurements
    // would be worse than showing none.
    const onProgress = vi.fn()
    const sizes = curve(10_000_000, 500_000)
    const { run } = fakeRunner(sizes)
    await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run, onProgress,
    })
    for (const [event] of onProgress.mock.calls) {
      if (event.bytes !== null) expect(event.bytes).toBe(sizes[event.rungIndex])
    }
  })

  it('correctly handles a spike in the binary search path', async () => {
    // Probe sequence: [0, 11, 5, 8, 9, 10]
    // Spike at rung 8 is on the path and must not be returned even though it's visited.
    // curve(20M, 1M) gives rung 8 = 12M normally, but we spike it to 15M.
    // Neighbors: rung 7 = 13M, rung 9 = 11M, so the spike is clearly visible.
    // With target 9.5M, rung 8's spike (15M) must be rejected, and rung 11 (9M) returned.
    const sizes = curve(20_000_000, 1_000_000)
    sizes[8] = 15_000_000
    const { run, calls } = fakeRunner(sizes)
    const outcome = await compress({
      ...base, inputBytes: 25_000_000, targetBytes: 9_500_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.bytes).toBeLessThanOrEqual(9_500_000)
    expect(outcome.outputPath).toBe(`/tmp/rung-${outcome.rungIndex}.pdf`)
    expect(calls).toEqual([0, FLOOR_INDEX, 5, 8, 9, 10])
  })

  it('propagates runner errors instead of swallowing them', async () => {
    const boom = async () => { throw new Error('ghostscript exploded') }
    await expect(
      compress({ ...base, inputBytes: 12_000_000, targetBytes: 1_000_000, runRung: boom }),
    ).rejects.toThrow('ghostscript exploded')
  })
})
