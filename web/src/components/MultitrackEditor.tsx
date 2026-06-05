import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MultitrackSession } from '../api'
import { AudioPlayer } from './AudioPlayer'

const ROW_H = 60
const RULER_H = 22
const LABEL_W = 132
const MIN_SEG_PX = 92

function hueFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return (h * 47) % 360
}

export function MultitrackEditor({
  session,
  onRegen,
  regenIndex,
  busy,
  onFinalize,
  finalizing,
}: {
  session: MultitrackSession
  onRegen: (index: number) => void
  regenIndex: number | null
  busy: boolean
  onFinalize: () => void
  finalizing: boolean
}) {
  const [pxPerSec, setPxPerSec] = useState(90)
  const [playingSeg, setPlayingSeg] = useState<number | null>(null)
  const [head, setHead] = useState({ cur: 0, playing: false })
  const segAudioRef = useRef<HTMLAudioElement | null>(null)

  const total = Math.max(session.total_duration_s, 0.1)
  const laneWidth = Math.ceil(total * pxPerSec) + 48

  // Stop any solo segment when the session reloads (e.g. after a regen).
  useEffect(() => {
    if (segAudioRef.current) {
      segAudioRef.current.pause()
    }
    setPlayingSeg(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  const playSeg = useCallback(
    (index: number, url: string) => {
      if (!segAudioRef.current) segAudioRef.current = new Audio()
      const a = segAudioRef.current
      if (playingSeg === index) {
        a.pause()
        setPlayingSeg(null)
        return
      }
      a.onended = () => setPlayingSeg(null)
      a.src = url
      a.currentTime = 0
      a.play()
        .then(() => setPlayingSeg(index))
        .catch(() => setPlayingSeg(null))
    },
    [playingSeg],
  )

  const onTime = useCallback((cur: number, _dur: number, playing: boolean) => {
    setHead({ cur, playing })
  }, [])

  const ruler = useMemo(() => {
    const stepSec = pxPerSec >= 120 ? 1 : pxPerSec >= 60 ? 2 : 5
    const marks: number[] = []
    for (let t = 0; t <= total + stepSec; t += stepSec) marks.push(t)
    return marks
  }, [total, pxPerSec])

  return (
    <div className="mtk card">
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <div>
          <div className="section-title" style={{ margin: 0 }}>
            🎚 Multitrack — {session.title}
          </div>
          <div className="hint">
            {session.segment_count} segments · {session.tracks.length} tracks · {total.toFixed(1)}s
          </div>
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Zoom
            <input
              type="range"
              min={30}
              max={200}
              step={10}
              value={pxPerSec}
              onChange={(e) => setPxPerSec(parseInt(e.target.value, 10))}
            />
          </label>
          <button className="btn primary" onClick={onFinalize} disabled={busy || finalizing}>
            {finalizing ? <span className="spinner" /> : '✓'} Finalize audio
          </button>
        </div>
      </div>

      {/* Full stitched mix — scrub the whole conversation while you edit. */}
      <AudioPlayer
        key={session.mix_url}
        url={session.mix_url}
        title="Full mix (auto-stitched)"
        filename={`${session.title || 'scene'}.wav`}
        autoPlay={false}
        onTime={onTime}
      />

      <div className="mtk-grid" style={{ marginTop: 12 }}>
        {/* Fixed speaker-label column (anchored left). */}
        <div className="mtk-labels" style={{ width: LABEL_W }}>
          <div className="mtk-corner" style={{ height: RULER_H }} />
          {session.tracks.map((t) => (
            <div
              key={t.speaker_id}
              className="mtk-label"
              style={{ height: ROW_H, borderLeft: `3px solid hsl(${hueFor(t.speaker_id)} 70% 60%)` }}
              title={t.name}
            >
              <span className="mtk-label-name">{t.name}</span>
              <span className="mtk-label-sub">{t.segments.length} seg</span>
            </div>
          ))}
        </div>

        {/* Scrollable timeline. */}
        <div className="mtk-scroll">
          <div className="mtk-content" style={{ width: laneWidth }}>
            <div className="mtk-ruler" style={{ height: RULER_H }}>
              {ruler.map((t) => (
                <span key={t} className="mtk-tick" style={{ left: t * pxPerSec }}>
                  {t}s
                </span>
              ))}
            </div>

            {session.tracks.map((t) => {
              const hue = hueFor(t.speaker_id)
              return (
                <div
                  key={t.speaker_id}
                  className="mtk-lane"
                  style={{
                    height: ROW_H,
                    backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px ${pxPerSec}px)`,
                  }}
                >

                  {t.segments.map((seg) => {
                    const left = seg.start_s * pxPerSec
                    const width = Math.max(MIN_SEG_PX, seg.duration_s * pxPerSec)
                    const isPlaying = playingSeg === seg.index
                    const isRegen = regenIndex === seg.index
                    return (
                      <div
                        key={seg.index}
                        className={`mtk-seg${isRegen ? ' regen' : ''}`}
                        style={{
                          left,
                          width,
                          background: `hsl(${hue} 45% 22%)`,
                          borderColor: `hsl(${hue} 60% 45%)`,
                        }}
                        title={seg.text}
                      >
                        <div className="mtk-seg-bar">
                          <button
                            className={`mtk-ic${isPlaying ? ' on' : ''}`}
                            onClick={() => playSeg(seg.index, seg.url)}
                            title={isPlaying ? 'Stop' : 'Play segment'}
                          >
                            {isPlaying ? '■' : '▶'}
                          </button>
                          <button
                            className="mtk-ic"
                            onClick={() => onRegen(seg.index)}
                            disabled={busy}
                            title="Regenerate this segment"
                          >
                            {isRegen ? <span className="spinner sm" /> : '↻'}
                          </button>
                          <span className="mtk-seg-dur">{seg.duration_s.toFixed(1)}s</span>
                        </div>
                        <div className="mtk-seg-text">{seg.text}</div>
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {/* Playhead synced to the full-mix player. */}
            {head.cur > 0 && (
              <div
                className="mtk-head"
                style={{ left: head.cur * pxPerSec, height: RULER_H + session.tracks.length * ROW_H }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="hint" style={{ marginTop: 8 }}>
        ↻ regenerates just that line (a fresh take) and re-stitches the full mix. Happy with it? Hit{' '}
        <strong>Finalize audio</strong> to bake it down and save to history.
      </div>
    </div>
  )
}
