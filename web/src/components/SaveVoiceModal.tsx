import { useState } from 'react'
import { api } from '../api'
import ToolModal from './ToolModal'

/** Export the take (your voice) or a rendered output straight into the Voice
 * Lab library, with the same cleanup options the Lab offers. Shared by the ADR
 * Studio performance modal and the Voice Clone tab so saving a fun voice works
 * identically in both. */
export default function SaveVoiceModal({
  take,
  output,
  defaultName,
  onSaved,
  onClose,
}: {
  take: { blob: Blob | null; url: string } | null
  output: { url: string } | null
  defaultName: string
  onSaved?: () => void
  onClose: () => void
}) {
  const [source, setSource] = useState<'output' | 'take'>(output ? 'output' : 'take')
  const [name, setName] = useState(defaultName)
  const [isolate, setIsolate] = useState(false)
  const [normalize, setNormalize] = useState(true)
  const [trim, setTrim] = useState(true)
  const [dereverb, setDereverb] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const nm = name.trim()
    if (!nm) {
      setError('Give the voice a name (folders work too, e.g. "Cast/Alice")')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const src = source === 'output' ? output : take
      if (!src) throw new Error('No audio to save')
      const blob = source === 'take' && take?.blob ? take.blob : await (await fetch(src.url)).blob()
      const up = await api.uploadVoice(new File([blob], 'voice.wav', { type: blob.type || 'audio/wav' }))
      const saved = await api.processVoice({
        source: up.upload_id,
        is_upload: true,
        isolate,
        normalize,
        trim,
        dereverb,
        gain_db: 0,
        save_as: nm,
      })
      onSaved?.()
      setDone(saved.name || nm)
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolModal
      open
      width={480}
      title={<span>📚 Save voice to library</span>}
      onClose={onClose}
      actions={
        done ? undefined : (
          <button className="btn sm primary" disabled={busy} onClick={save}>
            {busy ? <span className="spinner sm" /> : '💾'} Save voice
          </button>
        )
      }
    >
      {done ? (
        <div>
          <div style={{ fontSize: 14, marginBottom: 8 }}>
            ✅ Saved <strong>{done}</strong> to the voice library.
          </div>
          <div className="hint">It's available right away in the Voices panel and every speaker picker.</div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn sm primary" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <>
          {output && take && (
            <div className="row" style={{ gap: 8, marginBottom: 12 }}>
              <span className="hint" style={{ minWidth: 50 }}>Source</span>
              <button
                className={`btn sm${source === 'output' ? ' on' : ''}`}
                title="The rendered output — the character's voice performing the line"
                onClick={() => setSource('output')}
              >
                ⚡ Rendered output
              </button>
              <button
                className={`btn sm${source === 'take' ? ' on' : ''}`}
                title="Your raw take — your own voice"
                onClick={() => setSource('take')}
              >
                🎬 Take (your voice)
              </button>
            </div>
          )}
          <label className="field">
            <span>Voice name (use “/” for folders, e.g. Cast/Alice)</span>
            <input
              className="input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              placeholder="e.g. Cast/Alice"
            />
          </label>
          <div className="row wrap" style={{ gap: 14, marginTop: 4 }}>
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
              Isolate vocals
            </label>
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
              Normalize
            </label>
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
              Trim silence
            </label>
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={dereverb} onChange={(e) => setDereverb(e.target.checked)} />
              Dereverb
            </label>
          </div>
          <div className="hint" style={{ marginTop: 10, opacity: 0.8 }}>
            The audio is processed and saved like a Voice Lab import — it lands in the library immediately,
            ready to cast on any speaker.
          </div>
          {error && <div className="hint" style={{ color: 'var(--bad, #e66)', marginTop: 8 }}>{error}</div>}
        </>
      )}
    </ToolModal>
  )
}
