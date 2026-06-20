import { type MutableRefObject, useEffect, useRef, useState } from 'react'
import type { GenParams, GenerateBody, Job, MultitrackSegment, MultitrackSession, Provider, SpeakerConfig, Voice, VocalTransform } from '../api'
import { api, DEFAULT_TRANSFORM } from '../api'
import { audioBufferToWavMulti } from '../audio-encode'
import { AudioPlayer } from './AudioPlayer'
import { VocalTransforms } from './VocalTransforms'
import { MultitrackEditor } from './MultitrackEditor'
import { PerformanceCapture, type PerfCaptureHandle, type PerfCaptureState } from './PerformanceCapture'
import SaveVoiceModal from './SaveVoiceModal'
import { SpeakerCard } from './SpeakerCard'
import { Collapsible, Slider, Toggle } from './ui'
import { blurTag, focusTag } from '../tagInject'

const transformActive = (t: VocalTransform) =>
  Math.abs(t.pitch) > 0.01 ||
  Math.abs(t.formant) > 0.01 ||
  t.sub > 0.01 ||
  t.drive > 0.01 ||
  t.ringmod > 0.01 ||
  t.vibrato > 0.01

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

// The track-1 "template": processing settings new tracks inherit and that
// persist across reloads. Voice / ref text / instruct are intentionally NOT
// part of it — those are per-track identity, not shared defaults.
const TEMPLATE_FIELDS = ['mode', 'language', 'isolate', 'normalize', 'dereverb', 'dereverb_method'] as const
const templateOf = (cfg: SpeakerConfig): Partial<SpeakerConfig> => {
  const out: Partial<SpeakerConfig> = {}
  for (const k of TEMPLATE_FIELDS) (out as Record<string, unknown>)[k] = cfg[k]
  return out
}

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
  onPerformGenerate,
  onGenerateScript,
  onLucky,
  onRegenSegment,
  onEditSegment,
  onReflow,
  onInsertSegment,
  onEnsureSession,
  onImportToStudio,
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
  onUploadAudioSegment,
  onAutoSlice,
  onBulkSlice,
  onSetInpaint,
  onSetPreserveNonvocal,
  onPromoteChannel,
  onMergeSegments,
  onCollapseTrack,
  onMoveSegment,
  onReorderTracks,
  onVoiceSaved,
  onUndo,
  playCue,
  onSetPerformance,
  onRenderPerformance,
  onRegenAndWait,
  onInsertAndRender,
  onClearPerformance,
  onApplyTransform,
  onIsolateSegment,
  onTranscribeClip,
  onFinalize,
  notify,
  submitting,
  trackTemplate,
  onTrackTemplate,
  castRef,
  trimSilence,
}: {
  playCue: { nonce: number; index?: number; channel?: string; at?: number } | null
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
  onPerformGenerate: (body: GenerateBody, perf: PerfCaptureState) => void
  onGenerateScript: (prompt: string, numSpeakers: number, speakers: SpeakerConfig[], existing: string, monologue: boolean) => Promise<{ title: string; script: string } | null>
  onLucky: (body: GenerateBody, title: string, multitrack?: boolean) => void
  onRegenSegment: (index: number, text?: string) => void
  onEditSegment: (index: number, fields: { start_s?: number; trim_start_s?: number; trim_end_s?: number; speed?: number; gain_db?: number }) => void
  onReflow: (fields: { gap_ms?: number; speed?: number }) => void
  onInsertSegment: (speakerId: string, text: string, startS: number, ripple: boolean) => void
  onEnsureSession: (speakers: Record<string, SpeakerConfig>, params: GenParams) => void
  onImportToStudio: (
    filename: string,
    text: string,
    speakers: Record<string, SpeakerConfig>,
    params: GenParams,
  ) => Promise<void>
  onAddSpeaker: (cfg: SpeakerConfig) => void
  onUpdateSpeaker: (pos: string, cfg: SpeakerConfig) => void
  onRemoveSpeaker: (pos: string) => Promise<MultitrackSession | null> | void
  onDeleteSegment: (index: number, ripple: boolean) => void
  onSplitSegment: (index: number, atS: number) => void
  onDeleteSpace: (startS: number, amount: number) => void
  onAddSpace: (startS: number, amount: number) => void
  onDuplicateSegment: (index: number, startS: number, ripple: boolean, speakerId?: string) => void
  onSetSegmentText: (index: number, text: string) => void
  onTranscribeSegment: (index: number, draft?: { trim_start_s?: number; trim_end_s?: number; speed?: number }) => Promise<string | null | undefined>
  onSetChannel: (pos: string, fields: { name?: string | null; gain_db?: number }) => void
  onRegenChannel: (pos: string) => void
  onUploadChannel: (file: File, name: string, startS?: number) => void
  onUploadAudioSegment: (pos: string, file: File, startS: number, ripple: boolean) => void | Promise<void>
  onAutoSlice: (index: number) => Promise<void>
  onBulkSlice: () => Promise<void>
  onSetInpaint: (index: number, enabled: boolean) => Promise<void>
  onSetPreserveNonvocal: (index: number, enabled: boolean) => Promise<void>
  onPromoteChannel: (pos: string, name: string) => Promise<MultitrackSession | null>
  onMergeSegments: (indices: number[]) => Promise<void>
  onCollapseTrack: (pos: string) => Promise<void>
  onMoveSegment: (index: number, speakerId: string, startS: number) => void
  onReorderTracks: (order: string[]) => Promise<MultitrackSession | null>
  onVoiceSaved?: () => void
  onUndo: () => void
  onSetPerformance: (
    index: number,
    wav: Blob | null,
    params: { gain_db: number; speed: number; mode: 'character' | 'voice'; strength: number; text?: string },
  ) => Promise<void>
  onRenderPerformance: (
    index: number,
    wav: Blob | null,
    params: { gain_db: number; speed: number; mode: 'character' | 'voice'; strength: number; text?: string },
  ) => Promise<MultitrackSegment | null>
  onRegenAndWait: (index: number, text?: string) => Promise<MultitrackSegment | null>
  onInsertAndRender: (
    speakerId: string,
    text: string,
    startS: number,
    perf: {
      wav: Blob | null
      params: { gain_db: number; speed: number; mode: 'character' | 'voice'; strength: number; text?: string }
    } | null,
  ) => Promise<MultitrackSegment | null>
  onClearPerformance: (index: number) => Promise<void>
  onApplyTransform: (index: number, transforms: VocalTransform) => Promise<void>
  onIsolateSegment: (index: number, stem: 'vocals' | 'instrumental') => Promise<void>
  onTranscribeClip: (wav: Blob) => Promise<string>
  onFinalize: () => void
  notify: (m: string, k?: 'info' | 'error' | 'success') => void
  // True during the async generate-submit gap, so the button locks immediately.
  submitting?: boolean
  // Persisted track-1 template: undefined while prefs load, then the stored
  // processing settings (or {} if none saved yet).
  trackTemplate?: Partial<SpeakerConfig>
  onTrackTemplate?: (tpl: Partial<SpeakerConfig>) => void
  // The Voice Library casts a clicked voice into a track through this ref.
  castRef?: MutableRefObject<((voiceId: string, opts?: { newTrack?: boolean }) => void) | null>
  // Global auto-trim toggle: when on, recorded takes get dead-air trimmed too.
  trimSilence?: boolean
}) {
  // ADR Studio (multitrack) is home: one speaker, one track, ready to act.
  const [mode, setMode] = useState<'single' | 'multi'>('multi')
  const [speakers, setSpeakers] = useState<SpeakerConfig[]>([defaultSpeaker()])
  // Voice Clone tab: optional recorded take that guides the render (V2V).
  const [perfState, setPerfState] = useState<PerfCaptureState | null>(null)
  const [saveVoiceOpen, setSaveVoiceOpen] = useState(false)
  const [outTransforms, setOutTransforms] = useState<VocalTransform>(DEFAULT_TRANSFORM)
  // Output edit chain, kept as two independent layers so trim/speed never bakes
  // the creative transforms and the transform sliders survive an Apply:
  //   outputBase  = raw render after a trim/speed Stamp (null = the raw render)
  //   outputFinal = base after the creative transforms (null = no transforms baked)
  // Everything downstream (player / A/B / redub / save / import) uses the topmost
  // non-null layer.
  const [outputBase, setOutputBase] = useState<{ filename: string; url: string } | null>(null)
  const [outputFinal, setOutputFinal] = useState<{ filename: string; url: string } | null>(null)
  const [outTrim, setOutTrim] = useState<{ start: number; end: number; dur: number } | null>(null)
  const [outSpeed, setOutSpeed] = useState(1)
  const [outPreviewSpeed, setOutPreviewSpeed] = useState(1)
  const [outStamping, setOutStamping] = useState(false)
  // Output A/B + split-L/R inspection (take vs render), mirroring the modal.
  const [abPlaying, setAbPlaying] = useState<null | 'ab' | 'split'>(null)
  const [abSaving, setAbSaving] = useState<null | 'ab' | 'split'>(null)
  const abCtxRef = useRef<AudioContext | null>(null)
  const perfCaptureRef = useRef<PerfCaptureHandle>(null)
  const [script, setScript] = useState('')
  const [importing, setImporting] = useState(false)
  const [title, setTitle] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [params, setParams] = useState<GenParams>(defaultParams)
  const [showSettings, setShowSettings] = useState(false)
  const [multitrack, setMultitrack] = useState(true)
  // Keep the generate/render action reachable while the Script card is minimized.
  // Default off on the ADR (multi) side — a stray click there can wipe a scene —
  // but always on in the Voice Clone tab for fast rerolls while playing with voices.
  const [showGenWhenMin, setShowGenWhenMin] = useState(false)
  // Confirm before a full regenerate blows away an edited / upload-bearing scene.
  const [confirmGen, setConfirmGen] = useState(false)

  // ---- Track-1 template: new tracks inherit it; track 1 persists across reloads ----
  const tplRef = useRef<Partial<SpeakerConfig>>(trackTemplate ?? {})
  const makeSpeaker = (): SpeakerConfig => ({ ...defaultSpeaker(), ...tplRef.current })
  const tplReadyRef = useRef(false)
  const lastTplKeyRef = useRef('')
  // Seed track 1 from the stored template once prefs arrive — only on a fresh,
  // session-less roster, so we never stomp a loaded scene.
  useEffect(() => {
    if (trackTemplate === undefined || tplReadyRef.current) return
    tplReadyRef.current = true
    tplRef.current = trackTemplate
    lastTplKeyRef.current = JSON.stringify(templateOf(makeSpeaker()))
    if (!session && speakers.length === 1) setSpeakers([makeSpeaker()])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackTemplate])
  // Persist track 1's processing settings whenever they change.
  useEffect(() => {
    if (!tplReadyRef.current || !onTrackTemplate) return
    const tpl = templateOf(speakers[0])
    const key = JSON.stringify(tpl)
    if (key === lastTplKeyRef.current) return
    lastTplKeyRef.current = key
    tplRef.current = tpl
    onTrackTemplate(tpl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakers, onTrackTemplate])

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
          const arr: SpeakerConfig[] = Array.from({ length: n }, (_, i) => prev[i] ?? makeSpeaker())
          if (injected.speakers) {
            Object.entries(injected.speakers).forEach(([key, cfg]) => {
              const i = parseInt(key, 10) - 1
              if (i >= 0 && i < arr.length) arr[i] = { ...makeSpeaker(), ...cfg }
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
        genCount > prev.length ? [...prev, ...Array.from({ length: genCount - prev.length }, () => makeSpeaker())] : prev,
      )
    }
    return s
  }

  // Delete a track straight from the editor pin. Removal renumbers generative
  // speakers on the backend, so shrink the roster to match (audio channels live
  // outside the 1..N namespace and leave the roster untouched).
  const handleRemoveTrack = async (pos: string) => {
    const s = await onRemoveSpeaker(pos)
    if (s) {
      const genCount = s.tracks.filter((t) => t.kind !== 'audio').length
      setSpeakers((prev) => (prev.length > genCount ? prev.slice(0, Math.max(1, genCount)) : prev))
    }
  }

  // Reorder tracks (drag in the editor, or the ▲▼ arrows below). The backend
  // renumbers generative speakers so top-to-bottom always reads Speaker 1..N —
  // permute the local roster identically so Speaker N still maps to row N.
  const handleReorderTracks = async (order: string[]) => {
    const s = await onReorderTracks(order)
    if (s) {
      const numeric = order.filter((id) => /^\d+$/.test(id))
      setSpeakers((prev) => numeric.map((id) => prev[parseInt(id, 10) - 1] ?? makeSpeaker()))
      setScript(scriptFromSession(s)) // "Speaker N:" labels follow the new order
    }
    return s
  }

  const moveSpeaker = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= speakers.length) return
    if (liveSync && session) {
      const ids = session.tracks.map((t) => t.speaker_id)
      const a = ids.indexOf(String(i + 1))
      const b = ids.indexOf(String(j + 1))
      if (a < 0 || b < 0) return
      const next = [...ids]
      ;[next[a], next[b]] = [next[b], next[a]]
      void handleReorderTracks(next)
    } else {
      setSpeakers((prev) => {
        const next = [...prev]
        ;[next[i], next[j]] = [next[j], next[i]]
        return next
      })
    }
  }

  const addSpeaker = () => {
    const cfg = makeSpeaker()
    setSpeakers((prev) => [...prev, cfg])
    if (liveSync) onAddSpeaker(cfg)
  }

  // Cast a library voice into the roster. Plain click: fill the first empty
  // clone slot (current track order), else swap the last speaker. Shift-click
  // in ADR mode: append a brand-new track from the track-1 template.
  // The Voice Clone tab (single mode) has no track stack — shift-click there is
  // treated as a plain click so it can never silently spawn ADR tracks offscreen.
  const voiceLabel = (id: string) => id.replace(/\.[^.]+$/, '').split('/').pop() || id
  const castVoice = (voiceId: string, opts?: { newTrack?: boolean }) => {
    const newTrack = !!opts?.newTrack && mode === 'multi'
    if (newTrack) {
      const cfg: SpeakerConfig = { ...makeSpeaker(), mode: 'clone', voice: voiceId }
      setSpeakers((prev) => [...prev, cfg])
      if (session) onAddSpeaker(cfg)
      notify(`🎙 Added ${voiceLabel(voiceId)} as a new track`, 'success')
      return
    }
    if (mode === 'single') {
      setSpeakers((prev) => {
        const next = [...prev]
        next[0] = { ...next[0], mode: 'clone', voice: voiceId }
        return next
      })
      notify(`🎙 Cast ${voiceLabel(voiceId)}`, 'success')
      return
    }
    setSpeakers((prev) => {
      let idx = prev.findIndex((s) => s.mode === 'clone' && !s.voice)
      if (idx < 0) idx = prev.length - 1
      const next = [...prev]
      next[idx] = { ...next[idx], mode: 'clone', voice: voiceId }
      if (liveSync) onUpdateSpeaker(String(idx + 1), next[idx])
      notify(`🎙 Cast ${voiceLabel(voiceId)} into Speaker ${idx + 1}`, 'success')
      return next
    })
  }
  useEffect(() => {
    if (castRef) castRef.current = castVoice
  })
  // +Speaker track button inside the editor: append a fully-configured speaker
  // and grow the local roster in lockstep, so the scene stays multi-speaker
  // (otherwise the script writer sees a 1-speaker roster and goes monologue).
  const addSpeakerFromEditor = (cfg: SpeakerConfig) => {
    setSpeakers((prev) => [...prev, cfg])
    onAddSpeaker(cfg)
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

  // Monologue (no "Speaker N:" labels) is a Voice Clone–only format. ADR Studio
  // always writes labelled dialogue — even for a single speaker — so scripts read
  // consistently across the editor.
  const monologue = mode === 'single'

  async function handleScript() {
    if (!aiPrompt.trim()) return notify('Enter an idea for the AI to write', 'error')
    const res = await onGenerateScript(aiPrompt, count, activeSpeakers, script, monologue)
    if (res) {
      setScript(res.script)
      setTitle(res.title)
    }
  }

  async function handleLucky() {
    if (!aiPrompt.trim()) return notify('Enter an idea first', 'error')
    const res = await onGenerateScript(aiPrompt, count, activeSpeakers, script, monologue)
    if (res) {
      setScript(res.script)
      setTitle(res.title)
      const body = buildBody()
      body.script = res.script
      body.text = mode === 'single' ? res.script : null
      body.title = res.title
      if (mode === 'single' && perfState) onPerformGenerate(body, perfState)
      else onLucky(body, res.title, useMultitrack)
    }
  }

  // Multitrack is a multi-speaker-only workflow; single voice always renders a
  // normal one-shot output (the toggle is hidden in single mode).
  const useMultitrack = mode === 'multi' && multitrack

  const running = !!submitting || job?.status === 'running' || job?.status === 'queued'
  const prog = job?.progress
  const audioUrl = job?.status === 'done' ? job.result?.audio_url : null

  // A fresh render clears any baked output edits — they were derived from the
  // previous render and are now stale.
  useEffect(() => {
    setOutputBase(null)
    setOutputFinal(null)
    setOutTransforms(DEFAULT_TRANSFORM)
    setOutTrim(null)
    setOutSpeed(1)
    setOutPreviewSpeed(1)
  }, [audioUrl])

  useEffect(() => () => { abCtxRef.current?.close().catch(() => {}) }, [])

  // What the output player / Redub / Save / Import actually act on.
  const outBaseUrl = outputBase?.url ?? audioUrl
  const outUrl = outputFinal?.url ?? outBaseUrl
  const outFilename = outputFinal?.filename ?? outputBase?.filename ?? job?.result?.filename

  const genLabel = mode === 'single' && perfState ? 'Render performance' : 'Generate audio'

  // Uploaded audio channels + manual scene edits are destroyed by a full
  // regenerate (it rebuilds the scene fresh from the script). Warn first so a
  // stray click doesn't wipe real work.
  const uploadTracks = useMultitrack && session ? session.tracks.filter((t) => t.kind === 'audio') : []
  const segEdited =
    !!session &&
    session.tracks.some((t) =>
      t.segments.some(
        (s) =>
          !!s.perform ||
          !!s.inpaint ||
          Math.abs(s.gain_db || 0) > 0.01 ||
          Math.abs((s.speed ?? 1) - 1) > 0.001 ||
          (s.fade_in_s || 0) > 0.01 ||
          (s.fade_out_s || 0) > 0.01 ||
          (s.trim_start_s || 0) > 0.01,
      ),
    )
  const sceneEdited = !!session?.can_undo || segEdited
  const needsGenWarn =
    useMultitrack && !!session && session.segment_count > 0 && (uploadTracks.length > 0 || sceneEdited)

  const runGenerate = () => {
    const body = buildBody()
    if (mode === 'single' && perfState) onPerformGenerate(body, perfState)
    else onGenerate(body, title || 'Untitled Scene', useMultitrack)
  }
  const doGenerate = () => {
    if (needsGenWarn) setConfirmGen(true)
    else runGenerate()
  }
  // Esc dismisses the regenerate confirmation.
  useEffect(() => {
    if (!confirmGen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmGen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmGen])
  const genButton = (small = false) => (
    <button
      className={`btn primary${small ? ' sm' : ''}${running ? ' busy-glow' : ''}`}
      disabled={running || !script.trim()}
      onClick={doGenerate}
      title={genLabel}
    >
      {running ? <span className="spinner" /> : '🎙'} {genLabel}
    </button>
  )

  // ---- Voice Clone output: edit chain (transforms + trim/speed) → one override ----
  const outTitle = (job?.result?.title || 'clone') + '_fx'

  // Apply the creative transforms on top of the (possibly trim/speed-stamped)
  // base. Always works from the base — never from an already-transformed file —
  // so it can't stack, and the slider settings stay put for further tweaking.
  const applyOutputTransforms = async () => {
    if (!outBaseUrl) return
    const blob = await (await fetch(outBaseUrl)).blob()
    const saved = await api.transformOutputFile(blob, outTransforms, outTitle)
    setOutputFinal({ filename: saved.filename, url: saved.audio_url })
  }

  // Reset clears only the transform layer; a trim/speed stamp underneath stays.
  const resetOutput = () => {
    setOutputFinal(null)
    setOutTransforms(DEFAULT_TRANSFORM)
  }

  // Stamp trims/speeds the BASE only (no transforms baked in). If transforms were
  // applied, re-apply them on top of the freshly stamped base afterward.
  const stampOutput = async () => {
    if (!outBaseUrl) return
    setOutStamping(true)
    try {
      const blob = await (await fetch(outBaseUrl)).blob()
      const saved = await api.stampOutput(blob, {
        trimStart: outTrim?.start ?? 0,
        trimEnd: outTrim?.end ?? 0,
        speed: outSpeed,
        title: outTitle,
      })
      setOutputBase({ filename: saved.filename, url: saved.audio_url })
      if (transformActive(outTransforms)) {
        const tBlob = await (await fetch(saved.audio_url)).blob()
        const tSaved = await api.transformOutputFile(tBlob, outTransforms, outTitle)
        setOutputFinal({ filename: tSaved.filename, url: tSaved.audio_url })
      } else {
        setOutputFinal(null)
      }
      setOutTrim(null)
      setOutSpeed(1)
      setOutPreviewSpeed(1)
    } catch (e) {
      notify(`Stamp failed: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setOutStamping(false)
    }
  }

  // ---- Output A/B + Split L/R (take vs render), mirroring the modal ----
  const stopAb = () => {
    abCtxRef.current?.close().catch(() => {})
    abCtxRef.current = null
    setAbPlaying(null)
  }

  const abPieces = async (decode: (src: Blob | string) => Promise<AudioBuffer>) => {
    if (!perfState || !outUrl) return null
    const [bufA, bufB] = await Promise.all([decode(perfState.blob), decode(outUrl)])
    return { bufA, bufB, aGain: perfState.gain_db || 0, spd: perfState.speed || 1 }
  }

  const playAb = async (kind: 'ab' | 'split') => {
    if (abPlaying) {
      stopAb()
      return
    }
    try {
      const ctx = new AudioContext()
      abCtxRef.current = ctx
      const decode = async (src: Blob | string) => {
        const arr = typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer()
        return ctx.decodeAudioData(arr)
      }
      const p = await abPieces(decode)
      if (!p) throw new Error('Need a take and a render')
      if (abCtxRef.current !== ctx) return
      const mk = (buf: AudioBuffer, gDb: number, pan: number, rate: number) => {
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.playbackRate.value = rate
        const g = ctx.createGain()
        g.gain.value = Math.pow(10, gDb / 20)
        const pn = ctx.createStereoPanner()
        pn.pan.value = pan
        src.connect(g)
        g.connect(pn)
        pn.connect(ctx.destination)
        return src
      }
      const t0 = ctx.currentTime + 0.05
      if (kind === 'ab') {
        const a = mk(p.bufA, p.aGain, 0, p.spd)
        const b = mk(p.bufB, 0, 0, 1)
        a.start(t0, 0)
        b.start(t0 + p.bufA.duration / p.spd + 0.25, 0)
        b.onended = () => { if (abCtxRef.current === ctx) stopAb() }
      } else {
        const a = mk(p.bufA, p.aGain, -1, p.spd)
        const b = mk(p.bufB, 0, 1, 1)
        a.start(t0, 0)
        b.start(t0, 0)
        b.onended = () => { if (abCtxRef.current === ctx) stopAb() }
      }
      setAbPlaying(kind)
    } catch (e) {
      stopAb()
      notify(`Comparison failed: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const downloadAb = async (kind: 'ab' | 'split') => {
    setAbSaving(kind)
    const dctx = new AudioContext()
    try {
      const decode = async (src: Blob | string) => {
        const arr = typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer()
        return dctx.decodeAudioData(arr)
      }
      const p = await abPieces(decode)
      if (!p) throw new Error('Need a take and a render')
      const sr = p.bufB.sampleRate
      const total = kind === 'ab' ? p.bufA.duration / p.spd + 0.25 + p.bufB.duration : Math.max(p.bufA.duration / p.spd, p.bufB.duration)
      const off = new OfflineAudioContext(kind === 'split' ? 2 : 1, Math.ceil((total + 0.1) * sr), sr)
      const mk = (buf: AudioBuffer, gDb: number, pan: number, rate: number) => {
        const src = off.createBufferSource()
        src.buffer = buf
        src.playbackRate.value = rate
        const g = off.createGain()
        g.gain.value = Math.pow(10, gDb / 20)
        src.connect(g)
        if (kind === 'split') {
          const pn = off.createStereoPanner()
          pn.pan.value = pan
          g.connect(pn)
          pn.connect(off.destination)
        } else {
          g.connect(off.destination)
        }
        return src
      }
      const a = mk(p.bufA, p.aGain, -1, p.spd)
      const b = mk(p.bufB, 0, 1, 1)
      a.start(0, 0)
      b.start(kind === 'ab' ? p.bufA.duration / p.spd + 0.25 : 0, 0)
      const rendered = await off.startRendering()
      const blob = audioBufferToWavMulti(rendered)
      const aEl = document.createElement('a')
      aEl.href = URL.createObjectURL(blob)
      aEl.download = `clone_${kind === 'ab' ? 'a-b' : 'split_LR'}.wav`
      aEl.click()
      setTimeout(() => URL.revokeObjectURL(aEl.href), 2000)
    } catch (e) {
      notify(`Comparison export failed: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      void dctx.close()
      setAbSaving(null)
    }
  }

  // ADR Studio / Voice Clone switch — kept reachable even when the Speakers card
  // is minimized (rendered as the collapsed-header extra below).
  const modeTabs = (
    <div className="segment">
      <button className={mode === 'multi' ? 'active' : ''} onClick={() => setMode('multi')}>
        🎬 ADR Studio
      </button>
      <button className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
        🎤 Voice Clone
      </button>
    </div>
  )

  return (
    <div className="col-scroll" style={{ flex: 1 }}>
      {/* Speakers */}
      <Collapsible className="card" title="🎤 Speakers" collapsedExtra={modeTabs}>
        <div className="flex-between" style={{ marginBottom: 12 }}>
          {modeTabs}
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
              onMoveUp={mode === 'multi' && speakers.length > 1 && i > 0 ? () => moveSpeaker(i, -1) : undefined}
              onMoveDown={mode === 'multi' && speakers.length > 1 && i < activeSpeakers.length - 1 ? () => moveSpeaker(i, 1) : undefined}
            />
          ))}
          {mode === 'multi' && (
            <button className="btn ghost add-speaker-tile" onClick={addSpeaker}>
              + Add speaker
            </button>
          )}
        </div>
      </Collapsible>

      {/* Voice Clone: optional performance-guided render */}
      {mode === 'single' && (
        <Collapsible className="card" title="🎭 Vocal performance (optional)">
          <PerformanceCapture
            ref={perfCaptureRef}
            onState={setPerfState}
            onWhisperText={(t) => setScript(t)}
            notify={notify}
            targetVoice={speakers[0]?.mode === 'clone' ? speakers[0]?.voice ?? null : null}
            onVoiceSaved={onVoiceSaved}
            trimSilence={trimSilence}
          />
        </Collapsible>
      )}

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
      <Collapsible
        className="card"
        title={mode === 'multi' ? '📝 Script' : '📝 Text to speak'}
        collapsedExtra={mode === 'single' || showGenWhenMin ? genButton(true) : undefined}
      >
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
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            {mode === 'multi' && (
              <label
                className="hint"
                style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
                title="Keep this Generate button reachable while the Script card is minimized. Off by default on the ADR side — a stray click can re-render and wipe scene work."
              >
                <input type="checkbox" checked={showGenWhenMin} onChange={(e) => setShowGenWhenMin(e.target.checked)} />
                show when minimized
              </label>
            )}
            {genButton(false)}
          </div>
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
      {running && (mode === 'single' || !session) && (
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
                : prog?.stage === 'performing'
                ? 'Transferring your performance…'
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
            onUploadAudioSegment={onUploadAudioSegment}
            onAutoSlice={onAutoSlice}
            onBulkSlice={onBulkSlice}
            onSetInpaint={onSetInpaint}
            onSetPreserveNonvocal={onSetPreserveNonvocal}
            onPromoteChannel={handlePromote}
            onRemoveTrack={handleRemoveTrack}
            onAddSpeaker={addSpeakerFromEditor}
            newTrackDefaults={templateOf(speakers[0])}
            voices={voices}
            onMergeSegments={onMergeSegments}
            onCollapseTrack={onCollapseTrack}
            onMoveSegment={onMoveSegment}
            onReorderTracks={(order) => void handleReorderTracks(order)}
            onVoiceSaved={onVoiceSaved}
            onUndo={onUndo}
            playCue={playCue}
            onSetPerformance={onSetPerformance}
            onRenderPerformance={onRenderPerformance}
            onRegenAndWait={onRegenAndWait}
            onInsertAndRender={onInsertAndRender}
            onClearPerformance={onClearPerformance}
            onApplyTransform={onApplyTransform}
            onIsolateSegment={onIsolateSegment}
            onTranscribeClip={onTranscribeClip}
            regenIndex={regenIndex}
            busy={running}
            onFinalize={onFinalize}
            finalizing={finalizing}
            trimSilence={trimSilence}
          />
        </Collapsible>
      )}

      {(mode === 'single' || !session) && audioUrl && (
        <>
          <AudioPlayer
            key={outUrl}
            url={outUrl as string}
            title={job?.result?.title}
            filename={outFilename}
            playbackRate={mode === 'single' ? outPreviewSpeed : 1}
            onTrimChange={mode === 'single' ? (s, e, dur) => setOutTrim({ start: s, end: e, dur }) : undefined}
          />
          {mode === 'single' && (
            <>
              {/* Inspect: A/B + Split L/R vs the take (needs a recorded take) */}
              {perfState && (
                <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className={`btn sm${abPlaying === 'ab' ? ' on' : ''}`} title="Play your take, then the render, back-to-back" onClick={() => void playAb('ab')}>
                    {abPlaying === 'ab' ? '■ Stop' : '▶ A/B'}
                  </button>
                  <button className="btn sm ghost" disabled={abSaving != null} title="Download the A/B comparison as one WAV" onClick={() => void downloadAb('ab')}>
                    {abSaving === 'ab' ? <span className="spinner sm" /> : '⬇'}
                  </button>
                  <button className={`btn sm${abPlaying === 'split' ? ' on' : ''}`} title="Play both at once — take in the left ear, render in the right" onClick={() => void playAb('split')}>
                    {abPlaying === 'split' ? '■ Stop' : '▶ Split L/R'}
                  </button>
                  <button className="btn sm ghost" disabled={abSaving != null} title="Download the stereo split (take left, render right) as one WAV" onClick={() => void downloadAb('split')}>
                    {abSaving === 'split' ? <span className="spinner sm" /> : '⬇'}
                  </button>
                </div>
              )}

              {/* Output speed + stamp (bakes trim/speed into the ground-truth output) */}
              <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <span style={{ minWidth: 130 }}>Output speed · {outSpeed.toFixed(2)}×</span>
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={outSpeed}
                  style={{ flex: 1 }}
                  onChange={(e) => setOutSpeed(parseFloat(e.target.value))}
                  onMouseUp={() => setOutPreviewSpeed(outSpeed)}
                  onTouchEnd={() => setOutPreviewSpeed(outSpeed)}
                />
              </label>
              {(outStamping || Math.abs(outSpeed - 1) > 0.001 || (outTrim && (outTrim.start > 0.02 || outTrim.end < outTrim.dur - 0.02))) && (
                <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
                  <button
                    className="btn sm good"
                    disabled={outStamping}
                    title="Bake the trim window + speed into the output — the stamped audio becomes the new ground truth (import / redub / save all use it)"
                    onClick={() => void stampOutput()}
                  >
                    {outStamping ? <span className="spinner sm" /> : '✂ Stamp trim/speed'}
                    {outTrim && (outTrim.start > 0.02 || outTrim.end < outTrim.dur - 0.02)
                      ? ` (${outTrim.start.toFixed(2)}s – ${outTrim.end.toFixed(2)}s)`
                      : ''}
                  </button>
                  <span className="hint" style={{ opacity: 0.75 }}>preview only until stamped</span>
                </div>
              )}

              {/* Render-time creative transforms on the output, above the actions */}
              <VocalTransforms
                value={outTransforms}
                onChange={setOutTransforms}
                defaultOpen={false}
                target="output"
                applyLabel="🎧 Apply to output"
                applied={!!outputFinal}
                onApply={applyOutputTransforms}
                onReset={resetOutput}
              />

              {job?.result?.filename && (
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                  <button
                    className="btn sm"
                    title="Use this output as the new performance take for another pass (gentle voice round, then character round) — gain/speed/transforms reset"
                    onClick={() => void perfCaptureRef.current?.adoptOutput(outUrl as string)}
                  >
                    ⟳ Redub (use as take)
                  </button>
                  <button
                    className="btn sm"
                    title="Save this voice to the library — the (modulated) output, or your raw take"
                    onClick={() => setSaveVoiceOpen(true)}
                  >
                    📚 Save voice…
                  </button>
                  <button
                    className="btn sm"
                    disabled={importing}
                    title="Drop this output at 0:00 on track 1 in ADR Studio and keep working on it there — no download/re-upload"
                    onClick={async () => {
                      setImporting(true)
                      try {
                        await onImportToStudio(outFilename as string, script, speakerMap(), params)
                        setMode('multi')
                      } finally {
                        setImporting(false)
                      }
                    }}
                  >
                    {importing ? <span className="spinner sm" /> : '🎬'} Import to ADR Studio
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {saveVoiceOpen && (
        <SaveVoiceModal
          take={perfState ? { blob: perfState.blob, url: '' } : null}
          output={outUrl ? { url: outUrl } : null}
          defaultName="clone_voice"
          onSaved={onVoiceSaved}
          onClose={() => setSaveVoiceOpen(false)}
        />
      )}

      {confirmGen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setConfirmGen(false)}>
          <div
            className="modal-panel gen-confirm"
            style={{ width: 'min(480px, calc(100vw - 32px))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div className="modal-title">⚠ Regenerate the whole scene?</div>
            </div>
            <div className="modal-body">
              <p style={{ margin: '0 0 10px' }}>
                Generating rebuilds the scene from scratch using the current script — it{' '}
                <strong>resets the active project</strong>:
              </p>
              <ul className="gen-confirm-list">
                <li>
                  Every clip is re-rendered with fresh dialogue — your manual edits (trims, fades,
                  gains, moves, performances, pinned voices) are discarded.
                </li>
                {uploadTracks.length > 0 && (
                  <li>
                    <strong>
                      {uploadTracks.length} uploaded audio {uploadTracks.length === 1 ? 'track' : 'tracks'}
                    </strong>{' '}
                    ({uploadTracks.map((t) => t.name || t.custom_name || 'Audio').join(', ')}) will be{' '}
                    <strong>deleted</strong>.
                  </li>
                )}
              </ul>
              <p className="hint" style={{ marginTop: 10 }}>
                This can't be undone. Tip: <strong>Finalize audio</strong> first if you want to keep the current render.
              </p>
            </div>
            <div className="gen-confirm-foot">
              <button className="btn ghost" onClick={() => setConfirmGen(false)}>
                Cancel
              </button>
              <button
                className="btn bad"
                onClick={() => {
                  setConfirmGen(false)
                  runGenerate()
                }}
              >
                Regenerate &amp; reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
