import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GsError, makeRungRunner, runGs } from '../../src/main/gs-run'
import { RUNGS, FLOOR_INDEX, MAX_INDEX } from '../../src/main/ladder'
import { resolveGhostscriptPath } from '../../src/main/gs-locate'

const GS = resolveGhostscriptPath({
  platform: process.platform,
  isPackaged: false,
  resourcesPath: '',
  projectRoot: process.cwd(),
})
const FIXTURES = join(process.cwd(), 'tests', 'fixtures')
const SCAN = join(FIXTURES, 'scan-heavy.pdf')

let work: string

beforeAll(() => {
  if (!existsSync(GS)) throw new Error(`Run "npm run fetch-gs" first — missing ${GS}`)
  if (!existsSync(SCAN)) throw new Error('Run "npm run fixtures" first')
  work = mkdtempSync(join(tmpdir(), 'gsrun-test-'))
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('runGs', () => {
  it('rejects with a GsError carrying stderr when Ghostscript fails', async () => {
    await expect(runGs(GS, ['-sDEVICE=pdfwrite', '-o', join(work, 'x.pdf'), '-f', '/nope.pdf']))
      .rejects.toBeInstanceOf(GsError)
  })
})

describe('makeRungRunner', () => {
  it('produces a smaller file at a harsher rung', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const gentle = await run(RUNGS[1]!)
    const harsh = await run(RUNGS[11]!)
    expect(harsh.bytes).toBeLessThan(gentle.bytes)
  })

  it('reports the true on-disk size of the file it wrote', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const result = await run(RUNGS[5]!)
    expect(statSync(result.path).size).toBe(result.bytes)
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('writes each rung to its own file', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const a = await run(RUNGS[3]!)
    const b = await run(RUNGS[4]!)
    expect(a.path).not.toBe(b.path)
  })

  it('shrinks the scan fixture well below its original size at the floor', async () => {
    const run = makeRungRunner({ gsPath: GS, inputPath: SCAN, workDir: work })
    const result = await run(RUNGS[11]!)
    expect(result.bytes).toBeLessThan(statSync(SCAN).size / 2)
  })

  it('aborts when the signal fires, with no Node error code', async () => {
    const controller = new AbortController()
    const run = makeRungRunner({
      gsPath: GS, inputPath: SCAN, workDir: work, signal: controller.signal,
    })
    const pending = run(RUNGS[1]!)
    setTimeout(() => controller.abort(), 50)
    // `code: null` is what marks this a genuine cancellation rather than a
    // failure to start, so assert it rather than merely that it rejected.
    await expect(pending).rejects.toMatchObject({ exitCode: null, code: null })
  })

  it('reports a missing binary with its Node error code, not as a cancellation', async () => {
    // A spawn failure and a user cancellation both produce exitCode: null.
    // Without the code, a broken installation is reported to the user as
    // "Cancelled." — which tells them nothing and blames them for it.
    const run = makeRungRunner({
      gsPath: '/nonexistent/path/to/gs', inputPath: SCAN, workDir: work,
    })
    await expect(run(RUNGS[5]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The spec promises text is never rasterized at ANY rung. The one plausible
  // way Ghostscript could break that promise is colour conversion across a
  // transparency group, which can force local flattening of that region.
  it('keeps text selectable without converting to grayscale at harsh rungs', async () => {
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([612, 792])
    // Semi-transparent coloured text: pdf-lib emits an ExtGState with /ca,
    // which is what creates the transparency group.
    page.drawText('TRANSPARENCY_GROUP_SENTINEL', {
      x: 50, y: 700, size: 24, font, color: rgb(0.9, 0.1, 0.1), opacity: 0.5,
    })
    page.drawText('OPAQUE_CONTROL_SENTINEL', {
      x: 50, y: 650, size: 24, font, color: rgb(0, 0, 0),
    })
    const src = join(work, 'transparency.pdf')
    writeFileSync(src, await doc.save())

    const run = makeRungRunner({ gsPath: GS, inputPath: src, workDir: work })
    for (const index of [FLOOR_INDEX, MAX_INDEX]) {
      const result = await run(RUNGS[index]!)
      const text = execFileSync(
        GS,
        ['-sDEVICE=txtwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-o', '-', '-f', result.path],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      )
      expect(text, `rung ${index} lost the transparent text`)
        .toContain('TRANSPARENCY_GROUP_SENTINEL')
      expect(text, `rung ${index} lost the opaque text`)
        .toContain('OPAQUE_CONTROL_SENTINEL')
    }
  })

  it('preserves colour saturation through all rungs, even the harshest', async () => {
    // An earlier ladder converted to grayscale at the floor, making scanned
    // forms, signatures and charts come back black and white. This test catches
    // that regression: build a PDF with saturated colours, compress it at both
    // FLOOR_INDEX and MAX_INDEX, render to PPM, and measure the average colour
    // spread (max(R,G,B) - min(R,G,B)). Saturated red/green/blue stays well
    // above ~20; grayscale measures ~0.1.
    const { PDFDocument, rgb } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 200])

    // Draw saturated color blocks: red, green, blue
    page.drawRectangle({ x: 10, y: 130, width: 50, height: 50, color: rgb(1, 0, 0) })
    page.drawRectangle({ x: 70, y: 130, width: 50, height: 50, color: rgb(0, 1, 0) })
    page.drawRectangle({ x: 130, y: 130, width: 50, height: 50, color: rgb(0, 0, 1) })

    const src = join(work, 'colour-saturation.pdf')
    writeFileSync(src, await doc.save())

    const run = makeRungRunner({ gsPath: GS, inputPath: src, workDir: work })

    for (const index of [FLOOR_INDEX, MAX_INDEX]) {
      const result = await run(RUNGS[index]!)
      const ppmPath = join(work, `colour-${index}.ppm`)

      // Render to PPM at low resolution (6 DPI is enough for the colour blocks)
      execFileSync(GS, [
        '-sDEVICE=ppmraw',
        '-r6',
        '-dNOPAUSE',
        '-dBATCH',
        '-dQUIET',
        `-sOutputFile=${ppmPath}`,
        '-f',
        result.path,
      ])

      // Parse PPM header and pixel data
      const ppmData = execFileSync('file', [ppmPath], { encoding: 'utf8' })
      expect(ppmData).toMatch(/PPM|Netpbm.*image data/)

      // Read raw PPM file and extract RGB values
      const ppmBuffer = execFileSync('tail', ['-c', '+30', ppmPath], { encoding: 'binary' })
      const pixels: number[] = []

      for (let i = 0; i < ppmBuffer.length; i++) {
        pixels.push(ppmBuffer.charCodeAt(i))
      }

      // Calculate average colour spread across pixels
      let totalSpread = 0
      let pixelCount = 0

      for (let i = 0; i + 2 < pixels.length; i += 3) {
        const r = pixels[i]!
        const g = pixels[i + 1]!
        const b = pixels[i + 2]!
        const spread = Math.max(r, g, b) - Math.min(r, g, b)
        totalSpread += spread
        pixelCount++
      }

      const avgSpread = totalSpread / pixelCount
      expect(avgSpread, `rung ${index} converted to grayscale (spread too low)`)
        .toBeGreaterThan(20)
    }
  })
})
