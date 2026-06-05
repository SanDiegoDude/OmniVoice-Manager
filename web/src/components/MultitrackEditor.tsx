import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MultitrackSession } from '../api'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import { Toggle } from './ui'

const ROW_H = 60
const RULER_H = 22
const LABEL_W = 132
const MIN_SEG_PX = 124

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
  onRegen: (index: number, text?: string) => void
  regenIndex: number | null
  busy: boolean
  onFinalize: () => void
  finalizing: boolean
}) {
  const [pxPerSec, setPxPerSec] = useState(90)
  const [playingSeg, setPlayingSeg] = useState<number | null>(null)
  const [head, setHead] = useState({ cur: 0, playing: false })
  const [follow, setFollow] = useState(true)
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  const segAudioRef = useRef<HTMLAudioElement | null>(null)
  const playerRef = useRef<AudioPlayerHandle>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const prevRegen = useRef<number | null>(null)

  const total = Math.max(session.total_duration_s, 0.1)
  const laneWidth = Math.ceil(total * pxPerSec) + 48

  const flatSegs = useMemo(() => session.tracks.flatMap((t) => t.segments), [session])

  // Stop any solo segment when the session reloads (e.g. after a regen).
  useEffect(() => {
    if (segAudioRef.current) segAudioRef.current.pause()
    setPlayingSeg(null)
    setEditingIndex(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // Drop pending edits that the server has now committed (post-regen).
  useEffect(() => {
    setEdits((prev) => {
      const next = { ...prev }
      let changed = false
      for (const s of flatSegs) {
        if (next[s.index] !== undefined && next[s.index] === s.text) {
          delete next[s.index]
          changed = true
        }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.mix_url])

  // After a regen finishes, jump the full-mix player to that segment and play.
  useEffect(() => {
    if (prevRegen.current != null && regenIndex == null) {
      const seg = flatSegs.find((s) => s.index === prevRegen.current)
      if (seg) {
        setHead({ cur: seg.start_s, playing: true })
        playerRef.current?.seekAndPlay(seg.start_s)
      }
    }
    prevRegen.current = regenIndex
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenIndex, session.mix_url])

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
      a.play().then(() => setPlayingSeg(index)).catch(() => setPlayingSeg(null))
    },
    [playingSeg],
  )

  const onTime = useCallback(
    (cur: number, _dur: number, playing: boolean) => {
      setHead({ cur, playing })
      if (follow && playing && scrollRef.current) {
        const el = scrollRef.current
        const x = cur * pxPerSec
        const view = el.clientWidth
        const margin = view * 0.15
        if (x < el.scrollLeft + margin || x > el.scrollLeft + view - margin) {
          el.scrollLeft = Math.max(0, x - view * 0.35)
        }
      }
    },
    [follow, pxPerSec],
  )

  // Click anywhere on the timeline to move the full-mix playhead there.
  const seekFromClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const content = e.currentTarget.getBoundingClientRect()
      const t = Math.max(0, Math.min(total, (e.clientX - content.left) / pxPerSec))
      playerRef.current?.seek(t)
      setHead((h) => ({ ...h, cur: t }))
    },
    [pxPerSec, total],
  )

  const startEdit = (index: number, current: string) => {
    setEditingIndex(index)
    setEditText(current)
  }
  const commitEdit = (index: number) => {
    setEdits((prev) => ({ ...prev, [index]: editText }))
    setEditingIndex(null)
  }

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
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <Toggle checked={follow} onChange={setFollow} label="Follow playhead" />
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
        ref={playerRef}
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
        <div className="mtk-scroll" ref={scrollRef}>
          <div className="mtk-content" style={{ width: laneWidth }} onClick={seekFromClick}>
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
                    const isEditing = editingIndex === seg.index
                    const text = edits[seg.index] ?? seg.text
                    const dirty = edits[seg.index] !== undefined && edits[seg.index] !== seg.text
                    return (
                      <div
                        key={seg.index}
                        className={`mtk-seg${isRegen ? ' regen' : ''}${dirty ? ' dirty' : ''}`}
                        style={{
                          left,
                          width,
                          background: `hsl(${hue} 45% 22%)`,
                          borderColor: dirty ? 'var(--warn)' : `hsl(${hue} 60% 45%)`,
                        }}
                        title={text}
                      >
                        <div className="mtk-seg-bar" onClick={(e) => e.stopPropagation()}>
                          <button
                            className={`mtk-ic${isPlaying ? ' on' : ''}`}
                            onClick={() => playSeg(seg.index, seg.url)}
                            title={isPlaying ? 'Stop' : 'Play segment'}
                          >
                            {isPlaying ? '■' : '▶'}
                          </button>
                          <button
                            className={`mtk-ic${dirty ? ' warn' : ''}`}
                            onClick={() => onRegen(seg.index, dirty ? edits[seg.index].trim() : undefined)}
                            disabled={busy}
                            title={dirty ? 'Regenerate with edited line' : 'Regenerate this segment'}
                          >
                            {isRegen ? <span className="spinner sm" /> : '↻'}
                          </button>
                          <button
                            className="mtk-ic"
                            onClick={() => startEdit(seg.index, text)}
                            title="Edit dialogue"
                          >
                            ✎
                          </button>
                          <span className="mtk-seg-dur">{seg.duration_s.toFixed(1)}s</span>
                        </div>
                        {isEditing ? (
                          <textarea
                            className="mtk-seg-edit"
                            autoFocus
                            value={editText}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditText(e.target.value)}
                            onBlur={() => commitEdit(seg.index)}
                            onKeyDown={(e) => {
                              e.stopPropagation()
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                commitEdit(seg.index)
                              } else if (e.key === 'Escape') {
                                setEditingIndex(null)
                              }
                            }}
                          />
                        ) : (
                          <div
                            className="mtk-seg-text"
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={() => startEdit(seg.index, text)}
                            title="Double-click to edit"
                          >
                            {dirty ? '✎ ' : ''}
                            {text}
                          </div>
                        )}
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
        Double-click a line (or ✎) to edit it, then ↻ regenerates that take — edited lines also update the script
        above. Click anywhere on the timeline to move the playhead. Happy with it? Hit <strong>Finalize audio</strong>{' '}
        to bake it down and save to history.
      </div>
    </div>
  )
}
