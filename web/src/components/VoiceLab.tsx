import { useCallback, useRef, useState } from 'react'
import { api } from '../api'
import type { Voice } from '../api'
import { AudioPlayer } from './AudioPlayer'
import { Modal, Slider, Toggle } from './ui'
import { claimPlayback } from '../audioBus'

export function VoiceLab({
  voices,
  onClose,
  onSaved,
  notify,
}: {
  voices: Voice[]
  onClose: () => void
  onSaved: () => void
  notify: (m: string, k?: 'info' | 'error' | 'success') => void
}) {
  const [source, setSource] = useState<{ id: string; isUpload: boolean; label: string } | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [isolate, setIsolate] = useState(true)
  const [trim, setTrim] = useState(true)
  const [normalize, setNormalize] = useState(true)
  const [dereverb, setDereverb] = useState(false)
  const [dereverbMethod, setDereverbMethod] = useState<'roformer' | 'deepfilternet'>('roformer')
  const [gain, setGain] = useState(0)
  const [saveAs, setSaveAs] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const previewBusRef = useRef(Symbol('lab-preview'))

  // Manual trim window (seconds), reported by the source AudioPlayer.
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [clipDur, setClipDur] = useState(0)
  const onTrimChange = useCallback((s: number, e: number, d: number) => {
    setTrimStart(s)
    setTrimEnd(e)
    setClipDur(d)
  }, [])

  const isLibrary = !!source && !source.isUpload
  const hasTrim = trimStart > 0.02 || (clipDur > 0 && trimEnd < clipDur - 0.02)

  const body = () => ({
    source: source!.id,
    is_upload: source!.isUpload,
    isolate,
    trim,
    normalize,
    dereverb,
    dereverb_method: dereverbMethod,
    gain_db: gain,
    trim_start: trimStart > 0.02 ? trimStart : 0,
    trim_end: clipDur > 0 && trimEnd < clipDur - 0.02 ? trimEnd : 0,
    overwrite: overwrite && isLibrary,
    save_as: overwrite && isLibrary ? source!.label : saveAs || source!.label,
  })

  function pickSource(s: { id: string; isUpload: boolean; label: string }, url: string) {
    setSource(s)
    setSourceUrl(url)
    setPreviewUrl(null)
    setOverwrite(false)
  }

  async function handleUpload(file: File) {
    setBusy(true)
    try {
      const res = await api.uploadVoice(file)
      const label = file.name.replace(/\.[^.]+$/, '')
      pickSource({ id: res.upload_id, isUpload: true, label }, res.audio_url)
      if (!saveAs) setSaveAs(label)
      notify(`Uploaded (${res.duration_s}s)`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function doPreview() {
    if (!source) return notify('Pick or upload a sample first', 'error')
    setBusy(true)
    try {
      const res = await api.previewVoice(body())
      setPreviewUrl(res.audio_url + `?t=${Date.now()}`)
      notify(`Preview ready (${res.duration_s}s)`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function doSave() {
    if (!source) return notify('Pick or upload a sample first', 'error')
    if (!(overwrite && isLibrary) && !saveAs.trim()) return notify('Enter a name to save as', 'error')
    setBusy(true)
    try {
      const res = await api.processVoice(body())
      notify(`${overwrite && isLibrary ? 'Overwrote' : 'Saved'} “${res.name}” (${res.duration_s}s)`, 'success')
      onSaved()
      onClose()
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="⚗ Voice Lab" onClose={onClose}>
      <p className="hint" style={{ marginTop: 0 }}>
        Trim a sample, isolate vocals (remove music/noise), de-reverb, and level loudness, then save a clean reference
        into your library.
      </p>

      <div className="section-title">1 · Source sample</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          ⬆ Upload file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
        />
        <span className="grow" />
        <select
          className="input"
          style={{ maxWidth: 240 }}
          value={source && !source.isUpload ? source.id : ''}
          onChange={(e) => {
            const v = voices.find((x) => x.id === e.target.value)
            if (v) {
              pickSource({ id: v.id, isUpload: false, label: v.name }, `/api/audio/voice/${v.id}`)
              setSaveAs(v.name + '_clean')
            }
          }}
        >
          <option value="">…or pick from library</option>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
      {source && <div className="hint">Selected: {source.label}</div>}

      {sourceUrl && (
        <>
          <div className="divider" />
          <div className="section-title">2 · Trim</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Drag the start/end handles to cut off bad heads/tails (e.g. a clipped final word that causes artifacts).
            The selected window is what gets processed and saved.
          </p>
          <AudioPlayer
            key={sourceUrl}
            url={sourceUrl}
            title={source?.label}
            autoPlay={false}
            showDownload={false}
            onTrimChange={onTrimChange}
          />
        </>
      )}

      <div className="divider" />
      <div className="section-title">3 · Processing</div>
      <div className="row wrap" style={{ gap: 16, marginBottom: 10, alignItems: 'center' }}>
        <Toggle checked={isolate} onChange={setIsolate} label="Isolate vocals" />
        <Toggle checked={trim} onChange={setTrim} label="Trim silence" />
        <Toggle checked={normalize} onChange={setNormalize} label="Normalize loudness" />
        <Toggle checked={dereverb} onChange={setDereverb} label="De-reverb / de-echo" />
        {dereverb && (
          <select
            className="input"
            style={{ maxWidth: 180, padding: '4px 8px' }}
            value={dereverbMethod}
            onChange={(e) => setDereverbMethod(e.target.value as 'roformer' | 'deepfilternet')}
            title="Roformer = strongest echo removal; DeepFilterNet = lighter/faster"
          >
            <option value="roformer">Roformer (strong)</option>
            <option value="deepfilternet">DeepFilterNet (light)</option>
          </select>
        )}
      </div>
      <Slider label="Gain" min={-12} max={12} step={0.5} value={gain} onChange={setGain} format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />

      <div className="divider" />
      <div className="section-title">4 · Preview & save</div>
      {previewUrl && (
        <audio
          controls
          src={previewUrl}
          style={{ width: '100%', marginBottom: 10 }}
          onPlay={(e) => {
            const el = e.currentTarget
            claimPlayback(previewBusRef.current, () => el.pause())
          }}
        />
      )}

      {isLibrary && (
        <label className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite the existing voice in place</span>
        </label>
      )}
      {overwrite && isLibrary && (
        <div className="warn-banner">
          ⚠ This will overwrite <strong>{source!.label}</strong> — the original file is replaced and cannot be undone.
          Test on a copy first!
        </div>
      )}

      <label className="field">
        <span>Save as (path inside library, e.g. personal/my-voice)</span>
        <input
          className="input"
          value={overwrite && isLibrary ? source!.label : saveAs}
          onChange={(e) => setSaveAs(e.target.value)}
          placeholder="folder/name"
          disabled={overwrite && isLibrary}
        />
      </label>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="hint">{hasTrim ? `Trim: ${trimStart.toFixed(1)}s – ${trimEnd.toFixed(1)}s` : 'No trim applied'}</span>
        <div className="row">
          <button className="btn" onClick={doPreview} disabled={busy || !source}>
            {busy ? <span className="spinner" /> : '🔊'} Preview
          </button>
          <button
            className={`btn ${overwrite && isLibrary ? 'danger-solid' : 'primary'}`}
            onClick={doSave}
            disabled={busy || !source}
          >
            {overwrite && isLibrary ? '⟳ Overwrite voice' : '💾 Save to library'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
