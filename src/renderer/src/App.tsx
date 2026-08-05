import { useEffect, useState } from 'react'
import type { CompressFailure, CompressOutcome, CompressProgress, PickedFile } from '@shared/types'
import DropZone from './components/DropZone'
import TargetInput from './components/TargetInput'
import ProgressPanel, { type TrackPoint } from './components/ProgressPanel'
import ResultCard from './components/ResultCard'
import { mbToBytes } from './format'
import './styles.css'

const TARGET_KEY = 'targetMb'
const DEFAULT_TARGET_MB = 1.75

function loadTarget(): number {
  const stored = Number(localStorage.getItem(TARGET_KEY))
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TARGET_MB
}

export default function App() {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [targetMb, setTargetMb] = useState(loadTarget)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<CompressProgress | null>(null)
  const [history, setHistory] = useState<TrackPoint[]>([])
  const [outcome, setOutcome] = useState<CompressOutcome | null>(null)
  const [failure, setFailure] = useState<CompressFailure | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(
    () =>
      window.api.onProgress((p) => {
        setProgress(p)
        // Only the "landed" half of each attempt's pair of events carries a
        // measured size — that's the one the track renders as a tick.
        if (p.bytes !== null) {
          setHistory((prev) =>
            prev.some((h) => h.rungIndex === p.rungIndex)
              ? prev
              : [...prev, { rungIndex: p.rungIndex, bytes: p.bytes! }],
          )
        }
      }),
    [],
  )

  useEffect(() => localStorage.setItem(TARGET_KEY, String(targetMb)), [targetMb])

  function reset(next: PickedFile | null) {
    setFile(next)
    setOutcome(null)
    setFailure(null)
    setProgress(null)
    setHistory([])
  }

  async function run(allowSqueeze: boolean) {
    if (!file) return
    setBusy(true)
    setOutcome(null)
    setFailure(null)
    setProgress(null)
    setHistory([])

    const res = await window.api.compress({
      inputPath: file.path,
      targetBytes: mbToBytes(targetMb),
      allowSqueeze,
    })

    if (res.ok) setOutcome(res.outcome)
    else if (res.failure.kind !== 'cancelled') setFailure(res.failure)
    setBusy(false)
    setProgress(null)
  }

  async function save() {
    if (!outcome?.outputPath || !file) return
    setSaving(true)
    const suggested = file.path.split(/[/\\]/).pop()!.replace(/\.pdf$/i, '') + '-compressed.pdf'
    const saved = await window.api.save({
      tempPath: outcome.outputPath,
      suggestedName: suggested,
    })
    setSaving(false)
    if (saved) reset(file)
  }

  async function cancel() {
    await window.api.cancel()
    setBusy(false)
    setProgress(null)
  }

  return (
    <main>
      <h1>PDF Compressor</h1>

      <DropZone file={file} disabled={busy} onPick={reset} />

      <div className="row between">
        <TargetInput mb={targetMb} disabled={busy} onChange={setTargetMb} />
        <button
          type="button"
          className="btn"
          onClick={() => void run(false)}
          disabled={!file || busy}
        >
          Compress
        </button>
      </div>

      {busy && (
        <ProgressPanel
          progress={progress}
          history={history}
          originalBytes={file?.bytes ?? 0}
          targetBytes={mbToBytes(targetMb)}
          onCancel={() => void cancel()}
        />
      )}

      {outcome && !busy && (
        <ResultCard
          outcome={outcome}
          originalBytes={file?.bytes ?? 0}
          saving={saving}
          onSave={() => void save()}
          onSqueeze={() => void run(true)}
        />
      )}

      {failure && !busy && (
        <div className="section">
          <div className="error">{failure.message}</div>
          <button
            type="button"
            className="btn-link"
            onClick={() => void navigator.clipboard.writeText(failure.details)}
          >
            Copy details
          </button>
        </div>
      )}
    </main>
  )
}
