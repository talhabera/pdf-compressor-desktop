import type { Rung } from '@shared/types'

/** Index of the readability floor. Rungs below this need explicit user consent. */
export const FLOOR_INDEX = 11
/** Index of the harshest rung the app will ever apply. */
export const MAX_INDEX = 15

const HIGH = 'high quality'
const REDUCED = 'reduced image quality'
const HEAVY = 'heavily compressed'
const EXTREME = 'extremely compressed'

export const RUNGS: readonly Rung[] = [
  { index: 0, dpi: null, qFactor: null, label: 'original quality' },
  { index: 1, dpi: 250, qFactor: 0.15, label: HIGH },
  { index: 2, dpi: 220, qFactor: 0.2, label: HIGH },
  { index: 3, dpi: 200, qFactor: 0.25, label: HIGH },
  { index: 4, dpi: 180, qFactor: 0.3, label: HIGH },
  { index: 5, dpi: 150, qFactor: 0.4, label: REDUCED },
  { index: 6, dpi: 130, qFactor: 0.5, label: REDUCED },
  { index: 7, dpi: 110, qFactor: 0.65, label: REDUCED },
  { index: 8, dpi: 100, qFactor: 0.8, label: REDUCED },
  { index: 9, dpi: 90, qFactor: 1.0, label: HEAVY },
  { index: 10, dpi: 80, qFactor: 1.3, label: HEAVY },
  { index: 11, dpi: 72, qFactor: 2.0, label: HEAVY },
  { index: 12, dpi: 60, qFactor: 2.4, label: EXTREME },
  { index: 13, dpi: 50, qFactor: 3.0, label: EXTREME },
  { index: 14, dpi: 40, qFactor: 3.5, label: EXTREME },
  { index: 15, dpi: 30, qFactor: 4.0, label: EXTREME },
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

function distillerParams(qFactor: number): string {
  // HSamples/VSamples [2 1 1 1] is 4:2:0 chroma subsampling: colour is stored
  // at half resolution while brightness stays full. Human vision resolves
  // colour far more coarsely than luminance, so this is close to free.
  //
  // Measured on a 300 DPI colour scan, holding DPI and QFactor fixed:
  //   rung  5  1,442,462 -> 1,363,051 bytes  (5.5% smaller, -0.01 dB)
  //   rung  7    598,611 ->   559,377 bytes  (6.6% smaller, -0.01 dB)
  //   rung 10    271,251 ->   250,643 bytes  (7.6% smaller, -0.01 dB)
  //   rung 11    149,553 ->   133,866 bytes (10.5% smaller, -0.01 dB)
  //
  // -0.01 dB is measurement noise. This matters because it shifts the whole
  // size/quality frontier: for a given target, the search now settles on a
  // gentler rung, so images keep more detail at the same file size.
  const dict = `<</QFactor ${qFactor} /Blend 1 /HSamples [2 1 1 1] /VSamples [2 1 1 1]>>`
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
    distillerParams(rung.qFactor),
    '-f',
    inputPath,
  ]
}
