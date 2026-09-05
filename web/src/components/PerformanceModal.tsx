import { useCallback, useEffect, useRef, useState } from 'react'
import type { MultitrackSegment, VocalTransform } from '../api'
import { api, DEFAULT_TRANSFORM } from '../api'
import { audioBufferToWavMulti, bakeBlob, blobToWav, sliceBlobToWav } from '../audio-encode'
import { startCountIn, useRecordPrefs, setRecordPref, type CountIn } from '../recordUtils'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import { VocalTransforms } from './VocalTransforms'
import SaveVoiceModal from './SaveVoiceModal'
import ToolModal from './ToolModal'

type Mode = 'character' | 'voice'
type PerfParams = { gain_db: number; speed: number; mode: Mode; strength: number; text?: string; transforms?: VocalTransform | null; auto_pitch?: boolean; clean_isolate?: boolean; clean_dereverb?: boolean }

const transformActive = (t: VocalTransform) =>
  Math.abs(t.pitch) > 0.01 ||
  Math.abs(t.formant) > 0.01 ||
  t.sub > 0.01 ||
  t.drive > 0.01 ||
  t.ringmod > 0.01 ||
  t.vibrato > 0.01
// One entry in the dub trail. blob is null only for the segment's previously
// saved take (server-side file) — rendering with null tells the backend to
// reuse what it already has stored.
type DubVersion = { id: number; blob: Blob | null; url: string }

const STRENGTH_HINT: Record<Mode, string[]> = {
  character: [
    'barely teases from your read',
    'gentle character color',
    'balanced',
    'strong character takeover',
    'maximum character (most creative, most hallucination risk)',
  ],
  voice: [
    'exact source performance, full pin',
    'very close to source',
    'balanced',
    'loose — timbre interpolates freely',
    'loosest (most artifacting risk)',
  ],
}

/** Universal dialogue modal: record/upload a take, Whisper it to text, render
 * in place and hear it. With "Capture performance" ON the take drives a V2V
 * transfer; OFF it's a plain TTS render of the dialogue. Also works in draft
 * mode ("Record dialog") where the first render inserts a brand-new segment. */
