export interface Rung {
  index: number
  /** Target image resolution in DPI. `null` on rung 0, which does not downsample. */
  dpi: number | null
  /** Ghostscript JPEG QFactor. Higher is worse. `null` on rung 0. */
  qFactor: number | null
  grayscale: boolean
  /** Plain-language quality description shown to the user. */
  label: string
}

export type CompressStatus =
  | 'already-small'
  | 'hit-target'
  | 'floor-reached'
  | 'impossible'

export interface CompressProgress {
  attempt: number
  estimatedTotal: number
  rungIndex: number
  rungLabel: string
  dpi: number | null
}

export interface CompressOutcome {
  status: CompressStatus
  /** Absolute path to the produced file. `null` only when status is 'already-small'. */
  outputPath: string | null
  bytes: number
  rungIndex: number | null
  rungLabel: string | null
  attempts: number
}

export type FailureKind =
  | 'not-pdf'
  | 'encrypted'
  | 'no-space'
  | 'gs-missing'
  | 'input-unreadable'
  | 'cancelled'
  | 'unknown'

export interface CompressFailure {
  kind: FailureKind
  /** A plain sentence for the user. */
  message: string
  /** Raw diagnostics, surfaced only behind a "Copy details" button. */
  details: string
}

export type CompressResponse =
  | { ok: true; outcome: CompressOutcome }
  | { ok: false; failure: CompressFailure }
