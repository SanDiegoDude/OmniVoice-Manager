import { useEffect, useRef, useState } from 'react'
import { api, type Job, type Plugin } from '../api'
import ToolModal from './ToolModal'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

type Library = 'voice' | 'sound'

/** Dedicated lab for the "url-clipper" plug-in kind (Clip Grabber).
 *
 * Flow: paste a URL → Fetch (the sidecar runs yt-dlp and hands back a decoded
 * WAV) → the audio loads into the shared waveform editor (trim / zoom / pan /
 * gain) → optional cleanup (isolation / de-reverb / normalize / edge trim, run
 * host-side on the *trimmed* clip) → save into the library this lab was launched
 * from, or download in the configured format. The library target is fixed by
 * the launch section, so there's one Save button labelled for it. */
export function ClipGrabberLab({
  open,
  plugin,
  onClose,
  sessionId,
  folders,
  voiceFolders,
  defaultLibrary = 'voice',
  outputFormat,
  onSaved,
  notify,
}: {
  open: boolean
  plugin: Plugin | null
  onClose: () => void
  sessionId: string | null
  folders: string[]
  voiceFolders: string[]
  defaultLibrary?: Library
  outputFormat?: string
  onSaved: () => void
  notify: (msg: string) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'fetching' | 'loaded'>('idle')
  const [url, setUrl] = useState('')
  const [progress, setProgress] = useState<Job['progress']>({})
  const [workingUrl, setWorkingUrl] = useState<string | null>(null)
  const [title, setTitle] = useState('clip')
  const [speed, setSpeed] = useState(1)
  const [trim, setTrim] = useState<{ start: number; end: number; dur: number } | null>(null)

  // Output (post-processing) options — applied host-side to the trimmed clip.
  const [isolate, setIsolate] = useState(true)
  const [normalize, setNormalize] = useState(true)
  const [trimSilence, setTrimSilence] = useState(true)
  const [dereverb, setDereverb] = useState(false)
  const [dereverbMethod, setDereverbMethod] = useState<'roformer' | 'deepfilternet'>('roformer')
  const [advanced, setAdvanced] = useState(false)

  const [saveFolder, setSaveFolder] = useState('')
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [saved, setSaved] = useState(false)

  const previewRef = useRef<AudioPlayerHandle | null>(null)
  const cancelled = useRef(false)
  const objectUrlRef = useRef<string | null>(null)

  const revokeObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }

  // Reset to a clean URL-only state whenever the modal (re)opens.
  useEffect(() => {
    if (!open) return
    cancelled.current = false
    setPhase('idle')
    setUrl('')
    setProgress({})
    revokeObjectUrl()
    setWorkingUrl(null)
    setTitle('clip')
    setSpeed(1)
    setTrim(null)
    setIsolate(true)
    setNormalize(true)
    setTrimSilence(true)
    setDereverb(false)
    setDereverbMethod('roformer')
    setAdvanced(false)
    setSaveFolder('')
    setSaveName('')
    setSaving(false)
    setDownloading(false)
    setSaved(false)
    return () => {
      cancelled.current = true
      revokeObjectUrl()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plugin?.id])

  if (!plugin) {
    return (
      <ToolModal open={open} title="Clip Grabber" onClose={onClose} width={720}>
        <div className="empty">This plug-in isn’t available.</div>
      </ToolModal>
    )
  }

  const installed = plugin.installed
  const targetFolders = defaultLibrary === 'voice' ? voiceFolders : folders
  const saveLabel = defaultLibrary === 'voice' ? 'Save Voice' : 'Save Audio'
  const fmtLabel = (outputFormat || 'mp3').toUpperCase()
  const anyCleanup = isolate || normalize || trimSilence || dereverb

  const doFetch = async () => {
    const u = url.trim()
    if (!u || phase === 'fetching' || !installed) return
    setPhase('fetching')
    setProgress({ stage: 'queued' })
    setSaved(false)
    try {
      const { job_id } = await api.pluginGenerate(plugin.id, {
        fields: { url: u },
        reprompt: false,
        save: false,
        session_id: sessionId,
      })
      for (;;) {
        if (cancelled.current) return
        const j = await api.job(job_id)
        setProgress(j.progress || {})
        if (j.status === 'done') {
          const r = (j.result || {}) as { audio_url?: string; source_title?: string; prompt?: string }
          if (!r.audio_url) throw new Error('No audio came back from the fetch.')
          revokeObjectUrl()
          setWorkingUrl(r.audio_url)
          const t = String(r.source_title || r.prompt || 'clip')
          setTitle(t)
          setSaveName(slugify(t) || 'clip')
          setSpeed(1)
          setTrim(null)
          setPhase('loaded')
          break
        }
        if (j.status === 'error') throw new Error(j.error || 'Fetch failed')
        await sleep(700)
      }
    } catch (e) {
      notify(`${plugin.name}: ${(e as Error).message}`)
      setPhase('idle')
    }
  }

  // Bake the current trim + gain into a new working clip ("stamp"): the cut
  // becomes the source of truth so further edits (and cleanup) act on it.
  const stampTrim = async () => {
    if (!previewRef.current) return
    const blob = await previewRef.current.exportBlob()
    if (!blob) {
      notify('The clip is still loading — try again in a moment.')
      return
    }
    revokeObjectUrl()
    const u = URL.createObjectURL(blob)
    objectUrlRef.current = u
    setTrim(null)
    setSpeed(1)
    setWorkingUrl(u)
  }

  // The final clip bytes to save/download: the trimmed + gained region, then
  // (if any cleanup is on) run through the host's clean pipeline on the trim.
  const renderFinalBlob = async (): Promise<Blob> => {
    const blob = await previewRef.current?.exportBlob()
    if (!blob) throw new Error('The clip is still loading — try again in a moment.')
    if (!anyCleanup) return blob
    const up = await api.uploadVoice(new File([blob], 'clip.wav', { type: 'audio/wav' }))
    const cleaned = await api.previewVoice({
      source: up.upload_id,
      is_upload: true,
      save_as: '_clip',
      isolate,
      normalize,
      trim: trimSilence,
      dereverb,
      dereverb_method: dereverbMethod,
      gain_db: 0,
      trim_start: 0,
      trim_end: 0,
    })
    const res = await fetch(cleaned.audio_url)
    if (!res.ok) throw new Error('Cleanup failed')
    return await res.blob()
  }

  const cleanName = () => (saveName.trim() || slugify(title) || 'clip').replace(/\//g, '-')

  const doSave = async () => {
    if (saving || !workingUrl) return
    const name = cleanName()
    const path = saveFolder ? `${saveFolder}/${name}` : name
    setSaving(true)
    try {
      const blob = await renderFinalBlob()
      const file = new File([blob], `${name}.wav`, { type: 'audio/wav' })
      if (defaultLibrary === 'voice') {
        const up = await api.uploadVoice(file)
        const d = await api.importTempVoice(up.upload_id, path)
        notify(`Saved “${d.name}” to the voice library`)
      } else {
        const d = await api.uploadSound(file, saveFolder)
        notify(`Saved “${d.name}” to the sound library`)
      }
      setSaved(true)
      onSaved()
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const doDownload = async () => {
    if (downloading || !workingUrl) return
    const name = cleanName()
    setDownloading(true)
    try {
      const blob = await renderFinalBlob()
      const enc = await api.encodeAudio(blob, name)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(enc.blob)
      a.download = enc.filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setDownloading(false)
    }
  }

  const trimmed = !!trim && (trim.start > 0.02 || trim.end < trim.dur - 0.02)
  const stageMsg = progress.message || progress.stage || ''

  return (
    <ToolModal open={open} title={`🎬 ${plugin.ui?.lab?.title || 'Clip Grabber'}`} onClose={onClose} width={720}>
      {!installed && (
        <div className="empty" style={{ marginBottom: 12 }}>
          The {plugin.name} plug-in isn’t installed yet. Run its bootstrap script first.
        </div>
      )}

      {/* 1) URL bar + Fetch */}
      <label className="field-label">Video / audio URL</label>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="https://… (YouTube or any yt-dlp-supported site)"
          value={url}
          disabled={phase === 'fetching'}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doFetch() }}
        />
        <button
          className="btn primary"
          disabled={phase === 'fetching' || !url.trim() || !installed}
          onClick={() => void doFetch()}
        >
          {phase === 'fetching' ? `Fetching… ${stageMsg}` : '⬇ Fetch Content'}
        </button>
      </div>
      {phase === 'idle' && (
        <div className="hint" style={{ marginTop: 6 }}>
          We grab the audio track only (video frames are dropped) and load it into the editor below.
        </div>
      )}

      {/* 2) Editor + speed/gain + stamp trim */}
      {phase === 'loaded' && workingUrl && (
        <>
          <div className="card" style={{ marginTop: 14, padding: 12 }}>
            <div className="field-label" style={{ marginBottom: 6 }}>{title}</div>
            <AudioPlayer
              key={workingUrl}
              ref={previewRef}
              url={workingUrl}
              autoPlay={false}
              showDownload={false}
              playbackRate={speed}
              filename={`${cleanName()}.wav`}
              onTrimChange={(start, end, dur) => setTrim({ start, end, dur })}
            />
            <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
              <span className="hint">Speed · {speed.toFixed(2)}×</span>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                style={{ flex: 1 }}
              />
              {Math.abs(speed - 1) > 0.01 && <button className="btn ghost sm" onClick={() => setSpeed(1)}>Reset</button>}
            </div>
            {trimmed && (
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn sm good"
                  title="Cut the clip to the trim lines for real — the cut becomes the new working clip."
                  onClick={() => void stampTrim()}
                >
                  ✂ Stamp trim ({trim!.start.toFixed(2)}s – {trim!.end.toFixed(2)}s)
                </button>
              </div>
            )}
          </div>

          {/* 3) Output — cleanup applied to the trimmed clip */}
          <div className="card" style={{ marginTop: 12, padding: 12 }}>
            <div className="field-label">Output — clean up the trimmed clip</div>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
                <span>Vocal isolation</span>
              </label>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={dereverb} onChange={(e) => setDereverb(e.target.checked)} />
                <span>De-reverb</span>
              </label>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
                <span>Normalize</span>
              </label>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={trimSilence} onChange={(e) => setTrimSilence(e.target.checked)} />
                <span>Trim edge silence</span>
              </label>
            </div>
            {dereverb && (
              <div style={{ marginTop: 8 }}>
                <button className="btn ghost sm" onClick={() => setAdvanced(!advanced)}>{advanced ? '▾' : '▸'} Advanced</button>
                {advanced && (
                  <label className="row" style={{ gap: 6, alignItems: 'center', marginTop: 8 }}>
                    <span className="hint">De-reverb model</span>
                    <select className="input" value={dereverbMethod} onChange={(e) => setDereverbMethod(e.target.value as 'roformer' | 'deepfilternet')}>
                      <option value="roformer">roformer</option>
                      <option value="deepfilternet">deepfilternet</option>
                    </select>
                  </label>
                )}
              </div>
            )}
            {!anyCleanup && <div className="hint" style={{ marginTop: 6 }}>No cleanup — the trimmed clip is saved as-is.</div>}
          </div>

          {/* 4) Save / download */}
          <div className="card" style={{ marginTop: 12, padding: 12 }}>
            <div className="field-label">Save to {defaultLibrary === 'voice' ? 'voice' : 'sound'} library</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="input" style={{ minWidth: 160 }} value={saveFolder} onChange={(e) => setSaveFolder(e.target.value)}>
                <option value="">📁 Library root</option>
                {targetFolders.map((f) => (
                  <option key={f} value={f}>📁 {f}</option>
                ))}
              </select>
              <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="filename" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
              <button className="btn primary" disabled={saving || downloading} onClick={() => void doSave()}>
                {saving ? 'Saving…' : saved ? `✓ ${saveLabel}` : `💾 ${saveLabel}`}
              </button>
              <button className="btn" disabled={saving || downloading} onClick={() => void doDownload()} title={`Download in the configured format (${fmtLabel})`}>
                {downloading ? '…' : `⬇ ${fmtLabel}`}
              </button>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {anyCleanup ? 'Cleanup runs on the trimmed clip before saving. ' : ''}
              Saved as <code>{(saveFolder ? saveFolder + '/' : '') + cleanName()}</code>.
            </div>
          </div>
        </>
      )}
    </ToolModal>
  )
}
