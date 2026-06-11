import { useCallback, useEffect, useRef, useState } from 'react'
import type { MultitrackSegment } from '../api'
import { blobToWav } from '../audio-encode'
import { AudioPlayer } from './AudioPlayer'
import ToolModal from './ToolModal'

type Mode = 'character' | 'voice'

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

/** Record / upload / edit a vocal performance for a segment, then save it as
 * the segment's V2V source. The clone voice gets painted over YOUR read. */
export default function PerformanceModal({
  seg,
  withMic,
  onSave,
  onWhisper,
  onClose,
}: {
  seg: MultitrackSegment
  withMic: boolean
  onSave: (
    wav: Blob | null,
    params: { gain_db: number; speed: number; mode: Mode; strength: number; text?: string },
  ) => Promise<void>
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
  const [busy, setBusy] = useState<'whisper' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const urlRef = useRef<string | null>(null)

  // getUserMedia only exists on secure origins (https:// or localhost). Plain
  // http:// over the LAN hides the whole API — explain instead of erroring.
  const micSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      if (timerRef.current) window.clearInterval(timerRef.current)
      recRef.current?.stream.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  const adoptBlob = useCallback(async (raw: Blob) => {
    setError(null)
    try {
      const { wav } = await blobToWav(raw)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      const url = URL.createObjectURL(wav)
      urlRef.current = url
      setTake({ blob: wav, url })
    } catch (e) {
      setError(`Could not decode audio: ${e instanceof Error ? e.message : e}`)
    }
  }, [])

  const startRecord = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
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

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      await onSave(take?.blob ?? null, {
        gain_db: gain,
        speed,
        mode,
        strength,
        text: text.trim() && text.trim() !== seg.text ? text.trim() : undefined,
      })
      onClose()
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : e}`)
      setBusy(null)
    }
  }

  const hasTake = take != null
  return (
    <ToolModal
      open
      title={<span>🎙 Vocal performance — clip {seg.index}</span>}
      onClose={onClose}
      actions={
        <button className="btn sm primary" disabled={!hasTake || recording || busy != null} onClick={save}>
          {busy === 'save' ? <span className="spinner sm" /> : '💾'} Save
        </button>
      }
    >
      <div className="hint" style={{ marginBottom: 10 }}>
        Act the line yourself — timing, pauses, emphasis, emotion. The clip's voice is painted
        over <em>your</em> performance on the next regenerate.
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
      </div>

      {hasTake && !recording && (
        <div style={{ marginTop: 10 }}>
          <AudioPlayer
            key={take.url}
            url={take.url}
            autoPlay={false}
            showDownload={false}
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
          <div className="hint" style={{ opacity: 0.8 }}>
            dB boost via the player's dB control · speed &amp; gain are baked into the take at render time.
          </div>
        </div>
      )}

      {/* V2V mode + strength */}
      <div className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
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

      {/* Dialogue + Whisper */}
      <div className="flex-between" style={{ marginTop: 14, marginBottom: 4 }}>
        <span className="hint">Dialogue (what the take says — drives the render)</span>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="btn sm"
            disabled={!hasTake || recording || busy != null}
            title="Transcribe the take with Whisper (if you changed the line in the moment)"
            onClick={whisper}
          >
            {busy === 'whisper' ? <span className="spinner sm" /> : '🎤'} Whisper
          </button>
          <button className="btn sm ghost" onClick={() => setText(seg.text)} title="Revert to the segment's text">
            ↺ Revert
          </button>
        </div>
      </div>
      <textarea
        className="input"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Dialogue for this performance…"
      />

      {error && <div className="hint" style={{ color: 'var(--bad, #e66)', marginTop: 8 }}>{error}</div>}
      <div className="hint" style={{ marginTop: 10, opacity: 0.75 }}>
        Saving arms the clip (gold) — hit <strong>↻ Regenerate</strong> on it to render the transfer.
      </div>
    </ToolModal>
  )
}
