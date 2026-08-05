import { describe, expect, it } from 'vitest'
import { RUNGS, FLOOR_INDEX, MAX_INDEX, buildGsArgs } from '../../src/main/ladder'

describe('RUNGS', () => {
  it('has 27 rungs indexed 0..26', () => {
    expect(RUNGS).toHaveLength(27)
    RUNGS.forEach((r, i) => expect(r.index).toBe(i))
  })

  it('places the readability floor at 22 and the hard limit at 26', () => {
    expect(FLOOR_INDEX).toBe(22)
    expect(MAX_INDEX).toBe(26)
    expect(RUNGS[MAX_INDEX]!.index).toBe(26)
  })

  it('has a structural-only rung 0 with no image settings', () => {
    expect(RUNGS[0]!.dpi).toBeNull()
    expect(RUNGS[0]!.qFactor).toBeNull()
  })

  it('keeps DPI non-increasing from rung 1 down', () => {
    // Rungs 21 and 22 share the same 72 DPI but differ in QFactor — this is the
    // final quality step before the floor, deliberately fine-grained.
    for (let i = 2; i <= MAX_INDEX; i++) {
      expect(RUNGS[i]!.dpi!).toBeLessThanOrEqual(RUNGS[i - 1]!.dpi!)
    }
  })

  it('limits each DPI step to 12% or less (rungs 2-21), preventing coarse gaps', () => {
    // The whole point of the fine-grained ladder is to prevent 33% gaps between
    // rungs, which cause the search to overshoot and waste the user's size budget.
    // This test guards against that problem creeping back in.
    for (let i = 2; i <= 21; i++) {
      const prevDpi = RUNGS[i - 1]!.dpi!
      const currDpi = RUNGS[i]!.dpi!
      const dropPercent = ((prevDpi - currDpi) / prevDpi) * 100
      expect(dropPercent).toBeLessThanOrEqual(12)
    }
  })

  it('increases QFactor monotonically from rung 1 down (higher = worse)', () => {
    for (let i = 2; i <= MAX_INDEX; i++) {
      expect(RUNGS[i]!.qFactor!).toBeGreaterThan(RUNGS[i - 1]!.qFactor!)
    }
  })

  it('never converts colour to grayscale at any rung', () => {
    // Turning a colour document black and white changes its content, not its
    // quality. An earlier ladder did this from the floor down; it made scanned
    // forms, signatures and charts come back monochrome without being asked.
    const args = (i: number) => buildGsArgs(RUNGS[i]!, '/in.pdf', '/out.pdf')
    for (let i = 0; i <= MAX_INDEX; i++) {
      expect(args(i).join(' ')).not.toContain('ColorConversionStrategy')
      expect(args(i).join(' ')).not.toContain('DeviceGray')
    }
  })

  it('gives every rung a plain-language label', () => {
    RUNGS.forEach((r) => expect(r.label.length).toBeGreaterThan(0))
  })
})

describe('buildGsArgs', () => {
  const args = (i: number) => buildGsArgs(RUNGS[i]!, '/in.pdf', '/out.pdf')

  it('always writes to the output path and reads the input last', () => {
    const a = args(5)
    expect(a).toContain('-sOutputFile=/out.pdf')
    expect(a[a.length - 2]).toBe('-f')
    expect(a[a.length - 1]).toBe('/in.pdf')
  })

  it('always uses the pdfwrite device with batch flags', () => {
    for (const a of [args(0), args(10), args(26)]) {
      expect(a).toContain('-sDEVICE=pdfwrite')
      expect(a).toContain('-dNOPAUSE')
      expect(a).toContain('-dBATCH')
      expect(a).toContain('-dSAFER')
    }
  })

  it('disables all downsampling on rung 0 and passes no distiller params', () => {
    const a = args(0)
    expect(a).toContain('-dDownsampleColorImages=false')
    expect(a).toContain('-dDownsampleGrayImages=false')
    expect(a).toContain('-dDownsampleMonoImages=false')
    expect(a).not.toContain('-c')
  })

  it('forces lossless Flate on rung 0 rather than trusting AutoFilter', () => {
    // pdfwrite's AutoFilter default silently applies lossy JPEG, which would
    // make rung 0's "zero quality loss" promise untrue.
    const a = args(0)
    expect(a).toContain('-dAutoFilterColorImages=false')
    expect(a).toContain('-dColorImageFilter=/FlateEncode')
    expect(a).toContain('-dAutoFilterGrayImages=false')
    expect(a).toContain('-dGrayImageFilter=/FlateEncode')
    expect(a).not.toContain('-dColorImageFilter=/DCTEncode')
  })

  it('lowers the downsample threshold so each rung honours its DPI', () => {
    // Default threshold is 1.5, which leaves a 200 DPI scan untouched by every
    // rung down to 133 DPI and creates a large cliff mid-ladder.
    for (const i of [1, 8, 16, 26]) {
      expect(args(i)).toContain('-dColorImageDownsampleThreshold=1.0')
      expect(args(i)).toContain('-dGrayImageDownsampleThreshold=1.0')
      expect(args(i)).toContain('-dMonoImageDownsampleThreshold=1.0')
    }
  })

  it('sets colour and gray resolution to the rung DPI', () => {
    const a = args(10)
    expect(a).toContain('-dColorImageResolution=150')
    expect(a).toContain('-dGrayImageResolution=150')
  })

  it('keeps mono images at twice the DPI but never below 300', () => {
    expect(args(10)).toContain('-dMonoImageResolution=300')
    expect(args(1)).toContain('-dMonoImageResolution=500')
    expect(args(26)).toContain('-dMonoImageResolution=300')
  })

  it('passes the rung QFactor into all four image dicts with 4:2:0 chroma subsampling', () => {
    const a = args(10)
    const c = a[a.indexOf('-c') + 1]!
    expect(c).toContain('setdistillerparams')
    expect(c.match(/\/QFactor 0\.4\b/g)).toHaveLength(4)
    expect(c.match(/\/HSamples \[2 1 1 1\]/g)).toHaveLength(4)
    expect(c.match(/\/VSamples \[2 1 1 1\]/g)).toHaveLength(4)
    for (const key of ['ColorACSImageDict', 'ColorImageDict', 'GrayACSImageDict', 'GrayImageDict']) {
      expect(c).toContain(key)
    }
  })


  it('never passes -dProcessColorModel, which pdfwrite rejects outright', () => {
    // Ghostscript 10.07 fails with "rangecheck in .putdeviceprops" — this would
    // kill every rung from the readability floor down.
    for (let i = 0; i <= MAX_INDEX; i++) {
      expect(args(i).join(' ')).not.toContain('-dProcessColorModel')
    }
  })

  it('puts -c before -f, which Ghostscript requires', () => {
    const a = args(22)
    expect(a.indexOf('-c')).toBeLessThan(a.indexOf('-f'))
  })
})
