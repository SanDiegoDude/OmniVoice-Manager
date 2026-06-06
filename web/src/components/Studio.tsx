import { useEffect, useRef, useState } from 'react'
import type { GenParams, GenerateBody, Job, MultitrackSession, Provider, SpeakerConfig, Voice } from '../api'
import { AudioPlayer } from './AudioPlayer'
import { MultitrackEditor } from './MultitrackEditor'
import { SpeakerCard } from './SpeakerCard'
import { Collapsible, Slider, Toggle } from './ui'
import { blurTag, focusTag } from '../tagInject'

const defaultSpeaker = (): SpeakerConfig => ({
  mode: 'clone',
  voice: null,
  ref_text: '',
  instruct: '',
  language: null,
  isolate: true,
  normalize: true,
  dereverb: false,
  dereverb_method: 'roformer',
})

const defaultParams: GenParams = {
  num_step: 32,
  guidance_scale: 2.0,
  speed: 1.0,
  duration: null,
  denoise: true,
  t_shift: 0.1,
  preprocess_prompt: true,
  postprocess_output: true,
  gap_ms: 250,
  match_loudness: true,
  target_lufs: -20.0,
  peak_ceiling_db: -1.0,
}

export interface Injected {
  nonce: number
  script: string
  prompt?: string
  title?: string
  multi_speaker?: boolean
  num_speakers?: number
  speakers?: Record<string, SpeakerConfig>
  params?: GenParams
}

