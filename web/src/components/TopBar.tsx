import type { SystemInfo } from '../api'
import { Toggle } from './ui'

export function TopBar({
  info,
  busy,
  onLoad,
  onUnload,
  onToggleLod,
  onToggleLowVram,
}: {
  info: SystemInfo | null
  busy: boolean
  onLoad: () => void
  onUnload: () => void
  onToggleLod: (v: boolean) => void
  onToggleLowVram: (v: boolean) => void
}) {
  const gpu = info?.gpu
  const pct = gpu && gpu.used_mb && gpu.total_mb ? (gpu.used_mb / gpu.total_mb) * 100 : 0
  const loaded = info?.loaded

  return (
    <div className="topbar">
      <div className="brand">
        <div className="logo">◈</div>
        <div>
          OmniVoice <span style={{ color: 'var(--accent)' }}>Manager</span>
          <br />
          <small>{info?.model_id ?? '—'}</small>
        </div>
      </div>

      <div className="spacer" />

      {info?.script_ai?.configured && (
        <div className="status-chip" title="Script AI provider">
          <span className="dot on" /> AI: {info.script_ai.model}
        </div>
      )}

      {gpu?.available && (
        <div className="gpu-meter" title={gpu.name ?? ''}>
          <div className="label">
            <span>VRAM</span>
            <span className="mono">
              {gpu.used_mb} / {gpu.total_mb} MB
            </span>
          </div>
          <div className="bar">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="status-chip">
        <span className={`dot ${loaded ? 'on' : 'off'}`} />
        {busy ? 'Working…' : loaded ? 'Model loaded' : 'Model idle'}
      </div>

      <Toggle checked={!!info?.load_on_demand} onChange={onToggleLod} label="LOD" />
      <Toggle
        checked={!!info?.low_vram}
        onChange={onToggleLowVram}
        label="Low VRAM"
      />

      {loaded ? (
        <button className="btn sm" onClick={onUnload} disabled={busy}>
          Unload
        </button>
      ) : (
        <button className="btn sm primary" onClick={onLoad} disabled={busy || !!info?.load_on_demand}>
          Load model
        </button>
      )}
    </div>
  )
}
