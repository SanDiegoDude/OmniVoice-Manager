import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { api, DEFAULT_TRANSFORM, type VocalTransform } from '../api'
import { blobToWav, sliceBlobToWav } from '../audio-encode'
import { startCountIn, useRecordPrefs, setRecordPref, type CountIn } from '../recordUtils'
import { AudioPlayer } from './AudioPlayer'
import SaveVoiceModal from './SaveVoiceModal'
import { VocalTransforms } from './VocalTransforms'

type Mode = 'character' | 'voice'

export interface PerfCaptureState {
  blob: Blob
  gain_db: number
  speed: number
  mode: Mode
  strength: number
  transforms?: VocalTransform | null
  auto_pitch?: boolean
}

/** Imperative handle so the Voice Clone tab can promote a finished render back
 * into the capture panel as the new take — the "Redub" chain, mirroring the ADR
 * Studio performance modal. */
export interface PerfCaptureHandle {
  adoptOutput: (url: string) => Promise<void>
}

const transformActive = (t: VocalTransform) =>
  Math.abs(t.pitch) > 0.01 ||
  Math.abs(t.formant) > 0.01 ||
  t.sub > 0.01 ||
  t.drive > 0.01 ||
  t.ringmod > 0.01 ||
  t.vibrato > 0.01

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

/** Inline performance capture for the Voice Clone tab: record or upload a
 * take, clean it up, set V2V mode/strength. Surfaces its state via onState
 * (null = no take → plain text-to-voice). */