export function Studio({
  voices,
  job,
  scriptBusy,
  injected,
  providers,
  activeProvider,
  session,
  regenIndex,
  finalizing,
  onSelectProvider,
  onReloadProviders,
  onGenerate,
  onGenerateScript,
  onLucky,
  onRegenSegment,
  onEditSegment,
  onReflow,
  onInsertSegment,
  onEnsureSession,
  onAddSpeaker,
  onUpdateSpeaker,
  onRemoveSpeaker,
  onDeleteSegment,
  onSplitSegment,
  onDeleteSpace,
  onAddSpace,
  onDuplicateSegment,
  onSetSegmentText,
  onTranscribeSegment,
  onSetChannel,
  onRegenChannel,
  onUploadChannel,
  onAutoSlice,
  onSetInpaint,
  onPromoteChannel,
  onUndo,
  onFinalize,
  notify,
}: {
  voices: Voice[]
  job: Job | null
  scriptBusy: boolean
  injected: Injected
  providers: Provider[]
  activeProvider: string | null
  session: MultitrackSession | null
  regenIndex: number | null
  finalizing: boolean
  onSelectProvider: (id: string) => void
  onReloadProviders: () => void
  onGenerate: (body: GenerateBody, title: string, multitrack?: boolean) => void
  onGenerateScript: (prompt: string, numSpeakers: number, speakers: SpeakerConfig[], existing: string) => Promise<{ title: string; script: string } | null>
  onLucky: (body: GenerateBody, title: string, multitrack?: boolean) => void
  onRegenSegment: (index: number, text?: string) => void
  onEditSegment: (index: number, fields: { start_s?: number; trim_start_s?: number; trim_end_s?: number; speed?: number; gain_db?: number }) => void
  onReflow: (fields: { gap_ms?: number; speed?: number }) => void
  onInsertSegment: (speakerId: string, text: string, startS: number, ripple: boolean) => void
  onEnsureSession: (speakers: Record<string, SpeakerConfig>, params: GenParams) => void
  onAddSpeaker: (cfg: SpeakerConfig) => void
  onUpdateSpeaker: (pos: string, cfg: SpeakerConfig) => void
  onRemoveSpeaker: (pos: string) => void
  onDeleteSegment: (index: number, ripple: boolean) => void
  onSplitSegment: (index: number, atS: number) => void
  onDeleteSpace: (startS: number, amount: number) => void
  onAddSpace: (startS: number, amount: number) => void
  onDuplicateSegment: (index: number, startS: number, ripple: boolean) => void
  onSetSegmentText: (index: number, text: string) => void
  onTranscribeSegment: (index: number, draft?: { trim_start_s?: number; trim_end_s?: number; speed?: number }) => Promise<string | null | undefined>
  onSetChannel: (pos: string, fields: { name?: string | null; gain_db?: number }) => void
  onRegenChannel: (pos: string) => void
  onUploadChannel: (file: File, name: string) => void
  onAutoSlice: (index: number) => Promise<void>
  onSetInpaint: (index: number, enabled: boolean) => Promise<void>
  onPromoteChannel: (pos: string, name: string) => Promise<MultitrackSession | null>
  onUndo: () => void
  onFinalize: () => void
  notify: (m: string, k?: 'info' | 'error' | 'success') => void
}) {
  const [mode, setMode] = useState<'single' | 'multi'>('single')
  const [speakers, setSpeakers] = useState<SpeakerConfig[]>([defaultSpeaker(), defaultSpeaker()])
  const [script, setScript] = useState('')
  const [title, setTitle] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [params, setParams] = useState<GenParams>(defaultParams)
  const [showSettings, setShowSettings] = useState(false)
  const [multitrack, setMultitrack] = useState(true)

  useEffect(() => {
    if (injected.nonce > 0) {
      setScript(injected.script)
      if (injected.prompt !== undefined) setAiPrompt(injected.prompt)
      if (injected.title) setTitle(injected.title)
      const keys = injected.speakers ? Object.keys(injected.speakers) : []
      const n = Math.max(1, injected.num_speakers || keys.length || 1)
      // Prefer explicit multi_speaker flag; fall back to speaker count for old entries.
      if (injected.multi_speaker !== undefined) setMode(injected.multi_speaker ? 'multi' : 'single')
      else if (injected.num_speakers) setMode(injected.num_speakers > 1 ? 'multi' : 'single')
      // Rebuild the speaker list to exactly N, restoring per-speaker configs ("1".."n").
      if (keys.length || injected.num_speakers) {
        setSpeakers((prev) => {
          const arr: SpeakerConfig[] = Array.from({ length: n }, (_, i) => prev[i] ?? defaultSpeaker())
          if (injected.speakers) {
            Object.entries(injected.speakers).forEach(([key, cfg]) => {
              const i = parseInt(key, 10) - 1
              if (i >= 0 && i < arr.length) arr[i] = { ...defaultSpeaker(), ...cfg }
            })
          }
          return arr
        })
      }
      // Restore generation settings, merged over defaults for forward-compat.
      if (injected.params) setParams({ ...defaultParams, ...injected.params })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injected.nonce])

  const count = mode === 'multi' ? speakers.length : 1
  const activeSpeakers = mode === 'multi' ? speakers : speakers.slice(0, 1)

  const speakerMap = (): Record<string, SpeakerConfig> => {
    const m: Record<string, SpeakerConfig> = {}
    activeSpeakers.forEach((s, i) => {
      m[String(i + 1)] = s
    })
    return m
  }

  // Show a blank multitrack skeleton the moment Multi-speaker is active, so a
  // scene can be composed by hand (or from a script). The roster stays in lockstep
  // with the session's tracks via add/remove/update below.
  const liveSync = mode === 'multi' && !!session
  useEffect(() => {
    if (mode === 'multi' && !session) onEnsureSession(speakerMap(), params)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, session])

  const updTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const setSpeaker = (i: number, c: SpeakerConfig) => {
    const next = [...speakers]
    next[i] = c
    setSpeakers(next)
    if (liveSync) {
      const pos = String(i + 1)
      clearTimeout(updTimers.current[pos])
      updTimers.current[pos] = setTimeout(() => onUpdateSpeaker(pos, c), 450)
    }
  }

  // Rebuild the multi-speaker script from the live timeline, ALWAYS ordered by
  // start time (so newly added / overlapping / promoted clips land in the right
  // place, not lazily at the end). `override` lets an in-flight edit show before
  // the session round-trips. Empty lines (e.g. untranscribed audio) are dropped.
  const scriptFromSession = (s: MultitrackSession, override?: { index: number; text: string }) =>
    s.tracks
      .flatMap((t) => t.segments)
      .slice()
      .sort((a, b) => a.start_s - b.start_s || a.index - b.index)
      .map((seg) => ({ id: seg.speaker_id, text: override && override.index === seg.index ? override.text : seg.text }))
      .filter((x) => x.text && x.text.trim())
      .map((x) => `Speaker ${x.id}: ${x.text.trim()}`)
      .join('\n')

  // Regenerate a segment; if the dialogue was edited, keep the script in sync.
  const handleRegen = (index: number, text?: string) => {
    if (text !== undefined && session) setScript(scriptFromSession(session, { index, text }))
    onRegenSegment(index, text)
  }

  // Align a segment's text to its audio (manual edit in trim panel / Whisper).
  // Persists without flagging regen, and keeps the script section in sync.
  const handleSetText = (index: number, text: string) => {
    if (session) setScript(scriptFromSession(session, { index, text }))
    onSetSegmentText(index, text)
  }

  // Manual "Sync dialogue from Editor" — pull every clip's current dialogue into
  // the script box, in timeline order, without re-running Whisper.
  const syncScriptFromEditor = () => {
    if (session) setScript(scriptFromSession(session))
  }

  // Promote an uploaded audio channel into a generative speaker. Promotion adds a
  // real speaker slot on the backend, so grow the roster to match (keeps the
  // multi-speaker menu and the editor's track count in lockstep).
  const handlePromote = async (pos: string, name: string) => {
    const s = await onPromoteChannel(pos, name)
    if (s) {
      const genCount = s.tracks.filter((t) => t.kind !== 'audio').length
      setSpeakers((prev) =>
        genCount > prev.length ? [...prev, ...Array.from({ length: genCount - prev.length }, () => defaultSpeaker())] : prev,
      )
    }
    return s
  }

  const addSpeaker = () => {
    const cfg = defaultSpeaker()
    setSpeakers((prev) => [...prev, cfg])
    if (liveSync) onAddSpeaker(cfg)
  }
  const removeSpeaker = (i: number) =>
    setSpeakers((prev) => {
      if (prev.length <= 1) return prev
      if (liveSync) onRemoveSpeaker(String(i + 1))
      return prev.filter((_, idx) => idx !== i)
    })

  const buildBody = (): GenerateBody => {
    const speakerMap: Record<string, SpeakerConfig> = {}
    activeSpeakers.forEach((s, i) => {
      speakerMap[String(i + 1)] = s
    })
    return {
      multi_speaker: mode === 'multi',
      num_speakers: count,
      script: script,
      text: mode === 'single' ? script : null,
      speakers: speakerMap,
      params,
      title: title || 'Untitled Scene',
      prompt: aiPrompt || undefined,
      save: true,
    }
  }

  async function handleScript() {
    if (!aiPrompt.trim()) return notify('Enter an idea for the AI to write', 'error')
    const res = await onGenerateScript(aiPrompt, count, activeSpeakers, script)
    if (res) {
      setScript(res.script)
      setTitle(res.title)
    }
  }

  async function handleLucky() {
    if (!aiPrompt.trim()) return notify('Enter an idea first', 'error')
    const res = await onGenerateScript(aiPrompt, count, activeSpeakers, script)
    if (res) {
      setScript(res.script)
      setTitle(res.title)
      const body = buildBody()
      body.script = res.script
      body.text = mode === 'single' ? res.script : null
      body.title = res.title
      onLucky(body, res.title, useMultitrack)
    }
  }

  // Multitrack is a multi-speaker-only workflow; single voice always renders a
  // normal one-shot output (the toggle is hidden in single mode).
  const useMultitrack = mode === 'multi' && multitrack

  const running = job?.status === 'running' || job?.status === 'queued'
  const prog = job?.progress
  const audioUrl = job?.status === 'done' ? job.result?.audio_url : null

  return (
    <div className="col-scroll" style={{ flex: 1 }}>
      {/* Speakers */}
      <Collapsible className="card" title="🎤 Speakers">
        <div className="flex-between" style={{ marginBottom: 12 }}>
          <div className="segment">
            <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
              Single voice
            </button>
            <button className={mode === 'multi' ? 'active' : ''} onClick={() => setMode('multi')}>
              Multi-speaker
            </button>
          </div>
          {mode === 'multi' && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="hint">{speakers.length} speakers</span>
              <button className="btn ghost sm" onClick={addSpeaker} title="Add a speaker">
                + Add speaker
              </button>
            </div>
          )}
        </div>
        <div className="speakers">
          {activeSpeakers.map((s, i) => (
            <SpeakerCard
              key={i}
              index={i + 1}
              config={s}
              voices={voices}
              onChange={(c) => setSpeaker(i, c)}
              onRemove={mode === 'multi' && speakers.length > 1 ? () => removeSpeaker(i) : undefined}
            />
          ))}
          {mode === 'multi' && (
            <button className="btn ghost add-speaker-tile" onClick={addSpeaker}>
              + Add speaker
            </button>
          )}
        </div>
      </Collapsible>

      {/* AI prompt */}
      <Collapsible className="card" title="✨ Smart Script">
        <div className="flex-between" style={{ marginBottom: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>✨ Smart Script — describe what you want</div>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>AI:</span>
            <select
              className="input"
              style={{ maxWidth: 220, padding: '4px 8px' }}
              value={activeProvider ?? ''}
              onChange={(e) => onSelectProvider(e.target.value)}
              disabled={providers.length === 0}
              title="Pick which provider writes the script (configured in .env)"
            >
              {providers.length === 0 && <option value="">No providers in .env</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.has_key}>
                  {p.label}
                  {p.has_key ? '' : ' (no key)'}
                </option>
              ))}
            </select>
            <button
              className="btn ghost"
              style={{ padding: '4px 8px' }}
              onClick={onReloadProviders}
              title="Re-read providers from .env without restarting"
            >
              ⟳
            </button>
          </div>
        </div>
        <textarea
          className="input"
          rows={2}
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          placeholder="e.g. A witty debate between a cat and a dog about who is smarter, 6 lines."
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={handleScript} disabled={scriptBusy}>
            {scriptBusy ? <span className="spinner" /> : '✍'} Write script
          </button>
          <button className="btn lucky" onClick={handleLucky} disabled={scriptBusy || running}>
            🍀 Feeling lucky (write + speak)
          </button>
        </div>
      </Collapsible>

      {/* Script editor */}
      <Collapsible className="card" title={mode === 'multi' ? '📝 Script' : '📝 Text to speak'}>
        <div className="flex-between" style={{ marginBottom: 8 }}>
          <div className="section-title" style={{ margin: 0 }}>
            {mode === 'multi' ? 'Script (use “Speaker 1:”, “Speaker 2:” …)' : 'Text to speak'}
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {mode === 'multi' && (
              <button
                className="btn sm ghost"
                onClick={syncScriptFromEditor}
                disabled={!session || session.segment_count === 0}
                title={
                  !session || session.segment_count === 0
                    ? 'No segments yet — create a scene first'
                    : 'Rewrite the script from the timeline’s current dialogue, in order (no Whisper)'
                }
              >
                ⇅ Sync dialogue from Editor
              </button>
            )}
            <input
              className="input"
              style={{ maxWidth: 220 }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Scene title"
            />
          </div>
        </div>
        <textarea
          className="input"
          rows={9}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          onFocus={(e) => focusTag(e.currentTarget, setScript)}
          onBlur={blurTag}
          placeholder={mode === 'multi' ? 'Speaker 1: Hello!\nSpeaker 2: Hi there.' : 'Type the text to synthesize…'}
        />

        <div className="flex-between" style={{ marginTop: 10 }}>
          <div className="row" style={{ gap: 14, alignItems: 'center' }}>
            <button className="btn ghost sm" onClick={() => setShowSettings(!showSettings)}>
              {showSettings ? '▾' : '▸'} Generation settings
            </button>
            {mode === 'multi' && (
              <Toggle
                checked={multitrack}
                onChange={setMultitrack}
                label="Multitrack editor"
              />
            )}
          </div>
          <button
            className="btn primary"
            disabled={running || !script.trim()}
            onClick={() => onGenerate(buildBody(), title || 'Untitled Scene', useMultitrack)}
          >
            {running ? <span className="spinner" /> : '🎙'} Generate audio
          </button>
        </div>

        {showSettings && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
            <div className="row wrap" style={{ gap: 18 }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Slider label="Inference steps" min={4} max={64} step={1} value={params.num_step} onChange={(v) => setParams({ ...params, num_step: v })} />
                <Slider label="Guidance (CFG)" min={0} max={4} step={0.1} value={params.guidance_scale} onChange={(v) => setParams({ ...params, guidance_scale: v })} format={(v) => v.toFixed(1)} />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Slider label="Guidance t-shift" min={0} max={1} step={0.05} value={params.t_shift} onChange={(v) => setParams({ ...params, t_shift: v })} format={(v) => v.toFixed(2)} />
                <div className="hint" style={{ marginTop: 6 }}>Speed & line gap now live in the multitrack editor — adjust them after generating, no re-render needed.</div>
              </div>
            </div>
            <div className="row wrap" style={{ gap: 16, marginTop: 6 }}>
              <Toggle checked={params.denoise} onChange={(v) => setParams({ ...params, denoise: v })} label="Denoise" />
              <Toggle checked={params.postprocess_output} onChange={(v) => setParams({ ...params, postprocess_output: v })} label="Postprocess output" />
              <Toggle checked={params.preprocess_prompt} onChange={(v) => setParams({ ...params, preprocess_prompt: v })} label="Preprocess prompt" />
            </div>
            <div className="row wrap" style={{ gap: 18, marginTop: 10, borderTop: '1px solid var(--border-soft)', paddingTop: 10 }}>
              <Toggle
                checked={params.match_loudness ?? true}
                onChange={(v) => setParams({ ...params, match_loudness: v })}
                label="Match loudness (LUFS leveling)"
              />
              {(params.match_loudness ?? true) && (
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Slider
                    label="Target loudness"
                    min={-30}
                    max={-12}
                    step={1}
                    value={params.target_lufs ?? -20}
                    onChange={(v) => setParams({ ...params, target_lufs: v })}
                    format={(v) => `${v} LUFS`}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </Collapsible>

      {/* Progress / output */}
      {running && !session && (
        <div className="progress-box">
          <div className="row">
            <span className="spinner" />
            <strong>
              {prog?.stage === 'loading_model'
                ? 'Loading model…'
                : prog?.stage === 'isolating'
                ? `Isolating voice ${prog.speaker}…`
                : prog?.stage === 'dereverb'
                ? `De-reverbing voice ${prog.speaker}…`
                : prog?.stage === 'generating'
                ? `Generating line ${prog.line}/${prog.total}`
                : prog?.stage === 'leveling'
                ? 'Matching loudness…'
                : 'Working…'}
            </strong>
          </div>
          {prog?.stage === 'generating' && (
            <>
              <div className="progress-bar">
                <div className="fill" style={{ width: `${((prog.line ?? 0) / (prog.total ?? 1)) * 100}%` }} />
              </div>
              {prog.text && <div className="hint" style={{ marginTop: 6 }}>“{prog.text}”</div>}
            </>
          )}
        </div>
      )}

      {job?.status === 'error' && (
        <div className="progress-box" style={{ borderColor: 'var(--bad)' }}>
          <strong style={{ color: 'var(--bad)' }}>Generation failed</strong>
          <div className="hint" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
            {job.error}
          </div>
        </div>
      )}

      {session && mode === 'multi' && (
        <Collapsible className="card" title={`🎚 Multitrack — ${session.title}`}>
          <MultitrackEditor
            session={session}
            onRegen={handleRegen}
            onEditSegment={onEditSegment}
            onReflow={onReflow}
            onInsertSegment={onInsertSegment}
            onDeleteSegment={onDeleteSegment}
            onSplitSegment={onSplitSegment}
            onDeleteSpace={onDeleteSpace}
            onAddSpace={onAddSpace}
            onDuplicateSegment={onDuplicateSegment}
            onSetText={handleSetText}
            onTranscribe={onTranscribeSegment}
            onSetChannel={onSetChannel}
            onRegenChannel={onRegenChannel}
            onUploadChannel={onUploadChannel}
            onAutoSlice={onAutoSlice}
            onSetInpaint={onSetInpaint}
            onPromoteChannel={handlePromote}
            onUndo={onUndo}
            regenIndex={regenIndex}
            busy={running}
            onFinalize={onFinalize}
            finalizing={finalizing}
          />
        </Collapsible>
      )}

      {(mode === 'single' || !session) && audioUrl && (
        <AudioPlayer
          key={audioUrl}
          url={audioUrl}
          title={job?.result?.title}
          filename={job?.result?.filename}
        />
      )}
    </div>
  )
}
