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

/** A smooth, monotonically shrinking geometric curve: rung i = start * ratio^i. */
function curve(start: number, ratio: number): Record<number, number> {
  const out: Record<number, number> = {}
  for (let i = 0; i <= MAX_INDEX; i++) out[i] = Math.round(start * Math.pow(ratio, i))
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
    // Geometric curve with ratio 0.85: each rung is 85% of the previous.
    // Target 7.2MB should land on some higher-quality rung between 0 and floor.
    const { run } = fakeRunner(curve(10_000_000, 0.85))
    const outcome = await compress({
      ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.bytes).toBeLessThanOrEqual(7_200_000)
    expect(outcome.rungIndex).toBeLessThanOrEqual(FLOOR_INDEX)
  })

  it('never runs the same rung twice', async () => {
    const { run, calls } = fakeRunner(curve(10_000_000, 0.85))
    await compress({ ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run })
    expect(new Set(calls).size).toBe(calls.length)
  })

  it('probes rung 0 and the floor before binary searching between them', async () => {
    const { run, calls } = fakeRunner(curve(10_000_000, 0.85))
    await compress({ ...base, inputBytes: 12_000_000, targetBytes: 7_200_000, runRung: run })
    expect(calls[0]).toBe(0)
    expect(calls[1]).toBe(FLOOR_INDEX)
    expect(calls.every((c) => c <= FLOOR_INDEX)).toBe(true)
  })

  it('reports floor-reached and keeps the floor output when the target is unsafe', async () => {
    // Use a curve where even the floor rung is above target.
    const { run, calls } = fakeRunner(curve(50_000_000, 0.90))
    const outcome = await compress({
      ...base, inputBytes: 60_000_000, targetBytes: 500_000, runRung: run,
    })
    expect(outcome.status).toBe('floor-reached')
    expect(outcome.rungIndex).toBe(FLOOR_INDEX)
    expect(outcome.outputPath).toBe(`/tmp/rung-${FLOOR_INDEX}.pdf`)
    expect(outcome.bytes).toBeGreaterThan(500_000)
    expect(calls).toEqual([0, FLOOR_INDEX])
  })

  it('searches only rungs 23-26 when squeeze is allowed', async () => {
    // With expanded ladder (0-26), floor is at 22, so squeeze searches 23-26 (old 12-15).
    const sizes = curve(50_000_000, 0.85)
    sizes[26] = 1_000_000
    sizes[25] = 1_400_000
    sizes[24] = 1_600_000
    sizes[23] = 2_000_000
    const { run, calls } = fakeRunner(sizes)
    const outcome = await compress({
      ...base, allowSqueeze: true,
      inputBytes: 60_000_000, targetBytes: 1_750_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.rungIndex).toBe(24)
    expect(calls.every((c) => c > FLOOR_INDEX)).toBe(true)
    expect(calls).not.toContain(0)
  })

  it('reports impossible when even rung MAX_INDEX misses the target', async () => {
    const { run } = fakeRunner(curve(50_000_000, 0.90))
    const outcome = await compress({
      ...base, allowSqueeze: true,
      inputBytes: 60_000_000, targetBytes: 100_000, runRung: run,
    })
    expect(outcome.status).toBe('impossible')
    expect(outcome.rungIndex).toBe(MAX_INDEX)
  })

  it('reports a smaller attempt estimate in squeeze mode', async () => {
    // Squeeze searches only four rungs, so reporting the normal-mode estimate
    // of 7 would leave the progress bar apparently stuck below half throughout.
    const onProgress = vi.fn()
    const sizes = curve(50_000_000, 0.85)
    sizes[26] = 1_000_000
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
    // Pathological: perturbed rungs to test that search doesn't rely on strict monotonicity.
    const sizes = curve(10_000_000, 0.85)
    sizes[6] = 9_900_000  // Spike larger than neighbors
    sizes[3] = 500_000    // Tiny rung
    sizes[FLOOR_INDEX] = 1_500_000  // Update floor for new ladder position
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
    // Probe sequence with expanded ladder (0-26): [0, 22, 11, 5, 8, 9, 10]
    // Spike at rung 8 is on the path and must not be returned even though it's visited.
    // Geometric curve with ratio 0.80: each rung is 80% of the previous.
    // Spike rung 8 to 15M; it must be rejected in favor of a smaller rung that fits.
    const sizes = curve(20_000_000, 0.80)
    sizes[8] = 15_000_000
    const { run, calls } = fakeRunner(sizes)
    const outcome = await compress({
      ...base, inputBytes: 25_000_000, targetBytes: 9_500_000, runRung: run,
    })
    expect(outcome.status).toBe('hit-target')
    expect(outcome.bytes).toBeLessThanOrEqual(9_500_000)
    expect(outcome.outputPath).toBe(`/tmp/rung-${outcome.rungIndex}.pdf`)
    expect(calls).toEqual([0, FLOOR_INDEX, 11, 5, 8, 9, 10])
  })

  it('propagates runner errors instead of swallowing them', async () => {
    const boom = async () => { throw new Error('ghostscript exploded') }
    await expect(
      compress({ ...base, inputBytes: 12_000_000, targetBytes: 1_000_000, runRung: boom }),
    ).rejects.toThrow('ghostscript exploded')
  })
})