export const PerformanceCapture = forwardRef<PerfCaptureHandle, {
  onState: (s: PerfCaptureState | null) => void
  onWhisperText: (text: string) => void
  notify: (m: string, k?: 'info' | 'error' | 'success') => void
  /** Library voice id of the cast clone voice, for auto pitch-match. */
  targetVoice?: string | null
  /** Refresh the voice library after a take is saved into it. */
  onVoiceSaved?: () => void
  /** Global auto-trim: when on, recorded takes get dead-air trimmed on capture. */
  trimSilence?: boolean
}>(function PerformanceCapture({ onState, onWhisperText, notify, targetVoice, onVoiceSaved, trimSilence }, ref) {
  const [take, setTake] = useState<{ blob: Blob; url: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const [gain, setGain] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [previewSpeed, setPreviewSpeed] = useState(1)
  const [mode, setMode] = useState<Mode>('character')
  // 4 is the sweet spot for character mode on most voices (the anneal25 gold standard).
  const [strength, setStrength] = useState(4)
  const [transforms, setTransforms] = useState<VocalTransform>(DEFAULT_TRANSFORM)
  // Transparent auto pitch-match — default on; only effective with a clone target.
  const [autoPitch, setAutoPitch] = useState(true)
  // True while the modulated take is baked onto the main player (vs. applied at
  // render time). origTakeRef holds the pre-transform take so Reset can restore it.
  const [transformApplied, setTransformApplied] = useState(false)
  const origTakeRef = useRef<{ blob: Blob; url: string } | null>(null)
  // Counts how many renders have been promoted back as takes (Redub depth).
  const [redubDepth, setRedubDepth] = useState(0)
  const [saveVoiceOpen, setSaveVoiceOpen] = useState(false)
  const [cleanIsolate, setCleanIsolate] = useState(true)
  const [cleanDereverb, setCleanDereverb] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [whispering, setWhispering] = useState(false)
  // Count-in + auto-Whisper are shared, persistent prefs (synced with the ADR
  // performance modal) so they survive panel re-opens and match everywhere.
  const prefs = useRecordPrefs()
  // Mirror into a ref so the MediaRecorder onstop closure reads the live value.
  const autoWhisperRef = useRef(prefs.autoWhisper)
  useEffect(() => {
    autoWhisperRef.current = prefs.autoWhisper
  }, [prefs.autoWhisper])
  const [takeTrim, setTakeTrim] = useState<{ start: number; end: number; dur: number } | null>(null)
  // 3·2·1 count-in (null = idle, 3..1 = counting, 0 = the "go" instant).
  const [countdown, setCountdown] = useState<number | null>(null)
  const countInRef = useRef<CountIn | null>(null)
  const cancelledRef = useRef(false)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const urlRef = useRef<string | null>(null)
  const rawRef = useRef<Blob | null>(null)

  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      if (origTakeRef.current) URL.revokeObjectURL(origTakeRef.current.url)
      if (timerRef.current) window.clearInterval(timerRef.current)
      countInRef.current?.cancel()
      recRef.current?.stream.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  // Keep the parent in sync with the current take + params. When transforms are
  // already baked onto the take (transformApplied), the model gets the take as-is
  // — don't double-apply transforms/auto-pitch server-side.
  useEffect(() => {
    onState(
      take
        ? {
            blob: take.blob,
            gain_db: gain,
            speed,
            mode,
            strength,
            transforms: transformApplied ? null : transformActive(transforms) ? transforms : null,
            auto_pitch: transformApplied ? false : !!targetVoice && autoPitch,
          }
        : null,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, gain, speed, mode, strength, transforms, autoPitch, targetVoice, transformApplied])

  const setTakeBlob = useCallback((wav: Blob) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    if (origTakeRef.current) URL.revokeObjectURL(origTakeRef.current.url)
    origTakeRef.current = null
    setTransformApplied(false)
    const url = URL.createObjectURL(wav)
    urlRef.current = url
    setTake({ blob: wav, url })
    setTakeTrim(null)
  }, [])

  // Redub: promote a finished render to the new take for another pass (e.g. a
  // gentle voice round, then a character round). The render is already leveled,
  // at final tempo, and carries any baked transforms — reset the per-take knobs.
  useImperativeHandle(ref, () => ({
    adoptOutput: async (renderUrl: string) => {
      try {
        const raw = await (await fetch(renderUrl)).blob()
        const { wav } = await blobToWav(raw, 0.9)
        rawRef.current = wav
        setTakeBlob(wav)
        setGain(0)
        setSpeed(1)
        setPreviewSpeed(1)
        setTransforms(DEFAULT_TRANSFORM)
        setRedubDepth((d) => d + 1)
      } catch (e) {
        notify(`Redub failed: ${e instanceof Error ? e.message : e}`, 'error')
      }
    },
  }), [setTakeBlob, notify])

  // "Stamp Trim": destructively cut the take to the trim lines — the cut is
  // what generation processes from then on (trim alone is preview-only).
  const stampTrim = async () => {
    const tt = takeTrim
    if (!take || !tt) return
    if (tt.start < 0.02 && tt.end > tt.dur - 0.02) return
    setProcessing(true)
    try {
      const stamped = await sliceBlobToWav(take.blob, tt.start, tt.end)
      rawRef.current = stamped
      setTakeBlob(stamped)
    } catch (e) {
      notify(`Stamp trim failed: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setProcessing(false)
    }
  }

  const applyCleanup = useCallback(
    async (base: Blob, isolate: boolean, dereverb: boolean): Promise<Blob> => {
      const trim = !!trimSilence
      if (!isolate && !dereverb && !trim) {
        setTakeBlob(base)
        return base
      }
      setProcessing(true)
      try {
        const processed = await api.processClip(base, { isolate, dereverb, trim })
        setTakeBlob(processed)
        return processed
      } catch (e) {
        notify(`Cleanup failed: ${e instanceof Error ? e.message : e}`, 'error')
        setTakeBlob(base)
        return base
      } finally {
        setProcessing(false)
      }
    },
    [setTakeBlob, notify, trimSilence],
  )

  const whisperBlob = useCallback(
    async (blob: Blob) => {
      setWhispering(true)
      try {
        const t = await api.transcribeClip(blob)
        if (t) onWhisperText(t)
      } catch (e) {
        notify(`Whisper failed: ${e instanceof Error ? e.message : e}`, 'error')
      } finally {
        setWhispering(false)
      }
    },
    [onWhisperText, notify],
  )

  const adoptBlob = useCallback(
    async (raw: Blob, fromRecording = false) => {
      try {
        const { wav } = await blobToWav(raw, 0.9)
        rawRef.current = wav
        const finalTake = await applyCleanup(wav, cleanIsolate, cleanDereverb)
        if (fromRecording && autoWhisperRef.current) await whisperBlob(finalTake)
      } catch (e) {
        notify(`Could not decode audio: ${e instanceof Error ? e.message : e}`, 'error')
      }
    },
    [applyCleanup, cleanIsolate, cleanDereverb, whisperBlob, notify],
  )

  const toggleCleanup = async (kind: 'isolate' | 'dereverb', value: boolean) => {
    const iso = kind === 'isolate' ? value : cleanIsolate
    const der = kind === 'dereverb' ? value : cleanDereverb
    if (kind === 'isolate') setCleanIsolate(value)
    else setCleanDereverb(value)
    if (rawRef.current) await applyCleanup(rawRef.current, iso, der)
  }

  const beginRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
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
      notify(`Microphone unavailable: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const startRecord = async () => {
    if (recording || countdown !== null) return
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

  // While counting in or recording: Esc cancels, Space stops (capture-phase so
  // it never reaches the page/player or scrolls).
  useEffect(() => {
    if (!recording && countdown === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelRecord()
      } else if (e.code === 'Space') {
        e.preventDefault()
        e.stopPropagation()
        if (recording) stopRecord()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, countdown])

  const clearTake = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    if (origTakeRef.current) URL.revokeObjectURL(origTakeRef.current.url)
    origTakeRef.current = null
    urlRef.current = null
    rawRef.current = null
    setTransformApplied(false)
    setTake(null)
    setRedubDepth(0)
  }

  // Bake the current transforms (+ auto pitch-match) straight onto the take so
  // the main player plays exactly what the model will receive. Reset restores the
  // pristine take. Re-apply always works from the original, never stacks.
  const applyTransforms = async () => {
    if (!take) return
    const base = origTakeRef.current ?? take
    try {
      const blob = await api.transformClip(base.blob, transformActive(transforms) ? transforms : null, {
        autoPitch: !!targetVoice && autoPitch,
        voice: targetVoice,
      })
      if (!origTakeRef.current) origTakeRef.current = take
      if (urlRef.current && urlRef.current !== origTakeRef.current.url) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setTake({ blob, url })
      setTransformApplied(true)
    } catch (e) {
      notify(`Transform failed: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const resetTransforms = () => {
    const orig = origTakeRef.current
    if (!orig) {
      setTransformApplied(false)
      return
    }
    if (urlRef.current && urlRef.current !== orig.url) URL.revokeObjectURL(urlRef.current)
    urlRef.current = orig.url
    origTakeRef.current = null
    setTake(orig)
    setTransformApplied(false)
  }

  const whisper = () => {
    if (take) void whisperBlob(take.blob)
  }

  return (
    <div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Optional: act the line yourself — timing, pauses, emphasis, emotion — and the cloned voice is
        painted over <em>your</em> performance. Leave empty for plain text-to-voice.
      </div>

      {!micSupported && (
        <div className="hint" style={{ marginBottom: 8, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
          🎙 Mic recording needs <code>https://</code> or <code>localhost</code> (run the server with{' '}
          <code>--ssl</code>). Uploading a file still works.
        </div>
      )}

      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {micSupported && !recording && countdown === null && (
          <button className="btn sm" onClick={startRecord}>
            {take ? '🔁 Re-record' : '🔴 Record performance'}
          </button>
        )}
        {countdown !== null && (
          <>
            <button className="btn sm" disabled style={{ minWidth: 130 }}>
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
            📁 {take ? 'Replace from file' : 'Upload performance'}
            <input
              type="file"
              accept="audio/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void adoptBlob(f)
                e.target.value = ''
              }}
            />
          </label>
        )}
        {recording && <span className="rec-dot" aria-label="recording" />}
        {!recording && countdown === null && (
          <>
            <label
              className="hint"
              style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
              title="Play a 3·2·1 beep count-in before recording starts, so you can get set"
            >
              <input type="checkbox" checked={prefs.countIn} onChange={(e) => setRecordPref('countIn', e.target.checked)} />
              Count-in
            </label>
            <label
              className="hint"
              style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
              title="Transcribe automatically when a recording stops (uncheck for long takes you'd rather Whisper manually)"
            >
              <input type="checkbox" checked={prefs.autoWhisper} onChange={(e) => setRecordPref('autoWhisper', e.target.checked)} />
              Auto-Whisper
            </label>
          </>
        )}
        {take && !recording && (
          <>
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cleanIsolate}
                disabled={processing}
                onChange={(e) => void toggleCleanup('isolate', e.target.checked)}
              />
              Isolate vocals
            </label>
            <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cleanDereverb}
                disabled={processing}
                onChange={(e) => void toggleCleanup('dereverb', e.target.checked)}
              />
              Dereverb
            </label>
            {processing && <span className="spinner sm" aria-label="processing" />}
            <button className="btn sm" disabled={whispering || processing} onClick={whisper} title="Transcribe the take into the text box">
              {whispering ? <span className="spinner sm" /> : '🎤'} Whisper → text
            </button>
            <button className="btn sm" onClick={() => setSaveVoiceOpen(true)} title="Save your take (your voice) straight into the voice library">
              📚 Save voice…
            </button>
            <button className="btn sm ghost" onClick={clearTake} title="Drop the take — back to plain text-to-voice">
              ✕ Clear take
            </button>
          </>
        )}
      </div>

      {take && !recording && (
        <div style={{ marginTop: 10 }}>
          {redubDepth > 0 && (
            <div className="hint" style={{ marginBottom: 6, opacity: 0.85 }}>
              ⟳ Redub {redubDepth} — this take is a previous render. Generate again to layer another pass.
            </div>
          )}
          <AudioPlayer
            key={take.url}
            url={take.url}
            autoPlay={false}
            showDownload
            filename="performance_take.wav"
            initialGain={gain}
            playbackRate={previewSpeed}
            onGainChange={setGain}
            onTrimChange={(s, e, dur) => setTakeTrim({ start: s, end: e, dur })}
          />
          {takeTrim && (takeTrim.start > 0.02 || takeTrim.end < takeTrim.dur - 0.02) && (
            <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
              <button
                className="btn sm good"
                disabled={processing}
                title="Cut the take to the trim lines for real — the cut becomes the new source audio, so generation no longer processes anything outside the crop"
                onClick={() => void stampTrim()}
              >
                ✂ Stamp trim ({takeTrim.start.toFixed(2)}s – {takeTrim.end.toFixed(2)}s)
              </button>
              <span className="hint" style={{ opacity: 0.75 }}>
                generation uses the FULL take until stamped
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
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              onMouseUp={() => setPreviewSpeed(speed)}
              onTouchEnd={() => setPreviewSpeed(speed)}
            />
          </label>

          <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
            <span className="hint" style={{ minWidth: 50 }}>Mode</span>
            <button
              className={`btn sm${mode === 'character' ? ' on' : ''}`}
              title="The voice's OWN mannerisms and delivery take over your read (timing preserved)"
              onClick={() => setMode('character')}
            >
              🎭 Character swap
            </button>
            <button
              className={`btn sm${mode === 'voice' ? ' on' : ''}`}
              title="Pure timbre swap: YOUR exact delivery and cadence, their voice"
              onClick={() => setMode('voice')}
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
              onChange={(e) => setStrength(parseInt(e.target.value, 10))}
            />
          </label>
          <div className="hint" style={{ opacity: 0.8 }}>{STRENGTH_HINT[mode][strength - 1]}</div>

          <VocalTransforms
            value={transforms}
            onChange={setTransforms}
            autoPitch={targetVoice ? autoPitch : undefined}
            onAutoPitch={targetVoice ? setAutoPitch : undefined}
            applied={transformApplied}
            target="take"
            onApply={applyTransforms}
            onReset={resetTransforms}
          />
        </div>
      )}

      {saveVoiceOpen && take && (
        <SaveVoiceModal
          take={{ blob: take.blob, url: take.url }}
          output={null}
          defaultName="my_take"
          onSaved={onVoiceSaved}
          onClose={() => setSaveVoiceOpen(false)}
        />
      )}
    </div>
  )
})