export default function PerformanceModal({
  seg,
  draft,
  defaultCapture,
  withMic,
  targetVoice,
  onSave,
  onRender,
  onRenderPlain,
  onInsertRender,
  onSetText,
  onApplyOutput,
  onWhisper,
  onVoiceSaved,
  trimSilence,
  onClose,
}: {
  seg: MultitrackSegment | null
  draft: { speakerId: string; startS: number } | null
  defaultCapture: boolean
  withMic: boolean
  /** Library voice id of the segment's clone track, for auto pitch-match. */
  targetVoice?: string | null
  onSave: (index: number, wav: Blob | null, params: PerfParams) => Promise<void>
  onRender: (index: number, wav: Blob | null, params: PerfParams) => Promise<MultitrackSegment | null>
  onRenderPlain: (index: number, text: string) => Promise<MultitrackSegment | null>
  onInsertRender: (
    text: string,
    perf: { wav: Blob | null; params: PerfParams } | null,
  ) => Promise<MultitrackSegment | null>
  onSetText: (index: number, text: string) => void
  onApplyOutput: (index: number, fields: { trim_start_s?: number; trim_end_s?: number; gain_db?: number }) => void
  onWhisper: (wav: Blob) => Promise<string>
  onVoiceSaved?: () => void
  /** Global auto-trim: when on, recorded takes get dead-air trimmed on capture. */
  trimSilence?: boolean
  onClose: () => void
}) {
  const existing = seg?.perform || null
  // Draft mode starts with no segment; the first render inserts one and we
  // keep targeting it from then on.
  const [liveIndex, setLiveIndex] = useState<number | null>(seg?.index ?? null)
  const [capture, setCapture] = useState(defaultCapture)
  const [take, setTake] = useState<{ blob: Blob | null; url: string } | null>(
    existing ? { blob: null, url: existing.url } : null,
  )
  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const [gain, setGain] = useState(existing?.gain_db ?? 0)
  const [speed, setSpeed] = useState(existing?.speed ?? 1)
  const [previewSpeed, setPreviewSpeed] = useState(existing?.speed ?? 1)
  const [mode, setMode] = useState<Mode>(existing?.mode ?? 'character')
  // 4 is the sweet spot for character mode on most voices (the anneal25 gold standard).
  const [strength, setStrength] = useState(existing?.strength ?? 4)
  const [transforms, setTransforms] = useState<VocalTransform>(
    existing?.transforms ? { ...DEFAULT_TRANSFORM, ...existing.transforms } : DEFAULT_TRANSFORM,
  )
  // Auto pitch-match defaults ON for a fresh take on a clone track; re-editing
  // an existing take honors whatever was saved.
  const [autoPitch, setAutoPitch] = useState(existing ? !!existing.auto_pitch : !!targetVoice)
  const [text, setText] = useState(seg?.text ?? '')
  // Cleanup defaults ON for fresh takes (raw mic input without it sounds bad);
  // re-editing a saved take restores whatever was saved so the UI matches the
  // baked-in state (older takes predating this flag fall back to off). Toggling
  // either re-processes the current take, so the initial value is just display —
  // an untouched edit reuses the already-cleaned take with no double-processing.
  const [cleanIsolate, setCleanIsolate] = useState(existing ? !!existing.clean_isolate : true)
  const [cleanDereverb, setCleanDereverb] = useState(existing ? !!existing.clean_dereverb : true)
  // Count-in + auto-Whisper are shared, persistent prefs (synced with the Voice
  // Clone tab's capture panel) so they survive re-opening the modal.
  const prefs = useRecordPrefs()
  // Mirror into a ref so the MediaRecorder onstop closure reads the live value.
  const autoWhisperRef = useRef(prefs.autoWhisper)
  useEffect(() => {
    autoWhisperRef.current = prefs.autoWhisper
  }, [prefs.autoWhisper])
  // 3·2·1 count-in (null = idle, 3..1 = counting, 0 = the "go" instant).
  const [countdown, setCountdown] = useState<number | null>(null)
  const countInRef = useRef<CountIn | null>(null)
  const cancelledRef = useRef(false)
  const [processing, setProcessing] = useState(false)
  const [busy, setBusy] = useState<'whisper' | 'save' | 'render' | 'current' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Rendered output preview (trim/gain here apply to the segment on save).
  // Initial trim is copied from the take's trim lines at render time.
  const [output, setOutput] = useState<{ url: string; trimStart?: number; trimEnd?: number } | null>(null)
  // Creative transforms baked onto the rendered output player (minimized; no
  // auto-pitch — the output already is the target voice). Apply swaps the
  // modulated audio onto the main output player; Reset restores the render.
  const [outTransforms, setOutTransforms] = useState<VocalTransform>(DEFAULT_TRANSFORM)
  const [outApplied, setOutApplied] = useState(false)
  const outOrigUrlRef = useRef<string | null>(null)
  const outDraftRef = useRef<{ trimStart: number; trimEnd: number; gain: number } | null>(null)
  // Take-side bake: Apply swaps the modulated take onto the main take player so
  // the render gets exactly what you hear. takeOrigRef holds the pristine take;
  // bakedUrlRef marks the bake so a *new* take (redub, re-record, version switch)
  // transparently clears the applied state.
  const [takeApplied, setTakeApplied] = useState(false)
  const takeOrigRef = useRef<{ blob: Blob | null; url: string } | null>(null)
  const bakedUrlRef = useRef<string | null>(null)
  // Live trim lines on the take player (raw take time). State mirror drives
  // the Stamp Trim button; the ref is read at render/comparison time.
  const takeTrimRef = useRef<{ start: number; end: number; dur: number } | null>(null)
  const [takeTrim, setTakeTrim] = useState<{ start: number; end: number; dur: number } | null>(null)
  // A/B + split inspection playback.
  const [abPlaying, setAbPlaying] = useState<null | 'ab' | 'split'>(null)
  const abCtxRef = useRef<AudioContext | null>(null)
  const [abSaving, setAbSaving] = useState<null | 'ab' | 'split'>(null)
  // Dub trail: every Redub layers the previous render as the new take, and the
  // chips let you walk back to an earlier source. Only the ACTIVE take is
  // persisted on Save — the trail is scratch space and dies with the modal.
  const [vers, setVers] = useState<DubVersion[]>(() =>
    existing ? [{ id: 0, blob: null, url: existing.url }] : [],
  )
  const [activeVer, setActiveVer] = useState(0)
  const nextVerRef = useRef(1)
  // One-step undo for an accidental × on a redub chip.
  const [trash, setTrash] = useState<{ ver: DubVersion; pos: number } | null>(null)
  // Export to the Voice Lab library (sub-modal with save options).
  const [saveVoiceOpen, setSaveVoiceOpen] = useState(false)
  // Spacebar (scoped to this modal) drives the rendered output player when one
  // exists, otherwise the take player — never the main timeline underneath.
  const takePlayerRef = useRef<AudioPlayerHandle>(null)
  const outPlayerRef = useRef<AudioPlayerHandle>(null)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  // Object URLs stay alive for the whole trail; everything is revoked on unmount.
  const urlsRef = useRef<string[]>([])
  // The take before cleanup, so isolate/dereverb toggles are non-destructive.
  const rawRef = useRef<Blob | null>(null)
  // True once params/take changed after the last render/save (so Save knows
  // whether it still needs to push params and re-arm the clip).
  const dirtyRef = useRef(false)
  const textDirtyRef = useRef(false)

  // getUserMedia only exists on secure origins (https:// or localhost). Plain
  // http:// over the LAN hides the whole API — explain instead of erroring.
  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(
    () => () => {
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      if (timerRef.current) window.clearInterval(timerRef.current)
      countInRef.current?.cancel()
      recRef.current?.stream.getTracks().forEach((t) => t.stop())
      abCtxRef.current?.close().catch(() => {})
    },
    [],
  )

  const markDirty = () => {
    dirtyRef.current = true
  }

  // A previously saved take lives in ONE server-side file that gets overwritten
  // every time a performance renders — so a redub would corrupt the "Original"
  // chip. Pin the original into memory as soon as the modal opens.
  useEffect(() => {
    const v = vers[0]
    if (!existing || !v || v.blob) return
    let alive = true
    void (async () => {
      try {
        const blob = await (await fetch(existing.url)).blob()
        if (!alive) return
        const url = URL.createObjectURL(blob)
        urlsRef.current.push(url)
        setVers((vs) => vs.map((x) => (x.id === v.id ? { ...x, blob, url } : x)))
        // Only swap the live take if the user hasn't replaced it meanwhile.
        setTake((t) => (t && t.url === existing.url ? { blob, url } : t))
      } catch {
        // Offline fetch failed — fall back to server-stored take semantics.
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fresh outside audio (record / upload / cleanup re-process) restarts the dub
  // trail — any redubs were derived from the previous source and are stale.
  const setTakeBlob = useCallback((wav: Blob) => {
    const url = URL.createObjectURL(wav)
    urlsRef.current.push(url)
    const id = nextVerRef.current++
    setVers([{ id, blob: wav, url }])
    setActiveVer(id)
    setTrash(null)
    takeTrimRef.current = null
    setTakeTrim(null)
    setTake({ blob: wav, url })
    dirtyRef.current = true
  }, [])

  const applyCleanup = useCallback(
    async (base: Blob, isolate: boolean, dereverb: boolean): Promise<Blob> => {
      const trim = !!trimSilence
      if (!isolate && !dereverb && !trim) {
        setTakeBlob(base)
        return base
      }
      setProcessing(true)
      setError(null)
      try {
        const processed = await api.processClip(base, { isolate, dereverb, trim })
        setTakeBlob(processed)
        return processed
      } catch (e) {
        setError(`Cleanup failed: ${e instanceof Error ? e.message : e}`)
        setTakeBlob(base)
        return base
      } finally {
        setProcessing(false)
      }
    },
    [setTakeBlob, trimSilence],
  )

  const whisperBlob = useCallback(
    async (blob: Blob) => {
      setBusy('whisper')
      setError(null)
      try {
        const t = await onWhisper(blob)
        if (t) {
          setText(t)
          textDirtyRef.current = true
          dirtyRef.current = true
        }
      } catch (e) {
        setError(`Whisper failed: ${e instanceof Error ? e.message : e}`)
      } finally {
        setBusy(null)
      }
    },
    [onWhisper],
  )

  const adoptBlob = useCallback(
    async (raw: Blob, fromRecording = false) => {
      setError(null)
      try {
        // Decode + peak-normalize: browser captures are often very quiet.
        const { wav } = await blobToWav(raw, 0.9)
        rawRef.current = wav
        const finalTake = await applyCleanup(wav, cleanIsolate, cleanDereverb)
        if (fromRecording && autoWhisperRef.current) await whisperBlob(finalTake)
      } catch (e) {
        setError(`Could not decode audio: ${e instanceof Error ? e.message : e}`)
      }
    },
    [applyCleanup, cleanIsolate, cleanDereverb, whisperBlob],
  )

  // ---- Dub trail (Redub chain) ----
  const selectVer = (v: DubVersion) => {
    setActiveVer(v.id)
    setTake({ blob: v.blob, url: v.url })
    takeTrimRef.current = null
    setTakeTrim(null)
    // The render preview belonged to whatever input produced it — comparing it
    // against a different take would mislead, so it goes away on switch.
    setOutput(null)
    outDraftRef.current = null
    outOrigUrlRef.current = null
    setOutApplied(false)
    markDirty()
  }

  // Promote the current render to the active take for another pass — e.g. a
  // gentle voice round first, then a character round on top.
  const redub = async () => {
    if (!output) return
    setError(null)
    try {
      const raw = await (await fetch(output.url)).blob()
      // Bake the output's dialed-in dB + trim into the new take so the loudness
      // you set survives the round-trip (instead of snapping back to the raw,
      // quiet render). The next pass then processes exactly what you heard.
      const d = outDraftRef.current
      const blob = await bakeBlob(raw, { gainDb: d?.gain ?? 0, start: d?.trimStart, end: d?.trimEnd })
      const url = URL.createObjectURL(blob)
      urlsRef.current.push(url)
      const id = nextVerRef.current++
      setVers((vs) => [...vs, { id, blob, url }])
      setActiveVer(id)
      setTake({ blob, url })
      takeTrimRef.current = null
      setTakeTrim(null)
      // The render is already leveled, at final tempo, and carries any baked
      // transforms — reset per-take knobs so they don't double-apply.
      setGain(0)
      setSpeed(1)
      setPreviewSpeed(1)
      setTransforms(DEFAULT_TRANSFORM)
      setOutput(null)
      outDraftRef.current = null
      outOrigUrlRef.current = null
      setOutApplied(false)
      markDirty()
    } catch (e) {
      setError(`Redub failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  // Bake the creative transforms onto the rendered-output player so the modulated
  // output behaves like the plain output (A/B, download, redub, save voice all use
  // it). Reset restores the model's render. Re-apply works from the original.
  const applyOutTransforms = async () => {
    if (!output) return
    setError(null)
    try {
      const baseUrl = outOrigUrlRef.current ?? output.url
      const raw = await (await fetch(baseUrl)).blob()
      const blob = await api.transformClip(raw, transformActive(outTransforms) ? outTransforms : null)
      const url = URL.createObjectURL(blob)
      urlsRef.current.push(url)
      if (!outOrigUrlRef.current) outOrigUrlRef.current = output.url
      setOutput((o) => (o ? { ...o, url } : o))
      setOutApplied(true)
    } catch (e) {
      setError(`Transform failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const resetOutTransforms = () => {
    const orig = outOrigUrlRef.current
    if (!orig) {
      setOutApplied(false)
      return
    }
    setOutput((o) => (o ? { ...o, url: orig } : o))
    outOrigUrlRef.current = null
    setOutApplied(false)
  }

  const deleteVer = (id: number) => {
    const pos = vers.findIndex((x) => x.id === id)
    if (pos <= 0) return // the original can't be deleted
    const nv = vers.filter((x) => x.id !== id)
    setTrash({ ver: vers[pos], pos })
    setVers(nv)
    if (activeVer === id) selectVer(nv[Math.min(pos - 1, nv.length - 1)])
  }

  const undoDelete = () => {
    if (!trash) return
    setVers((vs) => {
      const nv = [...vs]
      nv.splice(Math.min(trash.pos, nv.length), 0, trash.ver)
      return nv
    })
    setTrash(null)
  }

  // "Stamp Trim": destructively cut the active take to the trim lines — the
  // cut becomes the new source of truth, so renders no longer process the
  // mistakes outside the crop.
  const stampTrim = async () => {
    const tt = takeTrimRef.current
    if (!take || !tt) return
    if (tt.start < 0.02 && tt.end > tt.dur - 0.02) return // nothing to cut
    setProcessing(true)
    setError(null)
    try {
      const src = take.blob ?? (await (await fetch(take.url)).blob())
      const stamped = await sliceBlobToWav(src, tt.start, tt.end)
      const onOriginal = vers.length === 0 || vers[0]?.id === activeVer
      if (onOriginal) {
        // The stamped cut replaces the source outright (and any redubs derived
        // from the uncut audio — they no longer match the new ground truth).
        rawRef.current = stamped
        setTakeBlob(stamped)
      } else {
        const url = URL.createObjectURL(stamped)
        urlsRef.current.push(url)
        setVers((vs) => vs.map((v) => (v.id === activeVer ? { ...v, blob: stamped, url } : v)))
        setTake({ blob: stamped, url })
        takeTrimRef.current = null
        setTakeTrim(null)
        markDirty()
      }
    } catch (e) {
      setError(`Stamp trim failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setProcessing(false)
    }
  }

  // Make sure we have the raw take as a blob (re-fetch a previously saved one).
  const ensureRaw = async (): Promise<Blob | null> => {
    if (rawRef.current) return rawRef.current
    if (take?.url) {
      const res = await fetch(take.url)
      const { wav } = await blobToWav(await res.blob(), 0.9)
      rawRef.current = wav
      return wav
    }
    return null
  }

  const toggleCleanup = async (kind: 'isolate' | 'dereverb', value: boolean) => {
    const iso = kind === 'isolate' ? value : cleanIsolate
    const der = kind === 'dereverb' ? value : cleanDereverb
    if (kind === 'isolate') setCleanIsolate(value)
    else setCleanDereverb(value)
    const base = await ensureRaw()
    if (base) await applyCleanup(base, iso, der)
  }

  const beginRecording = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // AGC on — without it browser captures are far quieter than e.g. Zoom.
        // Echo cancel / noise suppression stay off to keep the read natural;
        // the isolate/dereverb toggles below do heavier cleanup on demand.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      cancelledRef.current = false
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        // Cancelled takes are discarded — never adopt or auto-Whisper a goof.
        if (cancelledRef.current) {
          cancelledRef.current = false
          return
        }
        void adoptBlob(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }), true)
      }
      recRef.current = rec
      rec.start()
      setRecording(true)
      setRecElapsed(0)
      timerRef.current = window.setInterval(() => setRecElapsed((s) => s + 0.1), 100)
    } catch (e) {
      setError(`Microphone unavailable: ${e instanceof Error ? e.message : e}`)
    }
  }

  const startRecord = async () => {
    if (recording || countdown !== null) return
    setError(null)
    if (prefs.countIn) {
      const { promise, handle } = startCountIn(setCountdown)
      countInRef.current = handle
      try {
        await promise
      } catch {
        return // cancelled during count-in
      } finally {
        countInRef.current = null
        setCountdown(null)
      }
    }
    await beginRecording()
  }

  const stopRecord = () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    timerRef.current = null
    recRef.current?.stop()
    recRef.current = null
    setRecording(false)
  }

  // Cancel: abort a pending count-in, or stop + DISCARD an in-progress take.
  const cancelRecord = () => {
    if (countInRef.current) {
      countInRef.current.cancel()
      countInRef.current = null
      setCountdown(null)
      return
    }
    if (timerRef.current) window.clearInterval(timerRef.current)
    timerRef.current = null
    if (recRef.current) {
      cancelledRef.current = true
      recRef.current.stop()
      recRef.current = null
    }
    setRecording(false)
  }

  const pickFile = (f: File | null) => {
    if (f) void adoptBlob(f)
  }

  // Adopt the clip that's already on the timeline as the take. clip_url is the
  // slice as it sits in the mix (trim/speed/level baked), so what you hear on
  // the track is what gets performed. From there it's the upload path exactly —
  // decode, normalize, cleanup — so nothing downstream can tell the difference.
  const adoptCurrentClip = async () => {
    if (!seg) return
    setBusy('current')
    setError(null)
    try {
      const res = await fetch(seg.clip_url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await adoptBlob(await res.blob())
    } catch (e) {
      setError(`Could not load the clip audio: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
  }

  const takeBlob = async (): Promise<Blob | null> => {
    if (take?.blob) return take.blob
    if (take?.url) {
      // Existing saved take being re-edited: fetch it back for Whisper.
      const res = await fetch(take.url)
      return await res.blob()
    }
    return null
  }

  const params = (): PerfParams => ({
    gain_db: gain,
    speed,
    mode,
    strength,
    // When the take is already baked, the model gets it as-is — don't re-apply.
    transforms: takeApplied ? null : transformActive(transforms) ? transforms : null,
    auto_pitch: takeApplied ? false : !!targetVoice && autoPitch,
    // Persisted purely so re-editing this take shows the same toggle state.
    clean_isolate: cleanIsolate,
    clean_dereverb: cleanDereverb,
    text: text.trim() && text.trim() !== (seg?.text ?? '') ? text.trim() : undefined,
  })

  // Any take that isn't our own bake (re-record, version switch, redub, stamp)
  // clears the applied state so Reset/render never reach for a stale original.
  useEffect(() => {
    if (!take || take.url === bakedUrlRef.current) return
    takeOrigRef.current = null
    setTakeApplied(false)
  }, [take?.url])

  const applyTakeTransforms = async () => {
    const base = takeOrigRef.current?.blob ?? (await takeBlob())
    if (!base) return
    setError(null)
    try {
      const blob = await api.transformClip(base, transformActive(transforms) ? transforms : null, {
        autoPitch: !!targetVoice && autoPitch,
        voice: targetVoice,
      })
      const url = URL.createObjectURL(blob)
      urlsRef.current.push(url)
      if (!takeOrigRef.current && take) takeOrigRef.current = take
      bakedUrlRef.current = url
      setTake({ blob, url })
      setTakeApplied(true)
      markDirty()
    } catch (e) {
      setError(`Transform failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const resetTakeTransforms = () => {
    const orig = takeOrigRef.current
    bakedUrlRef.current = null
    if (!orig) {
      setTakeApplied(false)
      return
    }
    takeOrigRef.current = null
    setTake(orig)
    setTakeApplied(false)
    markDirty()
  }

  const whisper = async () => {
    const b = await takeBlob()
    if (b) await whisperBlob(b)
  }

  const render = async () => {
    setBusy('render')
    setError(null)
    stopAb()
    try {
      const txt = text.trim()
      if (!txt) throw new Error('Dialogue text is required — Whisper the take or type the line')
      let newSeg: MultitrackSegment | null = null
      if (liveIndex == null) {
        // Draft (Record Dialog): the first render inserts the segment.
        newSeg = await onInsertRender(txt, capture ? { wav: take?.blob ?? null, params: params() } : null)
        if (newSeg) setLiveIndex(newSeg.index)
      } else if (capture) {
        newSeg = await onRender(liveIndex, take?.blob ?? null, params())
      } else {
        newSeg = await onRenderPlain(liveIndex, txt)
      }
      if (!newSeg) throw new Error('Render returned no segment')
      dirtyRef.current = false
      textDirtyRef.current = false
      const url = newSeg.url + (newSeg.url.includes('?') ? '&' : '?') + `cb=${Date.now()}`
      // Capture mode transfers timing, so the take's trim lines map onto the
      // output (scaled by take speed). Plain TTS has its own timing — no copy.
      let trimStart: number | undefined
      let trimEnd: number | undefined
      const tt = takeTrimRef.current
      if (capture && tt && (tt.start > 0.01 || tt.end < tt.dur - 0.01)) {
        const spd = speed || 1
        trimStart = tt.start / spd
        trimEnd = tt.end / spd
      }
      outDraftRef.current = null
      outOrigUrlRef.current = null
      setOutApplied(false)
      setOutTransforms(DEFAULT_TRANSFORM)
      setOutput({ url, trimStart, trimEnd })
    } catch (e) {
      setError(`Render failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- A/B + split inspection playback ----
  const stopAb = () => {
    abCtxRef.current?.close().catch(() => {})
    abCtxRef.current = null
    setAbPlaying(null)
  }

  const comparisonPieces = async (decode: (src: Blob | string) => Promise<AudioBuffer>) => {
    if (!output) return null
    const takeSrc = take?.blob ?? take?.url
    if (!takeSrc) return null
    const [bufA, bufB] = await Promise.all([decode(takeSrc), decode(output.url)])
    const tt = takeTrimRef.current
    const aStart = tt?.start ?? 0
    const aDur = Math.max(0.05, (tt?.end ?? bufA.duration) - aStart)
    const od = outDraftRef.current
    const bStart = od?.trimStart ?? 0
    const bDur = Math.max(0.05, (od?.trimEnd ?? bufB.duration) - bStart)
    return { bufA, bufB, aStart, aDur, bStart, bDur, aGain: gain, bGain: od?.gain ?? 0, spd: speed || 1 }
  }

  const playAb = async (kind: 'ab' | 'split') => {
    if (abPlaying) {
      stopAb()
      return
    }
    setError(null)
    try {
      const ctx = new AudioContext()
      abCtxRef.current = ctx
      const decode = async (src: Blob | string) => {
        const arr = typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer()
        return ctx.decodeAudioData(arr)
      }
      const p = await comparisonPieces(decode)
      if (!p) throw new Error('No take loaded')
      if (abCtxRef.current !== ctx) return // stopped while decoding

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
      if (kind === 'ab') {
        // Take (trimmed, at render speed/gain) then the render, back-to-back.
        const a = mk(p.bufA, p.aGain, 0, p.spd)
        const b = mk(p.bufB, p.bGain, 0, 1)
        const t0 = ctx.currentTime + 0.05
        a.start(t0, p.aStart, p.aDur)
        b.start(t0 + p.aDur / p.spd + 0.25, p.bStart, p.bDur)
        b.onended = () => {
          if (abCtxRef.current === ctx) stopAb()
        }
      } else {
        // Simultaneous: take hard-left, render hard-right — BOTH windows come
        // from the output's crop bar so the two performances line up sample-
        // for-sample (output time maps back to take time × speed).
        const a = mk(p.bufA, p.aGain, -1, p.spd)
        const b = mk(p.bufB, p.bGain, 1, 1)
        const t0 = ctx.currentTime + 0.05
        a.start(t0, p.bStart * p.spd, p.bDur * p.spd)
        b.start(t0, p.bStart, p.bDur)
        b.onended = () => {
          if (abCtxRef.current === ctx) stopAb()
        }
      }
      setAbPlaying(kind)
    } catch (e) {
      stopAb()
      setError(`Comparison playback failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  // Offline-render the same composition to a WAV download. A/B is mono; the
  // split export is true stereo (take left, render right).
  const downloadAb = async (kind: 'ab' | 'split') => {
    setAbSaving(kind)
    setError(null)
    const dctx = new AudioContext()
    try {
      const decode = async (src: Blob | string) => {
        const arr = typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer()
        return dctx.decodeAudioData(arr)
      }
      const p = await comparisonPieces(decode)
      if (!p) throw new Error('No take loaded')
      const sr = p.bufB.sampleRate
      const total = kind === 'ab' ? p.aDur / p.spd + 0.25 + p.bDur : p.bDur
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
      const b = mk(p.bufB, p.bGain, 1, 1)
      // Split aligns both windows on the output's crop bar (see playAb).
      a.start(0, kind === 'split' ? p.bStart * p.spd : p.aStart, kind === 'split' ? p.bDur * p.spd : p.aDur)
      b.start(kind === 'ab' ? p.aDur / p.spd + 0.25 : 0, p.bStart, p.bDur)
      const rendered = await off.startRendering()
      const blob = audioBufferToWavMulti(rendered)
      const aEl = document.createElement('a')
      aEl.href = URL.createObjectURL(blob)
      const base = `clip${liveIndex ?? 'new'}_${kind === 'ab' ? 'a-b' : 'split_LR'}`
      aEl.download = `${base}.wav`
      aEl.click()
      setTimeout(() => URL.revokeObjectURL(aEl.href), 2000)
    } catch (e) {
      setError(`Comparison export failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      void dctx.close()
      setAbSaving(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      const txt = text.trim()
      if (liveIndex == null) {
        // Draft that was never rendered: Save runs the insert so it's not a no-op.
        if (!txt) throw new Error('Dialogue text is required')
        const ns = await onInsertRender(txt, capture && take ? { wav: take.blob, params: params() } : null)
        if (!ns) throw new Error('Insert failed')
      } else {
        if (capture && take) {
          // Push params/take only if they changed since the last render — saving
          // identical params would re-arm the clip even though the render is fresh.
          if (dirtyRef.current || !output) await onSave(liveIndex, take.blob, params())
        } else if (!capture && textDirtyRef.current && txt) {
          onSetText(liveIndex, txt)
        }
        const d = outDraftRef.current
        if (output && d) {
          onApplyOutput(liveIndex, { trim_start_s: d.trimStart, trim_end_s: d.trimEnd, gain_db: d.gain })
        }
      }
      onClose()
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : e}`)
      setBusy(null)
    }
  }

  const hasTake = take != null
  const working = busy != null || processing
  const canRender = !recording && !working && !!text.trim() && (!capture || hasTake)
  const canSave = !recording && !working && (liveIndex != null ? (capture ? hasTake : true) : !!text.trim())
  return (
    <ToolModal
      open
      title={
        <span>
          🎙 {seg ? `${capture ? 'Vocal performance' : 'Dialogue'} — clip ${seg.index}` : draft ? `Record dialog — speaker ${draft.speakerId} @ ${draft.startS.toFixed(1)}s` : 'Record dialog'}
        </span>
      }
      onClose={() => {
        // Esc (and the ✕) cancel an in-flight count-in / recording first, so a
        // misfire doesn't also tear down the modal and its unsaved work.
        if (countdown !== null || recording) {
          cancelRecord()
          return
        }
        onClose()
      }}
      onSpace={() => {
        // Space stops recording (like the Stop button) instead of toggling a
        // player; while idle it drives the output/take player as before.
        if (recording) {
          stopRecord()
          return
        }
        if (countdown !== null) return
        ;(outPlayerRef.current ?? takePlayerRef.current)?.toggle()
      }}
      actions={
        <>
          <button
            className="btn sm ghost"
            disabled={!hasTake && !output}
            title="Save the take (your voice) or the rendered output into the Voice Lab library"
            onClick={() => setSaveVoiceOpen(true)}
          >
            📚 Save voice…
          </button>
          <button
            className={`btn sm${capture ? ' perf-glow' : ''}`}
            disabled={!canRender}
            title={
              liveIndex == null
                ? 'Insert the new clip on the track and render it now'
                : capture
                ? 'Run the voice transfer now and hear the result without leaving the modal'
                : 'Re-render the dialogue (plain TTS) and hear it here'
            }
            onClick={render}
          >
            {busy === 'render' ? <span className="spinner sm" /> : '⚡'} Render
          </button>
          <button className="btn sm primary" disabled={!canSave} onClick={save}>
            {busy === 'save' ? <span className="spinner sm" /> : '💾'} Save
          </button>
        </>
      }
    >
      <div className="flex-between" style={{ marginBottom: 10, gap: 10 }}>
        <span className="hint" style={{ flex: 1 }}>
          {capture ? (
            <>
              Act the line yourself — timing, pauses, emphasis, emotion. The clip's voice is painted over{' '}
              <em>your</em> performance.
            </>
          ) : (
            <>
              Speak (or type) the line, Whisper fills the dialogue, <strong>⚡ Render</strong> speaks it in the
              track's voice. Want your delivery transferred too? Flip on <strong>Capture performance</strong>.
            </>
          )}
        </span>
        <label
          className="hint"
          style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}
          title="ON: your take drives timing & delivery (V2V transfer). OFF: the recording is just dictation for the dialogue text."
        >
          <input
            type="checkbox"
            checked={capture}
            onChange={(e) => {
              setCapture(e.target.checked)
              markDirty()
            }}
          />
          🎭 Capture performance
        </label>
      </div>

      {withMic && !micSupported && (
        <div className="hint" style={{ marginBottom: 8, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
          🎙 <strong>Mic recording is blocked on this origin.</strong> Browsers only allow microphone
          access on <code>https://</code> or <code>localhost</code>. Either open the app via{' '}
          <code>localhost</code> (e.g. an SSH tunnel: <code>ssh -L {window.location.port || '8200'}:localhost:{window.location.port || '8200'} &lt;server&gt;</code>),
          or restart the server with <code>--ssl</code> and reload over <code>https://</code>.
          Uploading a file below still works.
        </div>
      )}

      {/* Source: record / upload / re-record */}
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {withMic && micSupported && !recording && countdown === null && (
          <button className="btn sm" onClick={startRecord}>
            {hasTake ? '🔁 Re-record' : '🔴 Record'}
          </button>
        )}
        {countdown !== null && (
          <>
            <button className="btn sm" disabled style={{ minWidth: 120 }}>
              {countdown > 0 ? `Recording in ${countdown}…` : '● Go!'}
            </button>
            <button className="btn sm ghost" onClick={cancelRecord} title="Cancel the count-in (Esc)">
              ✕ Cancel
            </button>
          </>
        )}
        {recording && (
          <>
            <button className="btn sm bad" onClick={stopRecord} title="Stop & keep the take (Space)">
              ⏹ Stop · {recElapsed.toFixed(1)}s
            </button>
            <button className="btn sm ghost" onClick={cancelRecord} title="Discard this take (Esc)">
              ✕ Cancel
            </button>
          </>
        )}
        {!recording && countdown === null && (
          <label className="btn sm" style={{ cursor: 'pointer' }}>
            📁 {hasTake ? 'Replace from file' : 'Upload audio'}
            <input
              type="file"
              accept="audio/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                pickFile(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
          </label>
        )}
        {seg && !recording && countdown === null && (
          <button
            className="btn sm"
            disabled={working}
            title="Use this clip's own audio as the take — the slice exactly as it sits in the mix (trim, speed and level baked in). No mic or file needed."
            onClick={() => void adoptCurrentClip()}
          >
            {busy === 'current' ? <span className="spinner sm" /> : '📥'} Use current
          </button>
        )}
        {recording && <span className="rec-dot" aria-label="recording" />}
        {withMic && !recording && countdown === null && (
          <label
            className="hint"
            style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
            title="Play a 3·2·1 beep count-in before recording starts, so you can get set"
          >
            <input type="checkbox" checked={prefs.countIn} onChange={(e) => setRecordPref('countIn', e.target.checked)} />
            Count-in
          </label>
        )}
        {!recording && countdown === null && (
          <label
            className="hint"
            style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
            title="Transcribe automatically when a recording stops (uncheck for long takes you'd rather Whisper manually)"
          >
            <input type="checkbox" checked={prefs.autoWhisper} onChange={(e) => setRecordPref('autoWhisper', e.target.checked)} />
            Auto-Whisper
          </label>
        )}
        {hasTake && !recording && (() => {
          // Cleanup re-processes the ORIGINAL source audio — on a redub it would
          // restart the trail, so the toggles lock while a redub is active.
          const onOriginal = vers.length === 0 || vers[0].id === activeVer
          const lockTitle = onOriginal ? undefined : 'Cleanup applies to the original source — switch back to 🎬 Original to change it'
          return (
          <>
            <label className="hint" title={lockTitle} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: onOriginal ? 'pointer' : 'not-allowed', opacity: onOriginal ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={cleanIsolate}
                disabled={processing || !onOriginal}
                onChange={(e) => void toggleCleanup('isolate', e.target.checked)}
              />
              Isolate vocals
            </label>
            <label className="hint" title={lockTitle} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: onOriginal ? 'pointer' : 'not-allowed', opacity: onOriginal ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={cleanDereverb}
                disabled={processing || !onOriginal}
                onChange={(e) => void toggleCleanup('dereverb', e.target.checked)}
              />
              Dereverb (de-boom)
            </label>
            {processing && <span className="spinner sm" aria-label="processing" />}
          </>
          )
        })()}
      </div>

      {/* Dialogue + Whisper — pinned directly under the record row (above the
          take player) so it never jumps when the player box shows/hides. */}
      <div className="flex-between" style={{ marginTop: 14, marginBottom: 4 }}>
        <span className="hint">Dialogue (what the take says — drives the render)</span>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="btn sm"
            disabled={!hasTake || recording || working}
            title="Transcribe the take with Whisper (if you changed the line in the moment)"
            onClick={whisper}
          >
            {busy === 'whisper' ? <span className="spinner sm" /> : '🎤'} Whisper
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              setText(seg?.text ?? '')
              markDirty()
              textDirtyRef.current = true
            }}
            title="Revert to the segment's text"
          >
            ↺ Revert
          </button>
        </div>
      </div>
      <textarea
        className="input"
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          markDirty()
          textDirtyRef.current = true
        }}
        placeholder="Dialogue for this clip…"
      />

      {capture && hasTake && !recording && (
        <div style={{ marginTop: 10 }}>
          {(vers.length > 1 || trash) && (
            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <span className="hint" title="Each Redub layers the previous render as the new take. Click a chip to go back to an earlier source; only the active take is kept on Save.">
                Dub trail
              </span>
              {vers.map((v, i) => (
                <button
                  key={v.id}
                  className={`btn sm${v.id === activeVer ? ' on' : ''}`}
                  title={i === 0 ? 'The original take' : `Rendered from ${i === 1 ? 'the original' : `Redub ${i - 1}`}`}
                  onClick={() => {
                    if (v.id !== activeVer) selectVer(v)
                  }}
                >
                  {i === 0 ? '🎬 Original' : `Redub ${i}`}
                  {i > 0 && (
                    <span
                      role="button"
                      title="Remove this redub from the trail"
                      style={{ marginLeft: 7, opacity: 0.65 }}
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteVer(v.id)
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
              ))}
              {trash && (
                <button className="btn sm ghost" title="Restore the redub you just deleted" onClick={undoDelete}>
                  ↩ Undo delete
                </button>
              )}
            </div>
          )}
          <AudioPlayer
            ref={takePlayerRef}
            key={take.url}
            url={take.url}
            autoPlay={false}
            showDownload
            filename={`clip${liveIndex ?? 'new'}_performance_take.wav`}
            initialGain={gain}
            playbackRate={previewSpeed}
            onTrimChange={(s, e, dur) => {
              takeTrimRef.current = { start: s, end: e, dur }
              setTakeTrim({ start: s, end: e, dur })
            }}
            onGainChange={(g) => {
              // The player re-emits its current gain on every re-render — only a
              // real change may dirty the take (else Save re-arms a fresh render).
              if (g !== gain) {
                setGain(g)
                markDirty()
              }
            }}
          />
          {takeTrim && (takeTrim.start > 0.02 || takeTrim.end < takeTrim.dur - 0.02) && (
            <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
              <button
                className="btn sm good"
                disabled={processing}
                title="Cut the take to the trim lines for real — the cut becomes the new source audio, so renders no longer process anything outside the crop"
                onClick={() => void stampTrim()}
              >
                ✂ Stamp trim ({takeTrim.start.toFixed(2)}s – {takeTrim.end.toFixed(2)}s)
              </button>
              <span className="hint" style={{ opacity: 0.75 }}>
                renders still use the FULL take until stamped
              </span>
            </div>
          )}
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <span style={{ minWidth: 130 }}>Take speed · {speed.toFixed(2)}×</span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={speed}
              style={{ flex: 1 }}
              onChange={(e) => {
                setSpeed(parseFloat(e.target.value))
                markDirty()
              }}
              onMouseUp={() => setPreviewSpeed(speed)}
              onTouchEnd={() => setPreviewSpeed(speed)}
            />
          </label>
          <div className="hint" style={{ opacity: 0.8 }}>
            Takes are auto-leveled on capture · dB boost via the player's dB control · speed &amp; gain are baked in at
            render time.
          </div>

          {/* V2V mode + strength */}
          <div className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
            <span className="hint" style={{ minWidth: 50 }}>Mode</span>
            <button
              className={`btn sm${mode === 'character' ? ' on' : ''}`}
              title="The voice's OWN mannerisms and delivery take over your read (timing preserved)"
              onClick={() => {
                setMode('character')
                markDirty()
              }}
            >
              🎭 Character swap
            </button>
            <button
              className={`btn sm${mode === 'voice' ? ' on' : ''}`}
              title="Pure timbre swap: YOUR exact delivery and cadence, their voice"
              onClick={() => {
                setMode('voice')
                markDirty()
              }}
            >
              🎤 Voice swap
            </button>
          </div>
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <span style={{ minWidth: 130 }}>Strength · {strength}</span>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={strength}
              style={{ flex: 1 }}
              onChange={(e) => {
                setStrength(parseInt(e.target.value, 10))
                markDirty()
              }}
            />
          </label>
          <div className="hint" style={{ opacity: 0.8 }}>{STRENGTH_HINT[mode][strength - 1]}</div>

          <VocalTransforms
            value={transforms}
            onChange={(t) => {
              setTransforms(t)
              markDirty()
            }}
            autoPitch={targetVoice ? autoPitch : undefined}
            onAutoPitch={
              targetVoice
                ? (v) => {
                    setAutoPitch(v)
                    markDirty()
                  }
                : undefined
            }
            applied={takeApplied}
            target="take"
            onApply={applyTakeTransforms}
            onReset={resetTakeTransforms}
          />
        </div>
      )}

      {/* Rendered output: trim + gain here apply to the segment on save */}
      {output && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div className="flex-between" style={{ marginBottom: 4 }}>
            <span className="hint">
              <strong>Rendered output</strong> — trim &amp; gain apply to the clip on Save
              {capture ? ' (trim copied from the take)' : ''}.
            </span>
            {capture && hasTake && (
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="btn sm"
                  title="Use this render as the new take for another pass — e.g. a gentle voice round first, then a character round on top"
                  onClick={() => void redub()}
                >
                  ⟳ Redub
                </button>
                <button
                  className={`btn sm${abPlaying === 'ab' ? ' on' : ''}`}
                  title="Play your take, then the render, back-to-back (both trimmed)"
                  onClick={() => void playAb('ab')}
                >
                  {abPlaying === 'ab' ? '■ Stop' : '▶ A/B'}
                </button>
                <button
                  className="btn sm ghost"
                  disabled={abSaving != null}
                  title="Download the A/B comparison as one WAV"
                  onClick={() => void downloadAb('ab')}
                >
                  {abSaving === 'ab' ? <span className="spinner sm" /> : '⬇'}
                </button>
                <button
                  className={`btn sm${abPlaying === 'split' ? ' on' : ''}`}
                  title="Play both at once — take in the left ear, render in the right"
                  onClick={() => void playAb('split')}
                >
                  {abPlaying === 'split' ? '■ Stop' : '▶ Split L/R'}
                </button>
                <button
                  className="btn sm ghost"
                  disabled={abSaving != null}
                  title="Download the stereo split (take left, render right) as one WAV — the adherence demo"
                  onClick={() => void downloadAb('split')}
                >
                  {abSaving === 'split' ? <span className="spinner sm" /> : '⬇'}
                </button>
              </div>
            )}
          </div>
          <AudioPlayer
            ref={outPlayerRef}
            key={output.url}
            url={output.url}
            autoPlay
            showDownload
            filename={`clip${liveIndex ?? 'new'}_performance_render.wav`}
            initialStart={output.trimStart}
            initialEnd={output.trimEnd}
            onTrimChange={(s, e) => {
              outDraftRef.current = { trimStart: s, trimEnd: e, gain: outDraftRef.current?.gain ?? 0 }
            }}
            onGainChange={(g) => {
              outDraftRef.current = {
                trimStart: outDraftRef.current?.trimStart ?? 0,
                trimEnd: outDraftRef.current?.trimEnd ?? 0,
                gain: g,
              }
            }}
          />
          <VocalTransforms
            value={outTransforms}
            onChange={setOutTransforms}
            defaultOpen={false}
            target="output"
            applyLabel="🎧 Apply to output"
            applied={outApplied}
            onApply={applyOutTransforms}
            onReset={resetOutTransforms}
          />
        </div>
      )}

      {error && <div className="hint" style={{ color: 'var(--bad, #e66)', marginTop: 8 }}>{error}</div>}
      <div className="hint" style={{ marginTop: 10, opacity: 0.75 }}>
        <strong>⚡ Render</strong>{' '}
        {liveIndex == null
          ? 'inserts the new clip on the track and renders it'
          : 'runs it now (clip updates on the track too)'}{' '}
        · <strong>💾 Save</strong>{' '}
        {capture
          ? output
            ? 'stores the take + settings and applies the output trim/gain'
            : 'stores the take + settings and arms the clip (gold) for the next regenerate'
          : 'keeps the dialogue text' + (output ? ' and applies the output trim/gain' : '')}
        .
      </div>

      {saveVoiceOpen && (
        <SaveVoiceModal
          take={take}
          output={output}
          defaultName={seg ? `clip${seg.index}_voice` : 'performance_voice'}
          onSaved={onVoiceSaved}
          onClose={() => setSaveVoiceOpen(false)}
        />
      )}
    </ToolModal>
  )
}
