import { useState } from 'react'
import { DEFAULT_TRANSFORM, type VocalTransform } from '../api'

/** Shared collapsible "Vocal transforms" box used by BOTH the ADR Studio
 * performance modal and the Voice Clone tab. Reshapes the take before the V2V
 * transfer — pitch/formant move the performance into the target's register
 * (prosody preserved by the WORLD vocoder), plus the classic creative colours
 * (sub-octave, drive, ring-mod, vibrato) behind weight sliders.
 *
 * Keep this the single source of truth: capability added here lands in both UIs. */

type Preset = { label: string; emoji: string; values: Partial<VocalTransform> }

const PRESETS: Preset[] = [
  { label: 'Vader', emoji: '🖤', values: { pitch: -4, formant: -3, sub: 0.5, drive: 0.25 } },
  { label: 'Monster', emoji: '👹', values: { pitch: -6, formant: -5, sub: 0.6, drive: 0.5 } },
  { label: 'Demon', emoji: '😈', values: { pitch: -5, formant: -4, sub: 0.4, drive: 0.4, ringmod: 0.3, ringmod_hz: 55 } },
  { label: 'Child', emoji: '🧒', values: { pitch: 5, formant: 4 } },
  { label: 'Chipmunk', emoji: '🐿', values: { pitch: 9, formant: 6 } },
  { label: 'Robot', emoji: '🤖', values: { ringmod: 0.7, ringmod_hz: 120, drive: 0.2 } },
  { label: 'Telephone', emoji: '☎️', values: { telephone: 0.35, tel_crackle: 0.1 } },
]

const isActive = (t: VocalTransform) =>
  Math.abs(t.pitch) > 0.01 ||
  Math.abs(t.formant) > 0.01 ||
  t.sub > 0.01 ||
  t.drive > 0.01 ||
  t.ringmod > 0.01 ||
  t.vibrato > 0.01 ||
  (t.telephone ?? 0) > 0.01

function summary(t: VocalTransform): string {
  const bits: string[] = []
  if (Math.abs(t.pitch) > 0.01) bits.push(`pitch ${t.pitch > 0 ? '+' : ''}${t.pitch}st`)
  if (Math.abs(t.formant) > 0.01) bits.push(`formant ${t.formant > 0 ? '+' : ''}${t.formant}st`)
  if (t.sub > 0.01) bits.push('sub')
  if (t.drive > 0.01) bits.push('drive')
  if (t.ringmod > 0.01) bits.push('ring')
  if (t.vibrato > 0.01) bits.push('vibrato')
  if ((t.telephone ?? 0) > 0.01) bits.push('telephone')
  return bits.join(' · ')
}

