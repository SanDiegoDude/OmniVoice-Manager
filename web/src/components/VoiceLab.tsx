import { useRef, useState } from 'react'
import { api } from '../api'
import type { Voice } from '../api'
import { Modal, Slider, Toggle } from './ui'

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
  const [isolate, setIsolate] = useState(true)
  const [trim, setTrim] = useState(true)
  const [normalize, setNormalize] = useState(true)
  const [dereverb, setDereverb] = useState(false)
  const [dereverbMethod, setDereverbMethod] = useState<'roformer' | 'deepfilternet'>('roformer')
  const [gain, setGain] = useState(0)
  const [saveAs, setSaveAs] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const body = () => ({
    source: source!.id,
    is_upload: source!.isUpload,
    isolate,
    trim,
    normalize,
    dereverb,
    dereverb_method: dereverbMethod,
    gain_db: gain,
    save_as: saveAs || source!.label,
  })

  async function handleUpload(file: File) {
    setBusy(true)
    try {
      const res = await api.uploadVoice(file)
      setSource({ id: res.upload_id, isUpload: true, label: file.name.replace(/\.[^.]+$/, '') })
      if (!saveAs) setSaveAs(file.name.replace(/\.[^.]+$/, ''))
      setPreviewUrl(res.audio_url)
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
    if (!saveAs.trim()) return notify('Enter a name to save as', 'error')
    setBusy(true)
    try {
      const res = await api.processVoice(body())
      notify(`Saved “${res.name}” (${res.duration_s}s)`, 'success')
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
        Isolate vocals (remove music/noise via Mel-Band-Roformer), trim silence, and boost/level loudness, then save a
        clean reference into your library.
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
              setSource({ id: v.id, isUpload: false, label: v.name })
              setSaveAs(v.name + '_clean')
              setPreviewUrl(`/api/audio/voice/${v.id}`)
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

      <div className="divider" />
      <div className="section-title">2 · Processing</div>
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
      <div className="section-title">3 · Preview & save</div>
      {previewUrl && <audio controls src={previewUrl} style={{ width: '100%', marginBottom: 10 }} />}
      <label className="field">
        <span>Save as (path inside library, e.g. personal/my-voice)</span>
        <input className="input" value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder="folder/name" />
      </label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={doPreview} disabled={busy || !source}>
          {busy ? <span className="spinner" /> : '🔊'} Preview
        </button>
        <button className="btn primary" onClick={doSave} disabled={busy || !source}>
          💾 Save to library
        </button>
      </div>
    </Modal>
  )
}
