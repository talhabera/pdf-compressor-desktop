import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { compressFile, cleanupWorkDir } from '../../src/main/compress-file'
import { resolveGhostscriptPath } from '../../src/main/gs-locate'
import { FLOOR_INDEX } from '../../src/main/ladder'

const gsPath = resolveGhostscriptPath({
  platform: process.platform, isPackaged: false, resourcesPath: '', projectRoot: process.cwd(),
})
const FIXTURES = join(process.cwd(), 'tests', 'fixtures')
const SCAN = join(FIXTURES, 'scan-heavy.pdf')
const TEXT = join(FIXTURES, 'text-heavy.pdf')
const TINY = join(FIXTURES, 'already-tiny.pdf')

const base = { gsPath, allowSqueeze: false }

beforeAll(() => {
  if (!existsSync(gsPath)) throw new Error('Run "npm run fetch-gs" first')
  if (!existsSync(SCAN)) throw new Error('Run "npm run fixtures" first')
})

describe('compressFile', () => {
  it('hits a 1.75 MB target on a large scan and says so', async () => {
    const res = await compressFile({ ...base, inputPath: SCAN, targetBytes: 1_750_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.status).toBe('hit-target')
    expect(res.outcome.bytes).toBeLessThanOrEqual(1_750_000)
    expect(statSync(res.outcome.outputPath!).size).toBe(res.outcome.bytes)
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('reports already-small without writing anything', async () => {
    const res = await compressFile({ ...base, inputPath: TINY, targetBytes: 1_750_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.status).toBe('already-small')
    expect(res.outcome.outputPath).toBeNull()
    expect(res.outcome.attempts).toBe(0)
  })

  it('stops at the floor and keeps that file when the target is impossible', async () => {
    const res = await compressFile({ ...base, inputPath: SCAN, targetBytes: 20_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.status).toBe('floor-reached')
    expect(res.outcome.rungIndex).toBe(FLOOR_INDEX)
    expect(existsSync(res.outcome.outputPath!)).toBe(true)
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('goes below the floor only when squeeze is allowed', async () => {
    const res = await compressFile({
      ...base, allowSqueeze: true, inputPath: SCAN, targetBytes: 20_000,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.outcome.rungIndex).toBeGreaterThan(FLOOR_INDEX)
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('keeps text selectable in the output', async () => {
    const res = await compressFile({
      ...base, inputPath: TEXT, targetBytes: Math.floor(statSync(TEXT).size * 0.6),
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const txt = execFileSync(
      gsPath,
      ['-sDEVICE=txtwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET',
       '-o', '-', '-f', res.outcome.outputPath!],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    expect(txt).toContain('GHOSTSCRIPT_FIXTURE_SENTINEL')
    await cleanupWorkDir(res.outcome.outputPath!)
  }, 300_000)

  it('returns a failure rather than throwing on a non-PDF', async () => {
    const res = await compressFile({
      ...base, inputPath: join(FIXTURES, 'nope.pdf'), targetBytes: 1_750_000,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.failure.message).toBeTruthy()
  })

  it('reports progress in increasing attempt order', async () => {
    const seen: number[] = []
    await compressFile({
      ...base, inputPath: SCAN, targetBytes: 1_750_000,
      onProgress: (p) => seen.push(p.attempt),
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  }, 300_000)
})
