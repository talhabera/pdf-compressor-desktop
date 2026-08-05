import { useState } from 'react'
import type { PickedFile } from '@shared/types'
import { formatBytes } from '../format'

interface Props {
  file: PickedFile | null
  disabled: boolean
  onPick: (file: PickedFile) => void
}

export default function DropZone({ file, disabled, onPick }: Props) {
  const [over, setOver] = useState(false)

  async function browse() {
    if (disabled) return
    const picked = await window.api.pickFile()
    if (picked) onPick(picked)
  }

  async function drop(e: React.DragEvent) {
    e.preventDefault()
    setOver(false)
    if (disabled) return
    const dropped = e.dataTransfer.files[0]
    if (!dropped) return
    const path = window.api.pathForFile(dropped)
    if (!path) return
    const stat = await window.api.statFile(path)
    if (stat) onPick(stat)
  }

  // Empty state doubles as a button, so Enter/Space must open the same
  // picker a click would — this is the keyboard path onto the whole app.
  function keyDown(e: React.KeyboardEvent) {
    if (file || disabled) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void browse()
    }
  }

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${file ? ' filled' : ''}`}
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      aria-label={file ? undefined : 'Choose a PDF to compress'}
      onClick={file ? undefined : () => void browse()}
      onKeyDown={keyDown}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => void drop(e)}
    >
      {file ? (
        <>
          <div className="filename">{file.path.split(/[/\\]/).pop()}</div>
          <div className="sub">
            <span className="mono">{formatBytes(file.bytes)}</span>
            {' · '}
            <button
              type="button"
              className="btn-link"
              onClick={() => void browse()}
              disabled={disabled}
            >
              choose a different file
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="title">Drop a PDF here</div>
          <div className="hint">or click to choose one</div>
        </>
      )}
    </div>
  )
}
