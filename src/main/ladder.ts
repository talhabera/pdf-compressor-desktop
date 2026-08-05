import type { Rung } from '@shared/types'

/** Index of the readability floor. Rungs below this need explicit user consent. */
export const FLOOR_INDEX = 22
/** Index of the harshest rung the app will ever apply. */
export const MAX_INDEX = 26

const HIGH = 'high quality'
const REDUCED = 'reduced image quality'
const HEAVY = 'heavily compressed'
const EXTREME = 'extremely compressed'

/**
 * The steps are deliberately fine — 12-19% apart in output size rather than the
 * ~33% of an earlier, coarser table. Step size is quality the user paid for and
 * did not receive: the search returns the largest result that still fits, so a
 * coarse ladder overshoots downward. Measured on a 23.8 MB 300 DPI colour scan
 * at a 1.75 MB target, the coarse table returned 1,363,051 bytes (78% of the
 * budget, 150 DPI) where this one returns 1,645,323 (94%, 166 DPI) — same
 * target, visibly sharper images.
 *
 * Sizes below are from that fixture and are indicative, not guarantees; every
 * rung is measured at run time.
 */
export const RUNGS: readonly Rung[] = [
  { index: 0, dpi: null, qFactor: null, label: 'original quality' },
  { index: 1, dpi: 250, qFactor: 0.15, label: HIGH },
  { index: 2, dpi: 235, qFactor: 0.17, label: HIGH },
  { index: 3, dpi: 220, qFactor: 0.2, label: HIGH },
  { index: 4, dpi: 205, qFactor: 0.22, label: HIGH },
  { index: 5, dpi: 195, qFactor: 0.25, label: HIGH },
  { index: 6, dpi: 185, qFactor: 0.28, label: HIGH },
  { index: 7, dpi: 175, qFactor: 0.31, label: HIGH },
  { index: 8, dpi: 166, qFactor: 0.34, label: HIGH },
  { index: 9, dpi: 158, qFactor: 0.37, label: REDUCED },
  { index: 10, dpi: 150, qFactor: 0.4, label: REDUCED },
  { index: 11, dpi: 142, qFactor: 0.44, label: REDUCED },
  { index: 12, dpi: 134, qFactor: 0.48, label: REDUCED },
  { index: 13, dpi: 126, qFactor: 0.53, label: REDUCED },
  { index: 14, dpi: 118, qFactor: 0.58, label: REDUCED },
  { index: 15, dpi: 110, qFactor: 0.65, label: REDUCED },
  { index: 16, dpi: 102, qFactor: 0.72, label: HEAVY },
  { index: 17, dpi: 95, qFactor: 0.8, label: HEAVY },
  { index: 18, dpi: 88, qFactor: 0.9, label: HEAVY },
  { index: 19, dpi: 82, qFactor: 1.0, label: HEAVY },
  { index: 20, dpi: 76, qFactor: 1.15, label: HEAVY },
  { index: 21, dpi: 72, qFactor: 1.4, label: HEAVY },
  { index: 22, dpi: 72, qFactor: 2.0, label: HEAVY },
  { index: 23, dpi: 60, qFactor: 2.4, label: EXTREME },
  { index: 24, dpi: 50, qFactor: 3.0, label: EXTREME },
  { index: 25, dpi: 40, qFactor: 3.5, label: EXTREME },
  { index: 26, dpi: 30, qFactor: 4.0, label: EXTREME },
]

const BASE_ARGS = [
  '-sDEVICE=pdfwrite',
  '-dCompatibilityLevel=1.7',
  '-dNOPAUSE',
  '-dBATCH',
  '-dSAFER',
  '-dQUIET',
  '-dAutoRotatePages=/None',
  '-dDetectDuplicateImages=true',
  '-dCompressFonts=true',
  '-dSubsetFonts=true',
  '-dEmbedAllFonts=true',
]

