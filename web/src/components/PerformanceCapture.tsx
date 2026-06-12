import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { blobToWav } from '../audio-encode'
import { AudioPlayer } from './AudioPlayer'

type Mode = 'character' | 'voice'

export interface PerfCaptureState {
  blob: Blob
  gain_db: number
  speed: number
  mode: Mode
  strength: number
}

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
export function PerformanceCapture({
  onState,
  onWhisperText,
  notify,
}: {
  onState: (s: PerfCaptureState | null) => void
  onWhisperText: (text: string) => void
  notify: (m: string, k?: 'info' | 'error' | 'success') => void
}) {
  const [take, setTake] = useState<{ blob: Blob; url: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const [gain, setGain] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [previewSpeed, setPreviewSpeed] = useState(1)
  const [mode, setMode] = useState<Mode>('character')
  // 4 is the sweet spot for character mode on most voices (the anneal25 gold standard).
  const [strength, setStrength] = useState(4)
  const [cleanIsolate, setCleanIsolate] = useState(true)
  const [cleanDereverb, setCleanDereverb] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [whispering, setWhispering] = useState(false)
  const [autoWhisper, setAutoWhisper] = useState(true)
  const autoWhisperRef = useRef(true)
  autoWhisperRef.current = autoWhisper

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const urlRef = useRef<string | null>(null)
  const rawRef = useRef<Blob | null>(null)

  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      if (timerRef.current) window.clearInterval(timerRef.current)
      recRef.current?.stream.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  // Keep the parent in sync with the current take + params.
  useEffect(() => {
    onState(take ? { blob: take.blob, gain_db: gain, speed, mode, strength } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, gain, speed, mode, strength])

  const setTakeBlob = useCallback((wav: Blob) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const url = URL.createObjectURL(wav)
    urlRef.current = url
    setTake({ blob: wav, url })
  }, [])

  const applyCleanup = useCallback(
    async (base: Blob, isolate: boolean, dereverb: boolean): Promise<Blob> => {
      if (!isolate && !dereverb) {
        setTakeBlob(base)
        return base
      }
      setProcessing(true)
      try {
        const processed = await api.processClip(base, { isolate, dereverb })
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
    [setTakeBlob, notify],
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

  const startRecord = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
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

  const stopRecord = () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    timerRef.current = null
    recRef.current?.stop()
    recRef.current = null
    setRecording(false)
  }

  const clearTake = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
    rawRef.current = null
    setTake(null)
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
        {micSupported && !recording && (
          <button className="btn sm" onClick={startRecord}>
            {take ? '🔁 Re-record' : '🔴 Record performance'}
          </button>
        )}
        {recording && (
          <button className="btn sm bad" onClick={stopRecord}>
            ⏹ Stop · {recElapsed.toFixed(1)}s
          </button>
        )}
        {!recording && (
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
        {!recording && (
          <label
            className="hint"
            style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
            title="Transcribe automatically when a recording stops (uncheck for long takes you'd rather Whisper manually)"
          >
            <input type="checkbox" checked={autoWhisper} onChange={(e) => setAutoWhisper(e.target.checked)} />
            Auto-Whisper
          </label>
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
            <button className="btn sm ghost" onClick={clearTake} title="Drop the take — back to plain text-to-voice">
              ✕ Clear take
            </button>
          </>
        )}
      </div>

      {take && !recording && (
        <div style={{ marginTop: 10 }}>
          <AudioPlayer
            key={take.url}
            url={take.url}
            autoPlay={false}
            showDownload
            filename="performance_take.wav"
            initialGain={gain}
            playbackRate={previewSpeed}
            onGainChange={setGain}
          />
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
        </div>
      )}
    </div>
  )
}
