import type { CompressProgress } from '@shared/types'
import { formatBytes } from '../format'

/** One completed attempt's real measured size, in the order it landed. */
export interface TrackPoint {
  rungIndex: number
  bytes: number
}

interface Props {
  progress: CompressProgress | null
  history: TrackPoint[]
  originalBytes: number
  targetBytes: number
  onCancel: () => void
}

// Below this, every PDF looks the same on a log scale — floors the axis so
// log(0) never happens and the low end of the track isn't all dead space.
const MIN_TRACK_BYTES = 1_000

function trackPct(bytes: number, maxBytes: number): number {
  const lo = Math.log(MIN_TRACK_BYTES)
  const hi = Math.log(Math.max(maxBytes, MIN_TRACK_BYTES * 10))
  const v = Math.log(Math.max(bytes, MIN_TRACK_BYTES))
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * 100
}

export default function ProgressPanel({
  progress,
  history,
  originalBytes,
  targetBytes,
  onCancel,
}: Props) {
  const targetPct = trackPct(targetBytes, originalBytes)

  return (
    <div className="section">
      <div className="track-status" aria-live="polite">
        {progress ? (
          <>
            <span>
              Attempt {progress.attempt} of {progress.estimatedTotal}
            </span>
            <span>·</span>
            <span className="rung">{progress.rungLabel}</span>
          </>
        ) : (
          <span>Starting…</span>
        )}
      </div>

      {/*
        The track shows only real measurements: each tick is a completed
        attempt landing at the byte count Ghostscript actually produced,
        positioned on a log scale from ~0 to the original file size. The
        search bisects, so ticks appear on either side of the target and
        converge — that reads as hunting, not as a fake march to 100%.
      */}
      <div
        className="track"
        role="img"
        aria-label={`Measurement track. Target ${formatBytes(targetBytes)} of ${formatBytes(originalBytes)}.`}
      >
        <div className="track-line" />
        <div className="track-target" style={{ left: `${targetPct}%` }} />
        {history.map((point) => {
          // Whether this measurement fits is a pure function of its own
          // size and the live target — computed here rather than stored
          // on the point, so a mid-run target change can't leave a stale
          // answer sitting in state. This is the same "<= target" test
          // compress.ts uses to decide what counts as a candidate; the
          // search then keeps bisecting for a *better* fit (a lower rung
          // index, less quality lost), so later attempts routinely land
          // above the line even after a fit has already been found. Left
          // graphite, those read as "still checking," not as failures —
          // the fitting ones are the only ones that get the target's
          // amber, and there is usually more than one before the run ends.
          const fits = point.bytes <= targetBytes
          return (
            <div
              key={point.rungIndex}
              className={`track-tick${fits ? ' fits' : ''}`}
              style={{ left: `${trackPct(point.bytes, originalBytes)}%` }}
            />
          )
        })}
      </div>

      <div className="track-scale">
        <span className="mono at-zero">0</span>
        <span className="mono at-target" style={{ left: `${targetPct}%` }}>
          {formatBytes(targetBytes)}
        </span>
        <span className="mono at-end">{formatBytes(originalBytes)}</span>
      </div>

      <div className="row">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