/**
 * Rungs at and below this index subsample chroma 4:2:0 — colour stored at half
 * resolution, brightness untouched.
 *
 * This is NOT free, despite an earlier claim in this file that it was. That
 * claim came from measuring against smooth colour, which cannot show the
 * damage. Measured properly against a page with saturated *fine* detail — 2px
 * red stamp strokes, 1px blue rules — at rung 10:
 *
 *   4:4:4   533,412 bytes   mean error on saturated pixels 22.60
 *   4:2:0   364,638 bytes   mean error on saturated pixels 33.72
 *
 * 32% smaller for 49% more colour error, concentrated exactly on the content a
 * document compressor exists to protect: stamps, highlighter, signatures,
 * coloured rules, charts. So it is applied only from the rung where the label
 * already tells the user quality has been reduced. Rungs 1-8 are labelled
 * "high quality" and keep full chroma, because that label is a promise.
 */
const CHROMA_SUBSAMPLE_FROM = 9

function distillerParams(qFactor: number, subsampleChroma: boolean): string {
  const s = subsampleChroma ? '[2 1 1 1]' : '[1 1 1 1]'
  const dict = `<</QFactor ${qFactor} /Blend 1 /HSamples ${s} /VSamples ${s}>>`
  return (
    `<</ColorACSImageDict ${dict} /ColorImageDict ${dict}` +
    ` /GrayACSImageDict ${dict} /GrayImageDict ${dict}>> setdistillerparams`
  )
}

export function buildGsArgs(rung: Rung, inputPath: string, outputPath: string): string[] {
  if (rung.dpi === null || rung.qFactor === null) {
    // pdfwrite defaults to AutoFilter, which silently re-encodes images as
    // lossy JPEG. Forcing FlateEncode is what actually makes this the
    // zero-quality-loss rung the spec promises. Measured: without these four
    // flags rung 0 shrank a 13.5 MB fixture to 2.1 MB by discarding image
    // data while claiming not to; with them it produces 13.1 MB.
    return [
      ...BASE_ARGS,
      '-dDownsampleColorImages=false',
      '-dDownsampleGrayImages=false',
      '-dDownsampleMonoImages=false',
      '-dAutoFilterColorImages=false',
      '-dColorImageFilter=/FlateEncode',
      '-dAutoFilterGrayImages=false',
      '-dGrayImageFilter=/FlateEncode',
      `-sOutputFile=${outputPath}`,
      '-f',
      inputPath,
    ]
  }

  // Scanned text is often 1-bit and degrades badly below 300 DPI, so mono
  // images are downsampled far more gently than colour and gray.
  const monoDpi = Math.max(rung.dpi * 2, 300)

  return [
    ...BASE_ARGS,
    // Ghostscript only downsamples when source/target DPI exceeds this
    // threshold, which defaults to 1.5. At the default, a 200 DPI scan is
    // untouched by every rung down to 133 DPI, so the upper ladder varied only
    // JPEG quality and produced a 4.4x size cliff between rungs 5 and 6.
    // Setting 1.0 makes each rung actually do what its DPI says: measured,
    // rung 5 went from 3.89 MB to 1.53 MB on the same input.
    '-dColorImageDownsampleThreshold=1.0',
    '-dGrayImageDownsampleThreshold=1.0',
    '-dMonoImageDownsampleThreshold=1.0',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${rung.dpi}`,
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${rung.dpi}`,
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Subsample',
    `-dMonoImageResolution=${monoDpi}`,
    '-dAutoFilterColorImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dAutoFilterGrayImages=false',
    '-dGrayImageFilter=/DCTEncode',
    // No colour conversion at any rung. Turning a colour document black and
    // white is a change to its content, not a reduction in quality, and the
    // app must never make that decision on the user's behalf. (Also note
    // -dProcessColorModel=/DeviceGray must never be added here: it is a
    // raster-device parameter and pdfwrite rejects it outright with
    // "rangecheck in .putdeviceprops".)
    `-sOutputFile=${outputPath}`,
    '-c',
    distillerParams(rung.qFactor, rung.index >= CHROMA_SUBSAMPLE_FROM),
    '-f',
    inputPath,
  ]
}
