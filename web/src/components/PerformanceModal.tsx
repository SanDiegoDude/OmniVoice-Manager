import { useCallback, useEffect, useRef, useState } from 'react'
import type { MultitrackSegment } from '../api'
import { api } from '../api'
import { blobToWav } from '../audio-encode'
import { AudioPlayer } from './AudioPlayer'
import ToolModal from './ToolModal'

type Mode = 'character' | 'voice'
type PerfParams = { gain_db: number; speed: number; mode: Mode; strength: number; text?: string }

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

/** Record / upload / edit a vocal performance for a segment, render it in
 * place, then save it as the segment's V2V source + output trim/gain. */
export default function PerformanceModal({
  seg,
  withMic,
  onSave,
  onRender,
  onApplyOutput,
  onWhisper,
  onClose,
}: {
  seg: MultitrackSegment
  withMic: boolean
  onSave: (wav: Blob | null, params: PerfParams) => Promise<void>
  onRender: (wav: Blob | null, params: PerfParams) => Promise<MultitrackSegment | null>
  onApplyOutput: (fields: { trim_start_s?: number; trim_end_s?: number; gain_db?: number }) => void
  onWhisper: (wav: Blob) => Promise<string>
  onClose: () => void
}) {
  const existing = seg.perform || null
  const [take, setTake] = useState<{ blob: Blob | null; url: string } | null>(
    existing ? { blob: null, url: existing.url } : null,
  )
  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const [gain, setGain] = useState(existing?.gain_db ?? 0)
  const [speed, setSpeed] = useState(existing?.speed ?? 1)
  const [previewSpeed, setPreviewSpeed] = useState(existing?.speed ?? 1)
  const [mode, setMode] = useState<Mode>(existing?.mode ?? 'character')
  const [strength, setStrength] = useState(existing?.strength ?? 3)
  const [text, setText] = useState(seg.text)
  const [cleanIsolate, setCleanIsolate] = useState(false)
  const [cleanDereverb, setCleanDereverb] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [busy, setBusy] = useState<'whisper' | 'save' | 'render' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Rendered output preview (trim/gain here apply to the segment on save).
  // Initial trim is copied from the take's trim lines at render time.
  const [output, setOutput] = useState<{ url: string; trimStart?: number; trimEnd?: number } | null>(null)
  const outDraftRef = useRef<{ trimStart: number; trimEnd: number; gain: number } | null>(null)
  // Live trim lines on the take player (raw take time).
  const takeTrimRef = useRef<{ start: number; end: number; dur: number } | null>(null)
  // A/B + split inspection playback.
  const [abPlaying, setAbPlaying] = useState<null | 'ab' | 'split'>(null)
  const abCtxRef = useRef<AudioContext | null>(null)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const urlRef = useRef<string | null>(null)
  // The take before cleanup, so isolate/dereverb toggles are non-destructive.
  const rawRef = useRef<Blob | null>(null)
  // True once params/take changed after the last render/save (so Save knows
  // whether it still needs to push params and re-arm the clip).
  const dirtyRef = useRef(false)

  // getUserMedia only exists on secure origins (https:// or localhost). Plain
  // http:// over the LAN hides the whole API — explain instead of erroring.
  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      if (timerRef.current) window.clearInterval(timerRef.current)
      recRef.current?.stream.getTracks().forEach((t) => t.stop())
      abCtxRef.current?.close().catch(() => {})
    },
    [],
  )

  const markDirty = () => {
    dirtyRef.current = true
  }

  const setTakeBlob = useCallback((wav: Blob) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    const url = URL.createObjectURL(wav)
    urlRef.current = url
    setTake({ blob: wav, url })
    dirtyRef.current = true
  }, [])

  const applyCleanup = useCallback(
    async (base: Blob, isolate: boolean, dereverb: boolean) => {
      if (!isolate && !dereverb) {
        setTakeBlob(base)
        return
      }
      setProcessing(true)
      setError(null)
      try {
        const processed = await api.processClip(base, { isolate, dereverb })
        setTakeBlob(processed)
      } catch (e) {
        setError(`Cleanup failed: ${e instanceof Error ? e.message : e}`)
      } finally {
        setProcessing(false)
      }
    },
    [setTakeBlob],
  )

  const adoptBlob = useCallback(
    async (raw: Blob) => {
      setError(null)
      try {
        // Decode + peak-normalize: browser captures are often very quiet.
        const { wav } = await blobToWav(raw, 0.9)
        rawRef.current = wav
        await applyCleanup(wav, cleanIsolate, cleanDereverb)
      } catch (e) {
        setError(`Could not decode audio: ${e instanceof Error ? e.message : e}`)
      }
    },
    [applyCleanup, cleanIsolate, cleanDereverb],
  )

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

  const startRecord = async () => {
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
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        void adoptBlob(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }))
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

  const stopRecord = () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    timerRef.current = null
    recRef.current?.stop()
    recRef.current = null
    setRecording(false)
  }

  const pickFile = (f: File | null) => {
    if (f) void adoptBlob(f)
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
    text: text.trim() && text.trim() !== seg.text ? text.trim() : undefined,
  })

  const whisper = async () => {
    setBusy('whisper')
    setError(null)
    try {
      const b = await takeBlob()
      if (!b) return
      const t = await onWhisper(b)
      if (t) setText(t)
    } catch (e) {
      setError(`Whisper failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
  }

  const render = async () => {
    setBusy('render')
    setError(null)
    stopAb()
    try {
      const newSeg = await onRender(take?.blob ?? null, params())
      if (!newSeg) throw new Error('Render returned no segment')
      dirtyRef.current = false
      const url = newSeg.url + (newSeg.url.includes('?') ? '&' : '?') + `cb=${Date.now()}`
      // Copy the take's trim lines onto the output (scaled by take speed, since
      // speed is baked into the render). Not locked — adjust freely after.
      const tt = takeTrimRef.current
      let trimStart: number | undefined
      let trimEnd: number | undefined
      if (tt && (tt.start > 0.01 || tt.end < tt.dur - 0.01)) {
        const spd = speed || 1
        trimStart = tt.start / spd
        trimEnd = tt.end / spd
      }
      outDraftRef.current = null
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

  const playAb = async (kind: 'ab' | 'split') => {
    if (abPlaying) {
      stopAb()
      return
    }
    if (!output) return
    setError(null)
    try {
      const ctx = new AudioContext()
      abCtxRef.current = ctx
      const decode = async (src: Blob | string) => {
        const arr = typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer()
        return ctx.decodeAudioData(arr)
      }
      const takeSrc = take?.blob ?? take?.url
      if (!takeSrc) throw new Error('No take loaded')
      const [bufA, bufB] = await Promise.all([decode(takeSrc), decode(output.url)])
      if (abCtxRef.current !== ctx) return // stopped while decoding

      const tt = takeTrimRef.current
      const aStart = tt?.start ?? 0
      const aDur = Math.max(0.05, (tt?.end ?? bufA.duration) - aStart)
      const od = outDraftRef.current
      const bStart = od?.trimStart ?? 0
      const bDur = Math.max(0.05, (od?.trimEnd ?? bufB.duration) - bStart)

      const mk = (buf: AudioBuffer, gDb: number, pan: number, rate: number) => {
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.playbackRate.value = rate
        const g = ctx.createGain()
        g.gain.value = Math.pow(10, gDb / 20)
        const p = ctx.createStereoPanner()
        p.pan.value = pan
        src.connect(g)
        g.connect(p)
        p.connect(ctx.destination)
        return src
      }
      const spd = speed || 1
      if (kind === 'ab') {
        // Take (trimmed, at render speed/gain) then the render, back-to-back.
        const a = mk(bufA, gain, 0, spd)
        const b = mk(bufB, outDraftRef.current?.gain ?? 0, 0, 1)
        const t0 = ctx.currentTime + 0.05
        a.start(t0, aStart, aDur)
        b.start(t0 + aDur / spd + 0.25, bStart, bDur)
        b.onended = () => {
          if (abCtxRef.current === ctx) stopAb()
        }
      } else {
        // Simultaneous: take hard-left, render hard-right.
        const a = mk(bufA, gain, -1, spd)
        const b = mk(bufB, outDraftRef.current?.gain ?? 0, 1, 1)
        const t0 = ctx.currentTime + 0.05
        a.start(t0, aStart, aDur)
        b.start(t0, bStart, bDur)
        const longer = aDur / spd >= bDur ? a : b
        longer.onended = () => {
          if (abCtxRef.current === ctx) stopAb()
        }
      }
      setAbPlaying(kind)
    } catch (e) {
      stopAb()
      setError(`Comparison playback failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      // Push params/take only if they changed since the last render — saving
      // identical params would re-arm the clip even though the render is fresh.
      if (dirtyRef.current || !output) {
        await onSave(take?.blob ?? null, params())
      }
      const d = outDraftRef.current
      if (output && d) {
        onApplyOutput({ trim_start_s: d.trimStart, trim_end_s: d.trimEnd, gain_db: d.gain })
      }
      onClose()
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : e}`)
      setBusy(null)
    }
  }

  const hasTake = take != null
  const working = busy != null || processing
  return (
    <ToolModal
      open
      title={<span>🎙 Vocal performance — clip {seg.index}</span>}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn sm perf-glow"
            disabled={!hasTake || recording || working}
            title="Run the voice transfer now and hear the result without leaving the modal"
            onClick={render}
          >
            {busy === 'render' ? <span className="spinner sm" /> : '⚡'} Render
          </button>
          <button className="btn sm primary" disabled={!hasTake || recording || working} onClick={save}>
            {busy === 'save' ? <span className="spinner sm" /> : '💾'} Save
          </button>
        </>
      }
    >
      <div className="hint" style={{ marginBottom: 10 }}>
        Act the line yourself — timing, pauses, emphasis, emotion. The clip's voice is painted
        over <em>your</em> performance. <strong>⚡ Render</strong> runs it right here so you can dial in the sliders.
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
        {withMic && micSupported && !recording && (
          <button className="btn sm" onClick={startRecord}>
            {hasTake ? '🔁 Re-record' : '🔴 Record'}
          </button>
        )}
        {recording && (
          <button className="btn sm bad" onClick={stopRecord}>
            ⏹ Stop · {recElapsed.toFixed(1)}s
          </button>
        )}
        {!recording && (
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
        {recording && <span className="rec-dot" aria-label="recording" />}
        {hasTake && !recording && (
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
              Dereverb (de-boom)
            </label>
            {processing && <span className="spinner sm" aria-label="processing" />}
          </>
        )}
      </div>

      {hasTake && !recording && (
        <div style={{ marginTop: 10 }}>
          <AudioPlayer
            key={take.url}
            url={take.url}
            autoPlay={false}
            showDownload
            filename={`clip${seg.index}_performance_take.wav`}
            initialGain={gain}
            playbackRate={previewSpeed}
            onTrimChange={(s, e, dur) => {
              takeTrimRef.current = { start: s, end: e, dur }
            }}
            onGainChange={(g) => {
              setGain(g)
              markDirty()
            }}
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
        </div>
      )}

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

      {/* Dialogue + Whisper */}
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
              setText(seg.text)
              markDirty()
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
        }}
        placeholder="Dialogue for this performance…"
      />

      {/* Rendered output: trim + gain here apply to the segment on save */}
      {output && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div className="flex-between" style={{ marginBottom: 4 }}>
            <span className="hint">
              <strong>Rendered output</strong> — trim &amp; gain apply to the clip on Save (trim copied from the take).
            </span>
            <div className="row" style={{ gap: 6 }}>
              <button
                className={`btn sm${abPlaying === 'ab' ? ' on' : ''}`}
                title="Play your take, then the render, back-to-back (both trimmed)"
                onClick={() => void playAb('ab')}
              >
                {abPlaying === 'ab' ? '■ Stop' : '▶ A/B'}
              </button>
              <button
                className={`btn sm${abPlaying === 'split' ? ' on' : ''}`}
                title="Play both at once — take in the left ear, render in the right"
                onClick={() => void playAb('split')}
              >
                {abPlaying === 'split' ? '■ Stop' : '▶ Split L/R'}
              </button>
            </div>
          </div>
          <AudioPlayer
            key={output.url}
            url={output.url}
            autoPlay
            showDownload
            filename={`clip${seg.index}_performance_render.wav`}
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
        </div>
      )}

      {error && <div className="hint" style={{ color: 'var(--bad, #e66)', marginTop: 8 }}>{error}</div>}
      <div className="hint" style={{ marginTop: 10, opacity: 0.75 }}>
        <strong>⚡ Render</strong> runs the transfer now (clip updates on the track too) · <strong>💾 Save</strong>{' '}
        stores the take + settings{output ? ' and applies the output trim/gain' : ' and arms the clip (gold) for the next regenerate'}.
      </div>
    </ToolModal>
  )
}
