import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Job, type Plugin, type Sound } from '../api'
import ToolModal from './ToolModal'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

const fmtDur = (s?: number) => {
  if (!s || !Number.isFinite(s)) return ''
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

type RefSource = { handle: string; url: string; name: string }
type RefMode = 'guide' | 'cover'

/** Dedicated lab for the "music-generator" plug-in kind (ACE-Step).
 *
 * Flow: describe the music (+ optional lyrics) → Generate → the rendered take
 * loads into the shared waveform editor (trim / zoom / pan / speed / gain) →
 * Reroll for a fresh variation, or save into the sound library / download. An
 * optional reference track (upload or a library sound) steers generation as a
 * style hint or a structure-preserving cover. */
export function AceStepLab({
  open,
  plugin,
  onClose,
  sessionId,
  folders,
  librarySounds,
  outputFormat,
  scriptConfigured,
  scriptLabel,
  onSaved,
  notify,
}: {
  open: boolean
  plugin: Plugin | null
  onClose: () => void
  sessionId: string | null
  folders: string[]
  librarySounds: Sound[]
  outputFormat?: string
  scriptConfigured?: boolean
  scriptLabel?: string | null
  onSaved: () => void
  notify: (msg: string) => void
}) {
  const [phase, setPhase] = useState<'idle' | 'generating' | 'loaded'>('idle')
  const [progress, setProgress] = useState<Job['progress']>({})

  // Prompt + planner
  const [prompt, setPrompt] = useState('')       // the user's natural-language idea (drives SongCraft)
  const [caption, setCaption] = useState('')     // ACE-Step "style" caption (AI-written or hand-edited)
  const [lyrics, setLyrics] = useState('')
  const [instrumental, setInstrumental] = useState(false)
  const [enhance, setEnhance] = useState(true)
  const [writingLyrics, setWritingLyrics] = useState(false)

  // Settings
  const [advanced, setAdvanced] = useState(false)
  const [duration, setDuration] = useState('')   // blank = auto
  const [steps, setSteps] = useState('8')
  const [seed, setSeed] = useState('')           // blank = random
  const [bpm, setBpm] = useState('')             // blank = auto

  // Reference audio (input-music guidance)
  const [refSrc, setRefSrc] = useState<RefSource | null>(null)
  const [refMode, setRefMode] = useState<RefMode>('guide')
  const [refStrength, setRefStrength] = useState(0.7)   // cover_noise_strength — "Keep original"
  const [refCond, setRefCond] = useState(1.0)           // audio_cover_strength — "Follow source"
  const [refBusy, setRefBusy] = useState(false)
  const [refSearch, setRefSearch] = useState('')
  const [refOpen, setRefOpen] = useState(false)   // input-music section starts collapsed

  // Result / editor
  const [workingUrl, setWorkingUrl] = useState<string | null>(null)
  const [title, setTitle] = useState('track')
  const [usedSeed, setUsedSeed] = useState<number | null>(null)
  const [speed, setSpeed] = useState(1)
  const [trim, setTrim] = useState<{ start: number; end: number; dur: number } | null>(null)

  // Save / download
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

  // Reset to a clean state whenever the modal (re)opens.
  useEffect(() => {
    if (!open) return
    cancelled.current = false
    setPhase('idle')
    setProgress({})
    setPrompt('')
    setCaption('')
    setLyrics('')
    setInstrumental(false)
    setEnhance(true)
    setWritingLyrics(false)
    setAdvanced(false)
    setDuration('')
    setSteps('8')
    setSeed('')
    setBpm('')
    setRefSrc(null)
    setRefMode('guide')
    setRefStrength(0.7)
    setRefBusy(false)
    setRefSearch('')
    setRefOpen(false)
    revokeObjectUrl()
    setWorkingUrl(null)
    setTitle('track')
    setUsedSeed(null)
    setSpeed(1)
    setTrim(null)
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

  // Searchable, folder-grouped view of the sound library for the reference
  // picker. Must stay above the early return so hook order is stable.
  const refGroups = useMemo(() => {
    const q = refSearch.trim().toLowerCase()
    const matches = librarySounds.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || (s.folder || '').toLowerCase().includes(q),
    )
    const byFolder = new Map<string, Sound[]>()
    for (const s of matches) {
      const f = s.folder || ''
      if (!byFolder.has(f)) byFolder.set(f, [])
      byFolder.get(f)!.push(s)
    }
    const folders = [...byFolder.keys()].sort((a, b) => {
      if (a === '') return -1
      if (b === '') return 1
      return a.localeCompare(b)
    })
    for (const f of folders) byFolder.get(f)!.sort((a, b) => a.name.localeCompare(b.name))
    return { folders, byFolder, total: matches.length }
  }, [librarySounds, refSearch])

  if (!plugin) {
    return (
      <ToolModal open={open} title="ACE-Step" onClose={onClose} width={760}>
        <div className="empty">This plug-in isn’t available.</div>
      </ToolModal>
    )
  }

  const installed = plugin.installed
  const fmtLabel = (outputFormat || 'mp3').toUpperCase()
  const stageMsg = progress.message || progress.stage || ''

  const pickLibraryRef = (id: string) => {
    if (!id) { setRefSrc(null); return }
    const s = librarySounds.find((x) => x.id === id)
    setRefSrc({ handle: `sound:${id}`, url: `/api/audio/sound/${id}`, name: s?.name || id })
  }

  const uploadRef = async (file: File | null) => {
    if (!file) return
    setRefBusy(true)
    try {
      const r = await api.uploadPluginRef(file)
      setRefSrc({ handle: r.handle, url: r.audio_url, name: r.name })
    } catch (e) {
      notify((e as Error).message)
    } finally {
      setRefBusy(false)
    }
  }

  // SongCraft: from the user's prompt/idea (and any lyrics draft), write a full
  // song AND set the ACE-Step "style" caption from the song/vocal profile +
  // keywords — the structured guidance the model responds to well. Runs through
  // OmniVoice's Script-AI provider (host `reprompt` hook); fills the boxes so the
  // user can review & edit before generating.
  const writeLyrics = async () => {
    if (writingLyrics || phase === 'generating' || !installed) return
    if (!scriptConfigured) { notify('Set up a Script-AI provider in settings to use SongCraft.'); return }
    const idea = prompt.trim()
    const draft = lyrics.trim()
    if (!idea && !draft) { notify('Describe the song you want (or paste a rough draft) first.'); return }

    // The brief is the user's idea; fold the current style box in as direction
    // (so editing the style and re-running steers the next pass).
    const styleHint = caption.trim()
    const brief = [idea, styleHint && `Style direction: ${styleHint}`].filter(Boolean).join('\n')

    setWritingLyrics(true)
    try {
      const { job_id } = await api.pluginInvoke(plugin.id, 'write_lyrics', {
        caption: brief,
        lyrics: draft,
        instrumental,
      })
      for (;;) {
        if (cancelled.current) return
        const j = await api.job(job_id)
        if (j.status === 'done') {
          const r = (j.result || {}) as {
            title?: string; lyrics?: string; key?: string; bpm?: number
            song_profile?: string; vocal_profile?: string; tags?: string[]
          }
          if (r.lyrics) setLyrics(r.lyrics)
          if (r.title) {
            setTitle(r.title)
            if (!saveName.trim()) setSaveName(slugify(r.title) || 'track')
          }
          // Set/update the style caption from SongCraft's profile + keywords —
          // this is the guidance ACE-Step's planner keys off.
          if (r.song_profile || (r.tags && r.tags.length)) {
            const bits: string[] = []
            if (r.song_profile) bits.push(r.song_profile)
            if (r.vocal_profile) bits.push(r.vocal_profile)
            if (r.key) bits.push(`Key: ${r.key}.`)
            if (r.tags && r.tags.length) bits.push(`Style: ${r.tags.join(', ')}.`)
            if (bits.length) setCaption(bits.join(' '))
          }
          if (!bpm.trim() && typeof r.bpm === 'number' && r.bpm > 0) {
            setBpm(String(r.bpm))
            setAdvanced(true)
          }
          notify(r.title ? `SongCraft wrote “${r.title}”` : 'SongCraft updated the song')
          break
        }
        if (j.status === 'error') throw new Error(j.error || 'SongCraft failed')
        await sleep(700)
      }
    } catch (e) {
      notify(`SongCraft: ${(e as Error).message}`)
    } finally {
      setWritingLyrics(false)
    }
  }

  const runGenerate = async (forceRandomSeed: boolean) => {
    // Style is the caption; fall back to the raw idea if the user skipped it.
    const cap = caption.trim() || prompt.trim()
    const lyr = lyrics.trim()
    if (!cap && !lyr) { notify('Add a style description (or some lyrics) first.'); return }
    if (phase === 'generating' || !installed) return

    const fields: Record<string, unknown> = {
      caption: cap,
      lyrics: lyr,
      instrumental,
      enhance,
      ref_mode: refMode,
      ref_strength: refStrength,
      ref_cond_strength: refCond,
    }
    const dur = parseFloat(duration)
    if (Number.isFinite(dur) && dur > 0) fields.duration = dur
    const st = parseInt(steps, 10)
    if (Number.isFinite(st) && st > 0) fields.steps = st
    const bp = parseInt(bpm, 10)
    if (Number.isFinite(bp) && bp > 0) fields.bpm = bp
    if (forceRandomSeed) fields.seed = -1
    else {
      const sd = parseInt(seed, 10)
      if (Number.isFinite(sd)) fields.seed = sd
    }

    setPhase('generating')
    setProgress({ stage: 'queued' })
    setSaved(false)
    try {
      const { job_id } = await api.pluginGenerate(plugin.id, {
        fields,
        reprompt: false,
        save: false,
        session_id: sessionId,
        reference_audio: refSrc?.handle ?? null,
      })
      for (;;) {
        if (cancelled.current) return
        const j = await api.job(job_id)
        setProgress(j.progress || {})
        if (j.status === 'done') {
          const r = (j.result || {}) as { audio_url?: string; prompt?: string; seed?: number }
          if (!r.audio_url) throw new Error('No audio came back from generation.')
          revokeObjectUrl()
          setWorkingUrl(r.audio_url)
          const t = cap || String(r.prompt || 'track')
          setTitle(t)
          if (!saveName) setSaveName(slugify(t) || 'track')
          setUsedSeed(typeof r.seed === 'number' ? r.seed : null)
          setSpeed(1)
          setTrim(null)
          setPhase('loaded')
          break
        }
        if (j.status === 'error') throw new Error(j.error || 'Generation failed')
        await sleep(900)
      }
    } catch (e) {
      notify(`${plugin.name}: ${(e as Error).message}`)
      setPhase(workingUrl ? 'loaded' : 'idle')
    }
  }

  // Bake the current trim + gain into a new working clip ("stamp").
  const stampTrim = async () => {
    if (!previewRef.current) return
    const blob = await previewRef.current.exportBlob()
    if (!blob) { notify('The clip is still loading — try again in a moment.'); return }
    revokeObjectUrl()
    const u = URL.createObjectURL(blob)
    objectUrlRef.current = u
    setTrim(null)
    setSpeed(1)
    setWorkingUrl(u)
  }

  const renderFinalBlob = async (): Promise<Blob> => {
    const blob = await previewRef.current?.exportBlob()
    if (!blob) throw new Error('The clip is still loading — try again in a moment.')
    return blob
  }

  const cleanName = () => (saveName.trim() || slugify(title) || 'track').replace(/\//g, '-')

  const doSave = async () => {
    if (saving || !workingUrl) return
    const name = cleanName()
    setSaving(true)
    try {
      const blob = await renderFinalBlob()
      const file = new File([blob], `${name}.wav`, { type: 'audio/wav' })
      const d = await api.uploadSound(file, saveFolder)
      notify(`Saved “${d.name}” to the sound library`)
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
  const busy = phase === 'generating'

  return (
    <ToolModal open={open} title={`🎼 ${plugin.ui?.lab?.title || 'ACE-Step'}`} onClose={onClose} width={760}>
      {!installed && (
        <div className="empty" style={{ marginBottom: 12 }}>
          The {plugin.name} plug-in isn’t installed yet. Run its bootstrap script first.
        </div>
      )}

      {/* 1) Prompt / idea — drives SongCraft */}
      <label className="field-label">Prompt <span className="hint">— describe the song you want</span></label>
      <textarea
        className="input"
        rows={2}
        style={{ resize: 'vertical', width: '100%' }}
        placeholder="a melancholy late-night synthwave song about driving home alone after a breakup"
        value={prompt}
        disabled={busy}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="row" style={{ alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          style={{ whiteSpace: 'nowrap', minWidth: 188 }}
          disabled={busy || writingLyrics || !installed || !scriptConfigured || (!prompt.trim() && !lyrics.trim())}
          title={
            !scriptConfigured
              ? 'Set up a Script-AI provider in settings to use SongCraft'
              : 'Write the song + style from your prompt with SongCraft'
          }
          onClick={() => void writeLyrics()}
        >
          {writingLyrics ? '✍ Writing…' : '✨ Write with SongCraft'}
        </button>
        <span className="hint" style={{ flex: 1, minWidth: 200 }}>
          {scriptConfigured
            ? <>Writes the lyrics <b>and</b> sets the style below (song/vocal profile + keywords) from your prompt — review &amp; edit before generating{scriptLabel ? ` · via ${scriptLabel}` : ''}.</>
            : <>Configure a Script-AI provider in settings to unlock SongCraft.</>}
        </span>
      </div>

      {/* 2) Style caption — AI-written or hand-edited; this is what ACE-Step reads */}
      <label className="field-label" style={{ marginTop: 12 }}>Style / description <span className="hint">(sent to ACE-Step)</span></label>
      <textarea
        className="input"
        rows={3}
        style={{ resize: 'vertical', width: '100%' }}
        placeholder="upbeat synthwave with driving bass, bright arps, nostalgic 80s mood — or let SongCraft fill this from your prompt"
        value={caption}
        disabled={busy}
        onChange={(e) => setCaption(e.target.value)}
      />

      {/* 3) Lyrics */}
      <label className="field-label" style={{ marginTop: 10 }}>Lyrics <span className="hint">(optional)</span></label>
      <textarea
        className="input"
        rows={5}
        style={{ resize: 'vertical', width: '100%' }}
        placeholder={'[Verse 1]\n…\n[Chorus]\n…\n\nLeave blank for instrumental — or let SongCraft write them from your prompt.'}
        value={lyrics}
        disabled={busy || instrumental}
        onChange={(e) => setLyrics(e.target.value)}
      />

      <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={enhance} disabled={busy} onChange={(e) => setEnhance(e.target.checked)} />
          <span>AI enhancement</span>
        </label>
        <span className="hint">ACE-Step's own planner expands the style &amp; metadata at generate time.</span>
        <label className="row" style={{ gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <input type="checkbox" checked={instrumental} disabled={busy} onChange={(e) => setInstrumental(e.target.checked)} />
          <span>Instrumental</span>
        </label>
      </div>

      {/* 2) Reference audio (optional guidance) — collapsible: searchable library + upload */}
      <div className="card" style={{ marginTop: 12, padding: 12 }}>
        <button
          type="button"
          onClick={() => setRefOpen((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit' }}
        >
          <span className="hint">{refOpen ? '▾' : '▸'}</span>
          <div className="field-label" style={{ margin: 0 }}>Input music — guidance <span className="hint">(optional)</span></div>
          {refSrc && (
            <span className="hint" style={{ marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
              🎵 {refSrc.name}
            </span>
          )}
        </button>
        {refOpen && (!refSrc ? (
          <>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="btn ghost sm" style={{ marginLeft: 'auto', cursor: (refBusy || busy) ? 'default' : 'pointer' }}>
                {refBusy ? 'Uploading…' : '⬆ Upload a file'}
                <input
                  type="file"
                  accept="audio/*"
                  style={{ display: 'none' }}
                  disabled={refBusy || busy}
                  onChange={(e) => void uploadRef(e.target.files?.[0] || null)}
                />
              </label>
            </div>
            <input
              className="input"
              style={{ width: '100%', marginTop: 8 }}
              placeholder="🔍 Search your sound library by name or folder…"
              value={refSearch}
              disabled={busy}
              onChange={(e) => setRefSearch(e.target.value)}
            />
            <div
              style={{
                marginTop: 8, maxHeight: 220, overflowY: 'auto',
                border: '1px solid var(--border, #2a2a2a)', borderRadius: 8,
              }}
            >
              {librarySounds.length === 0 ? (
                <div className="empty" style={{ padding: 12 }}>Your sound library is empty — upload a file above instead.</div>
              ) : refGroups.total === 0 ? (
                <div className="empty" style={{ padding: 12 }}>No sounds match “{refSearch.trim()}”.</div>
              ) : (
                refGroups.folders.map((f) => (
                  <div key={f || '__root__'}>
                    <div
                      className="hint"
                      style={{ padding: '4px 10px', position: 'sticky', top: 0, background: 'var(--panel, #1b1b1b)', fontWeight: 600 }}
                    >
                      📁 {f || 'Library root'}
                    </div>
                    {refGroups.byFolder.get(f)!.map((s) => (
                      <button
                        key={s.id}
                        className="btn ghost"
                        style={{ display: 'flex', width: '100%', textAlign: 'left', gap: 8, alignItems: 'center', padding: '6px 10px', borderRadius: 0 }}
                        disabled={busy}
                        title={`Use “${s.name}” as the reference`}
                        onClick={() => pickLibraryRef(s.id)}
                      >
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>🎵 {s.name}</span>
                        {s.duration_s ? <span className="hint">{fmtDur(s.duration_s)}</span> : null}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {refGroups.total > 0
                ? `${refGroups.total} of ${librarySounds.length} sound${librarySounds.length === 1 ? '' : 's'} — click one to steer the result toward its style (or cover it). Leave empty for pure text-to-music.`
                : 'Pick a library sound or upload a file to steer the result. Leave empty for pure text-to-music.'}
            </div>
          </>
        ) : (
          <>
            <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 4 }}>
              <span>🎵 <b>{refSrc.name}</b></span>
              <audio src={refSrc.url} controls style={{ height: 30, marginLeft: 'auto' }} />
              <button className="btn ghost sm" disabled={busy} onClick={() => setRefSrc(null)}>Clear</button>
            </div>
            <div className="row" style={{ gap: 12, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span className="hint">Mode</span>
                <select className="input" value={refMode} disabled={busy} onChange={(e) => setRefMode(e.target.value as RefMode)}>
                  <option value="guide">Style hint</option>
                  <option value="cover">Cover (keep structure)</option>
                </select>
              </label>
              {refMode === 'cover' && (
                <>
                  <label className="row" style={{ gap: 6, alignItems: 'center', flex: 1, minWidth: 180 }}>
                    <span className="hint">Keep original · {refStrength.toFixed(2)}</span>
                    <input type="range" min={0.1} max={1} step={0.05} value={refStrength} disabled={busy} onChange={(e) => setRefStrength(parseFloat(e.target.value))} style={{ flex: 1 }} />
                  </label>
                  <label className="row" style={{ gap: 6, alignItems: 'center', flex: 1, minWidth: 180 }}>
                    <span className="hint">Follow source · {refCond.toFixed(2)}</span>
                    <input type="range" min={0} max={1} step={0.05} value={refCond} disabled={busy} onChange={(e) => setRefCond(parseFloat(e.target.value))} style={{ flex: 1 }} />
                  </label>
                </>
              )}
            </div>
            {refMode === 'cover' && (
              <div className="hint" style={{ marginTop: 6 }}>
                <b>Keep original</b>: how much of the source's structure the diffusion starts from (higher = closer, artifacty at the top).
                {' '}<b>Follow source</b>: how long the source's content guides before the description takes over (lower = more creative drift).
                {' '}Strong covers like a few more <b>Steps</b> below.
              </div>
            )}
          </>
        ))}
      </div>

      {/* 3) Settings */}
      <div className="card" style={{ marginTop: 12, padding: 12 }}>
        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="hint">Duration (s)</span>
            <input className="input" style={{ width: 80 }} placeholder="auto" value={duration} disabled={busy} onChange={(e) => setDuration(e.target.value)} />
          </label>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="hint">Steps</span>
            <input className="input" style={{ width: 64 }} value={steps} disabled={busy} onChange={(e) => setSteps(e.target.value)} />
          </label>
          <button className="btn ghost sm" onClick={() => setAdvanced(!advanced)}>{advanced ? '▾' : '▸'} Advanced</button>
          {advanced && (
            <>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span className="hint">BPM</span>
                <input className="input" style={{ width: 64 }} placeholder="auto" value={bpm} disabled={busy} onChange={(e) => setBpm(e.target.value)} />
              </label>
              <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span className="hint">Seed</span>
                <input className="input" style={{ width: 110 }} placeholder="random" value={seed} disabled={busy} onChange={(e) => setSeed(e.target.value)} />
              </label>
            </>
          )}
        </div>
      </div>

      {/* Generate */}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={busy || writingLyrics || !installed || (!caption.trim() && !lyrics.trim() && !prompt.trim())} onClick={() => void runGenerate(false)}>
          {busy ? `Generating… ${stageMsg}` : '✨ Generate'}
        </button>
        {phase === 'loaded' && (
          <button className="btn" disabled={busy} title="Generate a fresh variation on the same prompt" onClick={() => void runGenerate(true)}>
            🎲 Reroll
          </button>
        )}
      </div>

      {/* 4) Editor + save */}
      {phase === 'loaded' && workingUrl && (
        <>
          <div className="card" style={{ marginTop: 14, padding: 12 }}>
            <div className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
              <div className="field-label" style={{ margin: 0 }}>{title}</div>
              {usedSeed != null && <span className="hint" style={{ marginLeft: 'auto' }}>seed {usedSeed}</span>}
            </div>
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
              <input type="range" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} style={{ flex: 1 }} />
              {Math.abs(speed - 1) > 0.01 && <button className="btn ghost sm" onClick={() => setSpeed(1)}>Reset</button>}
            </div>
            {trimmed && (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm good" title="Cut the clip to the trim lines — the cut becomes the new working clip." onClick={() => void stampTrim()}>
                  ✂ Stamp trim ({trim!.start.toFixed(2)}s – {trim!.end.toFixed(2)}s)
                </button>
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 12, padding: 12 }}>
            <div className="field-label">Save to sound library</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="input" style={{ minWidth: 160 }} value={saveFolder} onChange={(e) => setSaveFolder(e.target.value)}>
                <option value="">📁 Library root</option>
                {folders.map((f) => (
                  <option key={f} value={f}>📁 {f}</option>
                ))}
              </select>
              <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="filename" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
              <button className="btn primary" disabled={saving || downloading} onClick={() => void doSave()}>
                {saving ? 'Saving…' : saved ? '✓ Save Audio' : '💾 Save Audio'}
              </button>
              <button className="btn" disabled={saving || downloading} onClick={() => void doDownload()} title={`Download in the configured format (${fmtLabel})`}>
                {downloading ? '…' : `⬇ ${fmtLabel}`}
              </button>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              Saved as <code>{(saveFolder ? saveFolder + '/' : '') + cleanName()}</code>.
            </div>
          </div>
        </>
      )}
    </ToolModal>
  )
}
