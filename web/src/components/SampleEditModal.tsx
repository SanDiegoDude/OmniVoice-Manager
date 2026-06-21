import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, DEFAULT_TRANSFORM, downloadFile, type ProcessVoiceBody, type SoundTransformBody, type VocalTransform } from '../api'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import ToolModal from './ToolModal'
import { Slider, Toggle } from './ui'
import { VocalTransforms } from './VocalTransforms'

export type EditTarget = {
  kind: 'voice' | 'sound'
  /** Library id (relative path). */
  id: string
  /** Display name (relative path without extension). */
  name: string
  /** Containing folder ('' = library root). */
  folder: string
}

const transformActive = (t: VocalTransform) =>
  Math.abs(t.pitch) > 0.01 ||
  Math.abs(t.formant) > 0.01 ||
  t.sub > 0.01 ||
  t.drive > 0.01 ||
  t.ringmod > 0.01 ||
  t.vibrato > 0.01 ||
  (t.tremolo ?? 0) > 0.01 ||
  (t.gate ?? 0) > 0.01 ||
  (t.chorus ?? 0) > 0.01 ||
  (t.muffle ?? 0) > 0.01 ||
  (t.echo ?? 0) > 0.01 ||
  (t.reverb ?? 0) > 0.01 ||
  (t.telephone ?? 0) > 0.01

const leaf = (name: string) => name.split('/').pop() || name

/** Reusable sample editor for BOTH libraries — modeled on the Voice Lab. Opens
 * with the sample loaded in place (overwrite armed), exposes the cleanup chain
 * (trim window, isolate/de-reverb/silence-trim/normalize, gain, speed) FIRST,
 * with the creative vocal/audio transforms collapsed underneath. Preview is
 * non-destructive; save writes a copy or overwrites in place, and Download
 * exports the edited result in the configured MP3/FLAC format. */
