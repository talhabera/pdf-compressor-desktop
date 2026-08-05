interface Props {
  mb: number
  disabled: boolean
  onChange: (mb: number) => void
}

export default function TargetInput({ mb, disabled, onChange }: Props) {
  return (
    <div className="row">
      <label htmlFor="target" className="label">
        Target size
      </label>
      <span className="sep">·</span>
      <input
        id="target"
        type="number"
        className="target-input mono"
        min="0.05"
        step="0.05"
        value={mb}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value)
          if (Number.isFinite(next) && next > 0) onChange(next)
        }}
      />
      <span className="sep">·</span>
      <span className="label">MB</span>
    </div>
  )
}
