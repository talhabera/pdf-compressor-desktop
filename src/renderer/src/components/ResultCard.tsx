import type { CompressOutcome } from '@shared/types'
import { formatBytes } from '../format'

interface Props {
  outcome: CompressOutcome
  originalBytes: number
  saving: boolean
  onSave: () => void
  onSqueeze: () => void
}

export default function ResultCard({
  outcome,
  originalBytes,
  saving,
  onSave,
  onSqueeze,
}: Props) {
  if (outcome.status === 'already-small') {
    return (
      <div className="section">
        <div className="note">
          Already <span className="mono">{formatBytes(outcome.bytes)}</span> — nothing to do.
        </div>
      </div>
    )
  }

  let message: string
  if (outcome.status === 'floor-reached') {
    message = 'This is as small as it goes without making it unreadable.'
  } else if (outcome.status === 'impossible') {
    message = "That's as small as this file can get."
  } else {
    message = `Compressed at ${outcome.rungLabel}.`
  }

  return (
    <div className="section">
      <div className="result-sizes">
        <span className="before">{formatBytes(originalBytes)}</span>
        <span className="arrow">→</span>
        <span>{formatBytes(outcome.bytes)}</span>
      </div>

      <div className="note">{message}</div>

      <div className="row">
        <button type="button" className="btn" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save As…'}
        </button>
        {outcome.status === 'floor-reached' && (
          <button type="button" className="btn-ghost" onClick={onSqueeze}>
            Squeeze harder
          </button>
        )}
      </div>
    </div>
  )
}