export function SampleEditModal({
  open,
  target,
  folders,
  onClose,
  onSaved,
  notify,
}: {
  open: boolean
  target: EditTarget | null
  folders: string[]
  onClose: () => void
  onSaved: () => void
  notify: (msg: string, kind?: 'info' | 'error' | 'success') => void
}) {
  const [tf, setTf] = useState<VocalTransform>({ ...DEFAULT_TRANSFORM })
  // Cleanup chain (default off so an edit only changes what you turn on).
  const [isolate, setIsolate] = useState(false)
  const [trimSil, setTrimSil] = useState(false)
  const [normalize, setNormalize] = useState(false)
  const [dereverb, setDereverb] = useState(false)
  const [dereverbMethod, setDereverbMethod] = useState<'roformer' | 'deepfilternet'>('roformer')
  const [gain, setGain] = useState(0)
  const [speed, setSpeed] = useState(1)
  // Manual trim window (seconds), reported by the source player's drag handles.
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [clipDur, setClipDur] = useState(0)

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [overwrite, setOverwrite] = useState(true)
  const [saveFolder, setSaveFolder] = useState('')
  const [saveName, setSaveName] = useState('')
  const srcPlayerRef = useRef<AudioPlayerHandle | null>(null)
  const previewPlayerRef = useRef<AudioPlayerHandle | null>(null)

  const srcUrl = useMemo(() => (target ? `/api/audio/${target.kind}/${target.id}` : ''), [target])

  const onTrimChange = useCallback((s: number, e: number, d: number) => {
    setTrimStart(s)
    setTrimEnd(e)
    setClipDur(d)
  }, [])

  // Seed the form whenever a new sample is opened.
  useEffect(() => {
    if (!open || !target) return
    setTf({ ...DEFAULT_TRANSFORM })
    setIsolate(false)
    setTrimSil(false)
    setNormalize(false)
    setDereverb(false)
    setGain(0)
    setSpeed(1)
    setTrimStart(0)
    setTrimEnd(0)
    setClipDur(0)
    setOverwrite(true)
    setSaveFolder(target.folder || '')
    setSaveName(leaf(target.name))
    setPreviewUrl(null)
  }, [open, target])

  if (!target) return null

  const kindLabel = target.kind === 'voice' ? 'voice' : 'sound'
  const libLabel = target.kind === 'voice' ? 'voice library' : 'sound library'
  const hasTrim = trimStart > 0.02 || (clipDur > 0 && trimEnd < clipDur - 0.02)
  const tfActive = transformActive(tf)
  const edited = isolate || trimSil || normalize || dereverb || Math.abs(gain) > 0.01 || Math.abs(speed - 1) > 0.01 || hasTrim || tfActive

  const composedSaveAs = () => {
    const nm = (saveName.trim() || leaf(target.name)).replace(/\//g, '-')
    return saveFolder ? `${saveFolder}/${nm}` : nm
  }

  const cleanupFields = () => ({
    isolate,
    trim: trimSil,
    normalize,
    dereverb,
    dereverb_method: dereverbMethod,
    gain_db: gain,
    speed,
    trim_start: hasTrim ? trimStart : 0,
    trim_end: hasTrim && trimEnd < clipDur - 0.02 ? trimEnd : 0,
    transforms: tf,
  })

  const voiceBody = (): ProcessVoiceBody => ({
    source: target.id,
    is_upload: false,
    ...cleanupFields(),
    overwrite,
    save_as: composedSaveAs(),
  })

  const soundBody = (): SoundTransformBody => ({
    id: target.id,
    ...cleanupFields(),
    overwrite,
    save_as: composedSaveAs(),
  })

  const runPreview = async (): Promise<string | null> => {
    setBusy(true)
    try {
      const res = target.kind === 'voice' ? await api.previewVoice(voiceBody()) : await api.previewSound(soundBody())
      const u = `${res.audio_url}?t=${Date.now()}`
      setPreviewUrl(u)
      return u
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Preview failed', 'error')
      return null
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!overwrite && !saveName.trim()) return notify('Enter a name to save a copy', 'error')
    setBusy(true)
    try {
      const desc = target.kind === 'voice'
        ? await api.processVoice(voiceBody())
        : await api.transformSound(soundBody())
      notify(`${overwrite ? 'Overwrote' : 'Saved'} “${desc.name}” in the ${libLabel}`, 'success')
      onSaved()
      onClose()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Save failed', 'error')
      setBusy(false)
    }
  }

  // Export the edited result to disk in the configured MP3/FLAC format. Renders
  // the edit first (if needed) so the download matches what you'd save; with no
  // edits it just transcodes the original.
  const download = async () => {
    setBusy(true)
    try {
      let url = previewUrl
      if (!url && edited) url = await runPreview()
      if (!url) {
        await downloadFile(`/api/${target.kind}/${target.id}/download`, leaf(target.name))
        return
      }
      const wav = await (await fetch(url)).blob()
      const fd = new FormData()
      fd.append('file', wav, 'edit.wav')
      fd.append('name', saveName.trim() || leaf(target.name))
      const res = await fetch('/api/audio/encode', { method: 'POST', body: fd })
      if (!res.ok) throw new Error('Download failed')
      const cd = res.headers.get('Content-Disposition') || ''
      const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = m ? decodeURIComponent(m[1]) : `${saveName.trim() || leaf(target.name)}.wav`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Download failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolModal
      open={open}
      title={
        <span>
          🎚 Edit {kindLabel} — <span style={{ opacity: 0.8 }}>{leaf(target.name)}</span>
        </span>
      }
      width={660}
      onClose={onClose}
      onSpace={() => (previewUrl ? previewPlayerRef.current?.toggle() : srcPlayerRef.current?.toggle())}
    >
      <div className="section-title">1 · Trim &amp; audition</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Drag the start/end handles to clip off bad heads/tails — the selected window is what gets processed and saved.
      </p>
      <AudioPlayer
        key={srcUrl}
        ref={srcPlayerRef}
        url={srcUrl}
        autoPlay={false}
        showDownload={false}
        onTrimChange={onTrimChange}
      />

      <div className="divider" />
      <div className="section-title">2 · Cleanup</div>
      <div className="row wrap" style={{ gap: 16, marginBottom: 10, alignItems: 'center' }}>
        {target.kind === 'voice' && <Toggle checked={isolate} onChange={setIsolate} label="Isolate vocals" />}
        <Toggle checked={trimSil} onChange={setTrimSil} label="Trim silence" />
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
      <Slider label="Speed" min={0.5} max={2} step={0.05} value={speed} onChange={setSpeed} format={(v) => `${v.toFixed(2)}×`} />

      <div className="divider" />
      <div className="section-title">3 · Transforms (optional)</div>
      <VocalTransforms value={tf} onChange={setTf} target="output" defaultOpen={false} title="🎚 Vocal & audio transforms" />

      <div className="divider" />
      <div className="section-title">4 · Preview &amp; save</div>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button className="btn sm" disabled={busy || !edited} onClick={() => void runPreview()} title={edited ? 'Render the cleanup + transforms and audition — nothing is saved yet' : 'Adjust a cleanup tool or transform first'}>
          {busy ? <span className="spinner sm" /> : '🎧'} Preview
        </button>
        {previewUrl && (
          <button className="btn sm ghost" disabled={busy} onClick={() => setPreviewUrl(null)} title="Audition the untouched original">
            ↩ Original
          </button>
        )}
        <span className="hint" style={{ opacity: 0.75 }}>
          {previewUrl ? '✅ auditioning the edited preview' : 'auditioning the original'}
        </span>
      </div>
      {previewUrl && (
        <AudioPlayer key={previewUrl} ref={previewPlayerRef} url={previewUrl} autoPlay showDownload={false} />
      )}

      <div className="card" style={{ marginTop: 14, padding: 12 }}>
        <label className="row" style={{ gap: 8, alignItems: 'center', marginBottom: overwrite ? 8 : 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite the existing {kindLabel} in place</span>
        </label>
        {overwrite ? (
          <div className="warn-banner">
            ⚠ This replaces <strong>{leaf(target.name)}</strong> in the {libLabel} — the original file is overwritten and
            cannot be undone.
            {target.kind === 'sound' && ' The sample is rewritten as a 24k-mono WAV.'}
          </div>
        ) : (
          <>
            <div className="field-label">Save a copy to</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="input" style={{ minWidth: 160 }} value={saveFolder} onChange={(e) => setSaveFolder(e.target.value)}>
                <option value="">📁 Library root</option>
                {folders.map((f) => (
                  <option key={f} value={f}>📁 {f}</option>
                ))}
              </select>
              <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              Saved as <code>{composedSaveAs()}</code>.
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="btn" disabled={busy} onClick={() => void download()} title="Download the edited result to disk in your configured MP3/FLAC export format">
          {busy ? <span className="spinner sm" /> : '⬇'} Download
        </button>
        <button
          className={`btn ${overwrite ? 'danger-solid' : 'good'}`}
          disabled={busy || !edited}
          onClick={() => void save()}
          title={edited ? 'Bake the edit and save into the library' : 'Adjust a cleanup tool or transform first'}
        >
          {busy ? <span className="spinner sm" /> : overwrite ? '⟳ Overwrite' : '💾 Save copy'}
        </button>
      </div>
    </ToolModal>
  )
}
