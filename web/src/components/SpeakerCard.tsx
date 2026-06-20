import type { SpeakerConfig, SpeakerMode, Voice } from '../api'
import { DESIGN_CATEGORIES, LANGUAGES } from '../constants'
import { Toggle } from './ui'

function DesignBuilder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const has = (opt: string) => parts.includes(opt)
  const toggle = (cat: string[], opt: string) => {
    let next = parts.filter((p) => !cat.includes(p) || p === opt)
    if (has(opt)) next = next.filter((p) => p !== opt)
    else next.push(opt)
    onChange(next.join(', '))
  }
  return (
    <div>
      {DESIGN_CATEGORIES.map((c) => (
        <div key={c.key} style={{ marginBottom: 8 }}>
          <div className="hint" style={{ marginBottom: 4 }}>
            {c.label}
          </div>
          <div className="chips">
            {c.options.map((o) => (
              <span key={o} className={`chip ${has(o) ? 'on' : ''}`} onClick={() => toggle(c.options, o)}>
                {o}
              </span>
            ))}
          </div>
        </div>
      ))}
      <input
        className="input"
        style={{ marginTop: 4 }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. female, low pitch, british accent"
      />
    </div>
  )
}

export function SpeakerCard({
  index,
  config,
  voices,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  index: number
  config: SpeakerConfig
  voices: Voice[]
  onChange: (c: SpeakerConfig) => void
  onRemove?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
}) {
  const set = (patch: Partial<SpeakerConfig>) => onChange({ ...config, ...patch })

  // A project can carry a voice that isn't in this library: an ephemeral
  // "project-voice/<name>" (snapshot travels in the project) or a voice since
  // removed. Surface it as a selectable option so the right voice always shows.
  const isProjectVoice = !!config.voice && config.voice.startsWith('project-voice/')
  const voiceInLibrary = !!config.voice && voices.some((v) => v.id === config.voice)
  const orphanLabel = isProjectVoice
    ? `${config.voice!.replace(/^project-voice\//, '')} (in project)`
    : config.voice ?? ''
  const headVoice = config.voice ? (isProjectVoice ? orphanLabel : config.voice) : 'No voice selected'

  return (
    <div className="speaker-card">
      <div className="sc-head">
        {(onMoveUp || onMoveDown) && (
          <div className="sc-order">
            <button className="sc-order-btn" disabled={!onMoveUp} onClick={onMoveUp} title="Move this speaker (and its track) up">
              ▲
            </button>
            <button className="sc-order-btn" disabled={!onMoveDown} onClick={onMoveDown} title="Move this speaker (and its track) down">
              ▼
            </button>
          </div>
        )}
        <div className="speaker-badge">{index}</div>
        <div className="sc-voice">
          {config.mode === 'clone' ? headVoice : config.mode === 'design' ? 'Designed voice' : 'Auto voice'}
        </div>
        <div className="segment">
          {(['clone', 'design', 'auto'] as SpeakerMode[]).map((m) => (
            <button key={m} className={config.mode === m ? 'active' : ''} onClick={() => set({ mode: m })}>
              {m}
            </button>
          ))}
        </div>
        {onRemove && (
          <button className="btn ghost sm danger sc-remove" onClick={onRemove} title="Remove this speaker">
            ✕
          </button>
        )}
      </div>

      {config.mode === 'clone' && (
        <>
          <label className="field">
            <span>Reference voice</span>
            <select className="input" value={config.voice ?? ''} onChange={(e) => set({ voice: e.target.value })}>
              <option value="">Select a voice…</option>
              {config.voice && !voiceInLibrary && <option value={config.voice}>{orphanLabel}</option>}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Reference transcript (optional — auto-transcribed if blank)</span>
            <input
              className="input"
              value={config.ref_text ?? ''}
              onChange={(e) => set({ ref_text: e.target.value })}
              placeholder="What the reference audio says…"
            />
          </label>
          <div className="row wrap" style={{ gap: 14, marginBottom: 4, alignItems: 'center' }}>
            <Toggle checked={config.isolate} onChange={(v) => set({ isolate: v })} label="Isolate on the fly" />
            <Toggle checked={config.normalize} onChange={(v) => set({ normalize: v })} label="Normalize" />
            <Toggle checked={config.dereverb ?? false} onChange={(v) => set({ dereverb: v })} label="De-reverb" />
            {(config.dereverb ?? false) && (
              <select
                className="input"
                style={{ maxWidth: 160, padding: '4px 8px' }}
                value={config.dereverb_method ?? 'roformer'}
                onChange={(e) => set({ dereverb_method: e.target.value as 'roformer' | 'deepfilternet' })}
                title="Roformer = strongest echo removal; DeepFilterNet = lighter/faster"
              >
                <option value="roformer">Roformer (strong)</option>
                <option value="deepfilternet">DeepFilterNet (light)</option>
              </select>
            )}
          </div>
        </>
      )}

      {config.mode === 'design' && (
        <label className="field">
          <span>Voice attributes</span>
          <DesignBuilder value={config.instruct ?? ''} onChange={(v) => set({ instruct: v })} />
        </label>
      )}

      <label className="field" style={{ marginBottom: 0 }}>
        <span>Language</span>
        <select
          className="input"
          value={config.language ?? 'Auto'}
          onChange={(e) => set({ language: e.target.value === 'Auto' ? null : e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