export function VocalTransforms({
  value,
  onChange,
  autoPitch,
  onAutoPitch,
  onApply,
  onReset,
  applied = false,
  applyLabel = '🎧 Apply to take',
  target = 'take',
  defaultOpen,
  disabled = false,
}: {
  value: VocalTransform
  onChange: (t: VocalTransform) => void
  /** Current state of the transparent "auto pitch-match to target" toggle.
   * Pass `onAutoPitch` to show the toggle (only when a clone target exists). */
  autoPitch?: boolean
  onAutoPitch?: (v: boolean) => void
  /** Bake the current transforms straight onto the MAIN player for this audio
   * (no separate mini-player). The parent swaps its real audio in place. */
  onApply?: () => Promise<void>
  /** Revert the main player back to the original (un-transformed) audio. */
  onReset?: () => void
  /** True while the modulated audio is currently baked onto the main player. */
  applied?: boolean
  applyLabel?: string
  /** What the main player holds — drives copy ("take" vs "output"). */
  target?: 'take' | 'output'
  defaultOpen?: boolean
  disabled?: boolean
}) {
  // Auto-pitch is on by default and transparent, so it shouldn't force the box
  // open — only genuinely-active creative transforms do.
  const [open, setOpen] = useState(() => defaultOpen ?? isActive(value))
  const [applying, setApplying] = useState(false)

  const set = (patch: Partial<VocalTransform>) => onChange({ ...value, ...patch })
  const active = isActive(value)

  const applyPreset = (p: Preset) => onChange({ ...DEFAULT_TRANSFORM, ...p.values })

  const apply = async () => {
    if (!onApply) return
    setApplying(true)
    try {
      await onApply()
    } finally {
      setApplying(false)
    }
  }

  const reset = () => {
    onChange({ ...DEFAULT_TRANSFORM })
    onReset?.()
  }

  const row = (
    label: string,
    key: keyof VocalTransform,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string,
  ) => (
    <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
      <span style={{ minWidth: 150 }}>
        {label} · {fmt(value[key])}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value[key]}
        disabled={disabled}
        style={{ flex: 1 }}
        onChange={(e) => set({ [key]: parseFloat(e.target.value) } as Partial<VocalTransform>)}
      />
    </label>
  )

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
      <div className="flex-between" style={{ alignItems: 'center' }}>
        <button
          className="btn sm ghost"
          style={{ padding: '2px 6px' }}
          onClick={() => setOpen((o) => !o)}
          title="Render-time vocal transforms applied to your take before the voice clone"
        >
          {open ? '▾' : '▸'} 🎚 Vocal transforms
          {!open && applied ? ' · ✅ applied' : ''}
          {!open && autoPitch ? ' · 🎯 auto-pitch' : ''}
          {!open && active ? ` · ${summary(value)}` : ''}
        </button>
        {(active || applied) && (
          <button
            className="btn sm ghost"
            disabled={disabled || applying}
            onClick={reset}
            title={applied ? `Clear transforms and restore the original ${target}` : 'Clear all transforms'}
          >
            ↺ Reset
          </button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>
          <div className="hint" style={{ opacity: 0.8, marginBottom: 6 }}>
            Reshapes your take before the clone — pitch/formant preserve timing & prosody (WORLD vocoder). Great for
            mapping a deep voice onto a high target.
          </div>

          {onAutoPitch && (
            <label
              className="hint"
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid var(--border-soft)' }}
              title="Transparently shifts your take's pitch onto the target voice's register at render time — deterministic, no tuning. The sliders below stack on top as creative overrides."
            >
              <input
                type="checkbox"
                checked={!!autoPitch}
                disabled={disabled}
                onChange={(e) => onAutoPitch(e.target.checked)}
              />
              🎯 Auto pitch-match to target voice
            </label>
          )}

          <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="hint" style={{ minWidth: 50 }}>Presets</span>
            {PRESETS.map((p) => (
              <button key={p.label} className="btn sm" disabled={disabled} onClick={() => applyPreset(p)} title={`Apply the ${p.label} preset`}>
                {p.emoji} {p.label}
              </button>
            ))}
          </div>

          {row('Pitch', 'pitch', -24, 24, 1, (v) => `${v > 0 ? '+' : ''}${v} st`)}
          {row('Formant', 'formant', -12, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${v} st`)}
          <div className="hint" style={{ opacity: 0.65, margin: '2px 0 4px 0' }}>
            Formant up = smaller/younger · down = bigger/darker (independent of pitch)
          </div>
          {row('Sub-octave', 'sub', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          {row('Drive (growl)', 'drive', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          {row('Ring mod', 'ringmod', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          {value.ringmod > 0.01 && row('  ↳ carrier', 'ringmod_hz', 10, 400, 5, (v) => `${v} Hz`)}
          {row('Vibrato', 'vibrato', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          {value.vibrato > 0.01 && row('  ↳ rate', 'vibrato_hz', 0.5, 12, 0.5, (v) => `${v} Hz`)}
          {row('☎️ Telephone', 'telephone', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          {(value.telephone ?? 0) > 0.01 && (
            <>
              {row('  ↳ crackle', 'tel_crackle', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
              <div className="hint" style={{ opacity: 0.65, margin: '2px 0 4px 0' }}>
                Band-limits + crushes the audio to a phone-line / old-voicemail sound; crackle adds line noise.
              </div>
            </>
          )}

          {onApply && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-soft)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <button
                  className="btn sm good"
                  disabled={disabled || applying || (!active && !autoPitch)}
                  onClick={() => void apply()}
                  title={`Bake these transforms onto the ${target} above and play it — what you hear is exactly what gets used`}
                >
                  {applying ? <span className="spinner sm" /> : applied ? `↻ Re-apply to ${target}` : applyLabel}
                </button>
                {applied && (
                  <button className="btn sm ghost" disabled={disabled || applying} onClick={reset} title={`Restore the original ${target}`}>
                    ↩ Original
                  </button>
                )}
                <span className="hint" style={{ opacity: 0.75 }}>
                  {applied ? `✅ modulated ${target} is live on the player above` : `bakes onto the ${target} above — your ears are the judge`}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
