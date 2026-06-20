import type { SystemInfo } from '../api'
import { Toggle } from './ui'

export function TopBar({
  info,
  busy,
  onLoad,
  onUnload,
  onToggleLod,
  onToggleLowVram,
  onToggleTrimSilence,
  onToggleAutoSlice,
  onToggleFormat,
}: {
  info: SystemInfo | null
  busy: boolean
  onLoad: () => void
  onUnload: () => void
  onToggleLod: (v: boolean) => void
  onToggleLowVram: (v: boolean) => void
  onToggleTrimSilence: (v: boolean) => void
  onToggleAutoSlice: (v: boolean) => void
  onToggleFormat: (format: string) => void
}) {
  const gpu = info?.gpu
  const pct = gpu && gpu.used_mb && gpu.total_mb ? (gpu.used_mb / gpu.total_mb) * 100 : 0
  const loaded = info?.loaded
  const lossless = (info?.output_format ?? 'mp3') !== 'mp3'

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

      <Toggle
        checked={lossless}
        onChange={(v) => onToggleFormat(v ? 'flac' : 'mp3')}
        label={lossless ? 'FLAC' : 'MP3'}
        title={
          'Output file format for finished renders & downloads.\n\n' +
          'MP3: small, universally shareable; fine for speech, but lossy.\n' +
          'FLAC: lossless, ~2× the size — the industry-standard master format ' +
          'for professional audio. Toggle on for FLAC.'
        }
      />
      <Toggle
        checked={!!info?.load_on_demand}
        onChange={onToggleLod}
        label="LOD"
        title={
          'Load-on-Demand.\n\n' +
          'Loads the voice model only while a render is running and frees your ' +
          'graphics-card memory (VRAM) the moment it finishes. Slower per ' +
          'render (reloads each time), but leaves your GPU free for other apps. ' +
          'Best if VRAM is tight or you render only occasionally.'
        }
      />
      <Toggle
        checked={!!info?.low_vram}
        onChange={onToggleLowVram}
        label="Low VRAM"
        title={
          'Low-VRAM mode.\n\n' +
          'Loads helper steps (voice isolation, de-reverb) one at a time and ' +
          'frees each before the main model, lowering the peak memory a render ' +
          'needs. A bit slower, but lets smaller graphics cards handle jobs ' +
          'that would otherwise run out of memory.'
        }
      />
      <Toggle
        checked={!!info?.trim_silence}
        onChange={onToggleTrimSilence}
        label="Trim silence"
        title={
          'Auto-trim silence.\n\n' +
          'Automatically removes dead air from the start and end of every ' +
          'generated clip and recorded take (leaving a small natural pad), so ' +
          'you stop hand-trimming the empty space the model and human timing ' +
          'leave behind. Applies to segment generations/regenerations, the ' +
          'Voice Clone render, and recorded performances.'
        }
      />
      <Toggle
        checked={!!info?.auto_slice}
        onChange={onToggleAutoSlice}
        label="Auto-slice"
        title={
          'Auto-slice by sentence.\n\n' +
          'After a scene finishes generating, automatically splits every voice ' +
          'track into one clip per sentence — so you land with sentence-level ' +
          'clips ready to move, trim and re-time. Runs as a follow-on pass once ' +
          'all speech is rendered (uploaded audio channels are left alone). ' +
          'Use the “Bulk slice” button in the track controls to slice an ' +
          'existing scene on demand.'
        }
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
