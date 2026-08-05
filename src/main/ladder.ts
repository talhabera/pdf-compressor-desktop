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
  { index: 0, dpi: null, qFactor: null, grayscale: false, label: 'original quality' },
  { index: 1, dpi: 250, qFactor: 0.15, grayscale: false, label: HIGH },
  { index: 2, dpi: 220, qFactor: 0.2, grayscale: false, label: HIGH },
  { index: 3, dpi: 200, qFactor: 0.25, grayscale: false, label: HIGH },
  { index: 4, dpi: 180, qFactor: 0.3, grayscale: false, label: HIGH },
  { index: 5, dpi: 150, qFactor: 0.4, grayscale: false, label: REDUCED },
  { index: 6, dpi: 130, qFactor: 0.5, grayscale: false, label: REDUCED },
  { index: 7, dpi: 110, qFactor: 0.65, grayscale: false, label: REDUCED },
  { index: 8, dpi: 100, qFactor: 0.8, grayscale: false, label: REDUCED },
  { index: 9, dpi: 90, qFactor: 1.0, grayscale: false, label: HEAVY },
  { index: 10, dpi: 80, qFactor: 1.3, grayscale: false, label: HEAVY },
  { index: 11, dpi: 72, qFactor: 2.0, grayscale: true, label: HEAVY },
  { index: 12, dpi: 60, qFactor: 2.4, grayscale: true, label: EXTREME },
  { index: 13, dpi: 50, qFactor: 3.0, grayscale: true, label: EXTREME },
  { index: 14, dpi: 40, qFactor: 3.5, grayscale: true, label: EXTREME },
  { index: 15, dpi: 30, qFactor: 4.0, grayscale: true, label: EXTREME },
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
  const dict = `<</QFactor ${qFactor} /Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1]>>`
  return (
    `<</ColorACSImageDict ${dict} /ColorImageDict ${dict}` +
    ` /GrayACSImageDict ${dict} /GrayImageDict ${dict}>> setdistillerparams`
  )
}

export function buildGsArgs(rung: Rung, inputPath: string, outputPath: string): string[] {
  if (rung.dpi === null || rung.qFactor === null) {
    return [
      ...BASE_ARGS,
      '-dDownsampleColorImages=false',
      '-dDownsampleGrayImages=false',
      '-dDownsampleMonoImages=false',
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
    ...(rung.grayscale
      ? ['-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray']
      : []),
    `-sOutputFile=${outputPath}`,
    '-c',
    distillerParams(rung.qFactor),
    '-f',
    inputPath,
  ]
}
