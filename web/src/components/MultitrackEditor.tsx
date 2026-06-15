import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { MultitrackSegment, MultitrackSession, MultitrackTrack, SpeakerConfig, Voice } from '../api'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import { Toggle } from './ui'
import { blurTag, focusTag } from '../tagInject'
import { claimPlayback, releasePlayback } from '../audioBus'
import PerformanceModal from './PerformanceModal'
import ToolModal from './ToolModal'
import { SpeakerCard } from './SpeakerCard'

const newSpeakerCfg = (): SpeakerConfig => ({
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

const ROW_H = 74
const RULER_H = 22
const LABEL_W = 184
const MIN_SEG_PX = 22
const GHOST_W = 130
const MIN_PPS = 12
const MAX_PPS = 320
const clampPps = (v: number) => Math.max(MIN_PPS, Math.min(MAX_PPS, v))

function hueFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return (h * 47) % 360
}
const snap = (t: number) => Math.max(0, Math.round(t * 10) / 10)

type Drag = { index: number; cur: number; lane: number } | null
type Sel = { a: number; b: number; mode: 'del' | 'add' } | null
type SegMenu = { index: number; x: number; y: number } | null
// Live, uncommitted values while a segment tool-handle is being dragged
// (trim edges, fade corners, the dB line). Committed on mouseup.
type SegTool = {
  index: number
  trimStart?: number
  trimEnd?: number
  start?: number
  fadeIn?: number
  fadeOut?: number
  gain?: number
} | null
type Pending =
  | { kind: 'seg'; index: number; origStart: number; fromLane: number; startX: number; startY: number }
  | { kind: 'seg-l'; index: number; origTrimStart: number; origStart: number; speed: number; trimEnd: number; startX: number }
  | { kind: 'seg-r'; index: number; origTrimEnd: number; trimStart: number; rawDur: number; speed: number; startX: number }
  | { kind: 'fade'; index: number; side: 'in' | 'out'; orig: number; eff: number; startX: number }
  | { kind: 'seg-gain'; index: number; orig: number; pxRange: number; startX: number; startY: number }
  | { kind: 'ghost'; origStart: number; startX: number }
  | { kind: 'select'; origStart: number; startX: number }
  | { kind: 'sel-move' | 'sel-l' | 'sel-r'; origA: number; origB: number; startX: number }
  | { kind: 'pan'; origScroll: number; startX: number }
type Insert = {
  kind: 'new' | 'dup'
  srcIndex?: number
  speakerId: string
  start_s: number
  ripple: boolean
  phase: 'menu' | 'place' | 'type'
  text: string
  menuX: number
  menuY: number
  gapStart?: number
  gapAmount?: number
} | null
type TrimDraft = { trimStart: number; trimEnd: number; speed: number; gain: number }

export function MultitrackEditor({
  session,
  onRegen,
  onEditSegment,
  onReflow,
  onInsertSegment,
  onDeleteSegment,
  onSplitSegment,
  onDeleteSpace,
  onAddSpace,
  onDuplicateSegment,
  onSetText,
  onTranscribe,
  onSetChannel,
  onRegenChannel,
  onUploadChannel,
  onAutoSlice,
  onSetInpaint,
  onSetPreserveNonvocal,
  onPromoteChannel,
  onRemoveTrack,
  onAddSpeaker,
  voices,
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
  onTranscribeClip,
  regenIndex,
  busy,
  onFinalize,
  finalizing,
  newTrackDefaults,
  trimSilence,
}: {
  session: MultitrackSession
  playCue: { nonce: number; index?: number; channel?: string; at?: number } | null
  onRegen: (index: number, text?: string) => void
  onEditSegment: (index: number, fields: { start_s?: number; trim_start_s?: number; trim_end_s?: number; speed?: number; gain_db?: number; fade_in_s?: number; fade_out_s?: number }) => void
  onReflow: (fields: { gap_ms?: number; speed?: number }) => void
  onInsertSegment: (speakerId: string, text: string, startS: number, ripple: boolean) => void
  onDeleteSegment: (index: number, ripple: boolean) => void
  onSplitSegment: (index: number, atS: number) => void
  onDeleteSpace: (startS: number, amount: number) => void
  onAddSpace: (startS: number, amount: number) => void
  onDuplicateSegment: (index: number, startS: number, ripple: boolean) => void
  onSetText: (index: number, text: string) => void
  onTranscribe: (index: number, draft?: { trim_start_s?: number; trim_end_s?: number; speed?: number }) => Promise<string | null | undefined>
  onSetChannel: (pos: string, fields: { name?: string | null; gain_db?: number }) => void
  onRegenChannel: (pos: string) => void
  onUploadChannel: (file: File, name: string, startS?: number) => void | Promise<void>
  onAutoSlice: (index: number) => Promise<void>
  onSetInpaint: (index: number, enabled: boolean) => Promise<void>
  onSetPreserveNonvocal: (index: number, enabled: boolean) => Promise<void>
  onPromoteChannel: (pos: string, name: string) => Promise<MultitrackSession | null>
  onRemoveTrack: (pos: string) => Promise<void>
  onAddSpeaker: (cfg: SpeakerConfig) => void
  voices: Voice[]
  onMergeSegments: (indices: number[]) => Promise<void>
  onCollapseTrack: (pos: string) => Promise<void>
  onMoveSegment: (index: number, speakerId: string, startS: number) => void
  onReorderTracks: (order: string[]) => void
  newTrackDefaults?: Partial<SpeakerConfig>
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
  onTranscribeClip: (wav: Blob) => Promise<string>
  regenIndex: number | null
  busy: boolean
  onFinalize: () => void
  finalizing: boolean
  trimSilence?: boolean
}) {
  const [pxPerSec, setPxPerSec] = useState(90)
  // Floating dB readout that tracks the cursor while dragging a clip's gain line.
  const [gainDrag, setGainDrag] = useState<{ x: number; y: number; gain: number } | null>(null)
  const [vScale, setVScale] = useState(1)
  const rowH = Math.round(ROW_H * vScale)
  const vDragRef = useRef<{ y: number; scale: number } | null>(null)
  const [playingSeg, setPlayingSeg] = useState<number | null>(null)
  const [head, setHead] = useState({ cur: 0, playing: false })
  const [follow, setFollow] = useState(true)
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [drag, setDrag] = useState<Drag>(null)
  const [tool, setTool] = useState<SegTool>(null)
  const toolRef = useRef<SegTool>(null)
  const updateTool = useCallback((t: SegTool) => {
    toolRef.current = t
    setTool(t)
  }, [])
  // Vertical track drag (reorder lanes): source row + current insertion slot.
  const [trackDrag, setTrackDrag] = useState<{ from: number; slot: number } | null>(null)
  const trackDragRef = useRef<{ from: number; slot: number } | null>(null)
  const labelsRef = useRef<HTMLDivElement | null>(null)
  const [trimIndex, setTrimIndex] = useState<number | null>(null)
  const [trimDraft, setTrimDraft] = useState<TrimDraft>({ trimStart: 0, trimEnd: 0, speed: 1, gain: 0 })
  const [trimText, setTrimText] = useState('')
  const [transcribing, setTranscribing] = useState<number | 'trim' | null>(null)
  const [perfModal, setPerfModal] = useState<
    | { index: number; mic: boolean; capture: boolean }
    | { draft: { speakerId: string; startS: number }; mic: boolean; capture: boolean }
    | null
  >(null)
  const [slicing, setSlicing] = useState<number | null>(null)
  const [inpainting, setInpainting] = useState<number | null>(null)
  const [promoting, setPromoting] = useState<string | null>(null)
  // Add-track flyout: a draft speaker config edited in-place; null = closed.
  const [addTrack, setAddTrack] = useState<SpeakerConfig | null>(null)
  const [previewSpeed, setPreviewSpeed] = useState(1)
  const [insert, setInsert] = useState<Insert>(null)
  const segMenuRef = useRef<HTMLDivElement>(null)
  const insertMenuRef = useRef<HTMLDivElement>(null)
  // Keep popup menus fully on-screen: cap height (scroll if needed) and nudge them
  // back inside the viewport after they render at the click point.
  const clampToViewport = (el: HTMLDivElement | null) => {
    if (!el) return
    const pad = 8
    el.style.maxHeight = `${window.innerHeight - pad * 2}px`
    el.style.overflowY = 'auto'
    const r = el.getBoundingClientRect()
    let left = r.left
    let top = r.top
    if (r.right > window.innerWidth - pad) left = window.innerWidth - pad - r.width
    if (r.bottom > window.innerHeight - pad) top = window.innerHeight - pad - r.height
    el.style.left = `${Math.max(pad, left)}px`
    el.style.top = `${Math.max(pad, top)}px`
  }

  // Vertical resize: drag the handle under the grid to grow track rows + the mix
  // waveform together (they scale by the same factor so the view stays balanced).
  const onVMove = useCallback((e: MouseEvent) => {
    const s = vDragRef.current
    if (!s) return
    const per = ROW_H * Math.max(1, session.tracks.length)
    const next = s.scale + (e.clientY - s.y) / per
    setVScale(Math.max(0.6, Math.min(3, Math.round(next * 100) / 100)))
  }, [session.tracks.length])
  const onVUp = useCallback(() => {
    vDragRef.current = null
    window.removeEventListener('mousemove', onVMove)
    window.removeEventListener('mouseup', onVUp)
  }, [onVMove])
  const startVResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    vDragRef.current = { y: e.clientY, scale: vScale }
    window.addEventListener('mousemove', onVMove)
    window.addEventListener('mouseup', onVUp)
  }, [vScale, onVMove, onVUp])
  const [gapVal, setGapVal] = useState(session.gap_ms)
  const [speedVal, setSpeedVal] = useState(1)
  const [sel, setSel] = useState<Sel>(null)
  const [selEditing, setSelEditing] = useState(false)
  // Multi-select for merge: shift-click toggles; selection is sticky (survives
  // scrolling / clicks) until explicitly cleared or merged.
  const [selSegs, setSelSegs] = useState<Set<number>>(new Set())
  const toggleSelSeg = useCallback((index: number) => {
    setSelSegs((prev) => {
      const n = new Set(prev)
      if (n.has(index)) n.delete(index)
      else n.add(index)
      return n
    })
  }, [])
  const [merging, setMerging] = useState(false)
  const [segMenu, setSegMenu] = useState<SegMenu>(null)
  useLayoutEffect(() => { clampToViewport(segMenuRef.current) }, [segMenu])
  useLayoutEffect(() => { clampToViewport(insertMenuRef.current) }, [insert])

  const segAudioRef = useRef<HTMLAudioElement | null>(null)
  const playerRef = useRef<AudioPlayerHandle>(null)
  const trimPlayerRef = useRef<AudioPlayerHandle>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const headPosRef = useRef(0)
  const mixRef = useRef(session.mix_url)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const pendingRef = useRef<Pending | null>(null)
  const dragRef = useRef<{ index: number; cur: number; lane: number } | null>(null)
  const selRef = useRef<Sel>(null)
  const activeRef = useRef(false)
  const suppressClickRef = useRef(false)

  // ---- Manual razorblade slice (arm an icon, then press-move-release on the
  // clip to choose the exact cut point; commit on release → split endpoint,
  // which the undo middleware already snapshots). ----
  const [sliceArmed, setSliceArmed] = useState<number | null>(null)
  const [sliceX, setSliceX] = useState<number | null>(null) // live cursor, segment-local px
  const sliceRef = useRef<{ index: number; left: number; width: number; startS: number; dur: number } | null>(null)
  const sliceAt = (clientX: number) => {
    const s = sliceRef.current!
    const frac = Math.max(0, Math.min(1, (clientX - s.left) / Math.max(1, s.width)))
    return { atS: s.startS + frac * s.dur, localX: frac * s.width }
  }
  const startSlice = (e: React.MouseEvent, index: number, startS: number, dur: number) => {
    // Left button only — armed via the 🪒 icon, or a direct Ctrl/Cmd+click.
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    sliceRef.current = { index, left: rect.left, width: rect.width, startS, dur }
    setSliceX(sliceAt(e.clientX).localX)
    const move = (ev: MouseEvent) => setSliceX(sliceAt(ev.clientX).localX)
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const s = sliceRef.current
      const at = s ? sliceAt(ev.clientX).atS : null
      sliceRef.current = null
      setSliceArmed(null)
      setSliceX(null)
      if (s && at != null) onSplitSegment(s.index, at)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // Esc cancels an armed (but not yet committed) slice.
  useEffect(() => {
    if (sliceArmed == null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSliceArmed(null); setSliceX(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sliceArmed])

  const updateSel = useCallback((s: Sel) => {
    selRef.current = s
    setSel(s)
    if (!s) setSelEditing(false)
  }, [])

  const total = Math.max(session.total_duration_s, 0.1)
  const laneWidth = Math.ceil(total * pxPerSec) + 240
  const flatSegs = useMemo(() => session.tracks.flatMap((t) => t.segments), [session])
  const starts = useMemo(
    () => Array.from(new Set(flatSegs.map((s) => Math.round(s.start_s * 1000) / 1000))).sort((a, b) => a - b),
    [flatSegs],
  )
  const trimSeg = trimIndex != null ? flatSegs.find((s) => s.index === trimIndex) : undefined
  // Merge is only valid for 2+ live segments on the SAME track.
  const selValid = useMemo(() => flatSegs.filter((s) => selSegs.has(s.index)), [flatSegs, selSegs])
  const selTrackCount = useMemo(() => new Set(selValid.map((s) => s.speaker_id)).size, [selValid])
  const canMerge = selValid.length >= 2 && selTrackCount === 1
  const doMerge = async () => {
    if (!canMerge) return
    setMerging(true)
    try {
      await onMergeSegments(selValid.map((s) => s.index))
      setSelSegs(new Set())
    } finally {
      setMerging(false)
    }
  }

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const rect = contentRef.current?.getBoundingClientRect()
      if (!rect) return 0
      return Math.max(0, Math.min(total, (clientX - rect.left) / pxPerSec))
    },
    [pxPerSec, total],
  )

  // Every segment edge (start + end) across all tracks — selection drags snap to
  // these so empty-space wipes land cleanly even when zoomed out.
  const edges = useMemo(() => {
    const e = new Set<number>()
    for (const s of flatSegs) {
      e.add(Math.round(s.start_s * 1000) / 1000)
      e.add(Math.round((s.start_s + s.duration_s) * 1000) / 1000)
    }
    return [...e].sort((a, b) => a - b)
  }, [flatSegs])
  const edgesRef = useRef<number[]>([])
  useEffect(() => { edgesRef.current = edges }, [edges])
  // Magnetic snap: pull a time to the nearest segment edge within ~8px (so the
  // pull strength is constant on screen at any zoom); otherwise round to 0.1s.
  const magnet = useCallback(
    (t: number) => {
      const tol = 8 / pxPerSec
      let best: number | null = null
      let bestD = tol
      for (const e of edgesRef.current) {
        const d = Math.abs(e - t)
        if (d <= bestD) { bestD = d; best = e }
      }
      return best != null ? Math.max(0, best) : snap(t)
    },
    [pxPerSec],
  )

  // Reset transient UI when the session is replaced.
  useEffect(() => {
    segAudioRef.current?.pause()
    setPlayingSeg(null)
    setEditingIndex(null)
    setInsert(null)
    setTrimIndex(null)
    setSegMenu(null)
    updateSel(null)
    setSelSegs(new Set())
    setGapVal(session.gap_ms)
    setSpeedVal(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // Drop pending text edits the server has committed.
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

  // Whenever the mix reloads (regen / move / add / trim / etc.) the player
  // remounts (key=mix_url) and resets to 0. Restore the playhead to where it was.
  // The seek is queued until the (possibly slow) audio finishes loading, and the
  // player honors the LATEST pending target — so a click during load wins.
  useEffect(() => {
    if (session.mix_url === mixRef.current) return
    mixRef.current = session.mix_url
    const t = headPosRef.current
    if (t > 0.01) playerRef.current?.seek(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.mix_url])

  // After any render (segment regen, insert, channel regen, full scene) play
  // what was just rendered. Defined after the restore effect on purpose: both
  // queue a seek on the remounted player, and the latest pending target wins.
  const cueNonceRef = useRef(0)
  const skipSegStopRef = useRef(false)
  useEffect(() => {
    if (!playCue || playCue.nonce === cueNonceRef.current) return
    cueNonceRef.current = playCue.nonce
    // A single-segment cue (regen / insert) is best heard in isolation — play the
    // freshly-baked clip alone, exactly like clicking its ▶. The session just
    // changed, so guard the "stop solo preview on session update" effect (which
    // runs right after this one) from killing the autoplay.
    if (playCue.index != null) {
      const s = flatSegs.find((sg) => sg.index === playCue.index)
      if (s) {
        skipSegStopRef.current = true
        playSeg(s)
        return
      }
    }
    let t = playCue.at ?? 0
    if (playCue.channel != null) {
      const tr = session.tracks.find((x) => x.speaker_id === playCue.channel)
      if (tr?.segments.length) t = Math.min(...tr.segments.map((sg) => sg.start_s))
    }
    playerRef.current?.seekAndPlay(Math.max(0, t - 0.02))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playCue])

  // Global drag listeners: segment move (incl. lifting onto another track),
  // trim-edge / fade-corner / dB-line tool drags, insert-ghost move,
  // delete-space select, and red-bar move/resize.
  useEffect(() => {
    const laneAt = (clientY: number) => {
      const rect = contentRef.current?.getBoundingClientRect()
      if (!rect) return 0
      return Math.max(0, Math.min(session.tracks.length - 1, Math.floor((clientY - rect.top - RULER_H) / rowH)))
    }
    const onMove = (e: MouseEvent) => {
      const p = pendingRef.current
      if (!p) return
      const dx = e.clientX - p.startX
      const dy = 'startY' in p ? e.clientY - p.startY : 0
      if (!activeRef.current && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      activeRef.current = true
      const dt = dx / pxPerSec
      if (p.kind === 'seg') {
        const cur = snap(p.origStart + dt)
        const lane = laneAt(e.clientY)
        dragRef.current = { index: p.index, cur, lane }
        setDrag({ index: p.index, cur, lane })
      } else if (p.kind === 'seg-l') {
        // Drag the left edge: trim the head; the clip's remaining audio keeps
        // its place on the timeline (start moves with the edge), like a DAW.
        const ts = Math.max(0, Math.min(p.origTrimStart + dt * p.speed, p.trimEnd - 0.05 * p.speed))
        updateTool({
          index: p.index,
          trimStart: Math.round(ts * 1000) / 1000,
          start: Math.max(0, Math.round((p.origStart + (ts - p.origTrimStart) / p.speed) * 1000) / 1000),
        })
      } else if (p.kind === 'seg-r') {
        const te = Math.max(p.trimStart + 0.05 * p.speed, Math.min(p.origTrimEnd + dt * p.speed, p.rawDur))
        updateTool({ index: p.index, trimEnd: Math.round(te * 1000) / 1000 })
      } else if (p.kind === 'fade') {
        const v = Math.max(0, Math.min(p.side === 'in' ? p.orig + dt : p.orig - dt, p.eff))
        const r = Math.round(v * 100) / 100
        updateTool(p.side === 'in' ? { index: p.index, fadeIn: r } : { index: p.index, fadeOut: r })
      } else if (p.kind === 'seg-gain') {
        // Vertical dB line: full row height spans ±18 dB around the leveled baseline.
        const g = Math.round(Math.max(-18, Math.min(18, p.orig - dy * (36 / p.pxRange))) * 10) / 10
        updateTool({ index: p.index, gain: g })
        // Float the dB readout next to the cursor — the segment's own tag can be
        // off-screen on long clips, so don't make the user eyeball line height.
        setGainDrag({ x: e.clientX, y: e.clientY, gain: g })
      } else if (p.kind === 'ghost') {
        setInsert((i) => (i ? { ...i, start_s: snap(p.origStart + dt) } : i))
      } else if (p.kind === 'select') {
        updateSel({ a: p.origStart, b: magnet(Math.max(0, p.origStart + dt)), mode: 'del' })
      } else if (p.kind === 'sel-move') {
        const mode = selRef.current?.mode ?? 'del'
        const w = p.origB - p.origA
        const na = Math.max(0, magnet(p.origA + dt))
        updateSel({ a: na, b: na + w, mode })
      } else if (p.kind === 'sel-l') {
        updateSel({ a: Math.max(0, magnet(p.origA + dt)), b: p.origB, mode: selRef.current?.mode ?? 'del' })
      } else if (p.kind === 'sel-r') {
        updateSel({ a: p.origA, b: Math.max(0, magnet(p.origB + dt)), mode: selRef.current?.mode ?? 'del' })
      } else if (p.kind === 'pan') {
        if (scrollRef.current) scrollRef.current.scrollLeft = p.origScroll - dx
      }
    }
    const onUp = () => {
      const p = pendingRef.current
      if (activeRef.current) {
        if (p?.kind === 'seg' && dragRef.current) {
          const d = dragRef.current
          if (d.lane !== p.fromLane) {
            // Dropped on another track: re-home the clip (audio unchanged —
            // regenerate to render it in the new track's voice).
            const dst = session.tracks[d.lane]
            const src = session.tracks[p.fromLane]
            if (dst && src && (dst.kind === 'audio') === (src.kind === 'audio')) {
              onMoveSegment(d.index, dst.speaker_id, d.cur)
            }
          } else {
            onEditSegment(d.index, { start_s: d.cur })
          }
        } else if (p?.kind === 'seg-l') {
          const t = toolRef.current
          if (t && t.trimStart != null) onEditSegment(p.index, { trim_start_s: t.trimStart, start_s: t.start })
        } else if (p?.kind === 'seg-r') {
          const t = toolRef.current
          if (t && t.trimEnd != null) onEditSegment(p.index, { trim_end_s: t.trimEnd })
        } else if (p?.kind === 'fade') {
          const t = toolRef.current
          if (t) onEditSegment(p.index, p.side === 'in' ? { fade_in_s: t.fadeIn } : { fade_out_s: t.fadeOut })
        } else if (p?.kind === 'seg-gain') {
          const t = toolRef.current
          if (t && t.gain != null) onEditSegment(p.index, { gain_db: t.gain })
        } else if (p?.kind === 'select') {
          const s = selRef.current
          if (!s || Math.abs(s.b - s.a) < 0.05) updateSel(null)
        }
        suppressClickRef.current = true
        setTimeout(() => (suppressClickRef.current = false), 60)
      }
      pendingRef.current = null
      dragRef.current = null
      activeRef.current = false
      setDrag(null)
      updateTool(null)
      setGainDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [pxPerSec, rowH, session, onEditSegment, onMoveSegment, updateSel, updateTool, magnet])

  // Spacebar = play/pause (unless typing, and never while a tool modal is open —
  // modals own the spacebar for their own players).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
        return
      if (document.querySelector('.modal-overlay, .modal-backdrop')) return
      if (e.code === 'Space') {
        e.preventDefault()
        playerRef.current?.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onTime = useCallback(
    (cur: number, dur: number, playing: boolean) => {
      // Ignore the (0,0) report a freshly-remounted player emits before its audio
      // has loaded — otherwise it wipes the position we want to restore to.
      if (dur <= 0) {
        setHead((h) => ({ ...h, playing }))
        return
      }
      headPosRef.current = cur
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

  // Solo preview plays the backend-rendered clip (trim + speed + level already
  // baked in) so it matches the mix exactly — no client-side trim math.
  const segBusRef = useRef(Symbol('seg-preview'))
  const stopSegPreview = useCallback(() => {
    segAudioRef.current?.pause()
    setPlayingSeg(null)
    releasePlayback(segBusRef.current)
  }, [])

  const playSeg = useCallback(
    (seg: MultitrackSegment) => {
      if (!segAudioRef.current) segAudioRef.current = new Audio()
      const a = segAudioRef.current
      if (playingSeg === seg.index) {
        stopSegPreview()
        return
      }
      claimPlayback(segBusRef.current, stopSegPreview)
      a.onended = () => stopSegPreview()
      a.src = seg.clip_url
      a.currentTime = 0
      a.play().then(() => setPlayingSeg(seg.index)).catch(() => stopSegPreview())
    },
    [playingSeg, stopSegPreview],
  )

  // Any session update re-renders clips (URLs cache-bust) — a solo preview that
  // kept playing the old audio couldn't be stopped from its clip. Kill it.
  useEffect(() => {
    // A regen/insert cue starts a solo preview of the just-rendered clip in the
    // same commit this session change lands — don't stop what we just started.
    if (skipSegStopRef.current) {
      skipSegStopRef.current = false
      return
    }
    if (playingSeg != null) stopSegPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const downloadSeg = (seg: MultitrackSegment) => {
    const aTag = document.createElement('a')
    aTag.href = `${seg.clip_url}&dl=1`
    aTag.click()
  }

  // Transport
  const seekTo = (t: number) => {
    headPosRef.current = t
    playerRef.current?.seek(t)
    setHead((h) => ({ ...h, cur: t }))
  }
  const prevSeg = () => {
    const t = [...starts].reverse().find((s) => s < head.cur - 0.05)
    seekTo(t ?? 0)
  }
  const nextSeg = () => {
    const t = starts.find((s) => s > head.cur + 0.05)
    if (t != null) seekTo(t)
  }

  const seekFromClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current || insert) return
      if (selRef.current) {
        updateSel(null)
        return
      }
      seekTo(timeFromClientX(e.clientX))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [insert, timeFromClientX, updateSel],
  )

  const startSegDrag = (e: React.MouseEvent, seg: MultitrackSegment) => {
    if (e.button !== 0) return // middle-click falls through to pan
    // Shift-click toggles the clip in the (sticky) merge selection — no drag/seek.
    if (e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      toggleSelSeg(seg.index)
      suppressClickRef.current = true
      setTimeout(() => (suppressClickRef.current = false), 80)
      return
    }
    const tgt = e.target as HTMLElement
    if (tgt.closest('.mtk-seg-bar, .mtk-seg-text, .mtk-seg-edit, .mtk-trim-h, .mtk-fade-h, .mtk-gain-line')) return
    pendingRef.current = {
      kind: 'seg',
      index: seg.index,
      origStart: seg.start_s,
      fromLane: laneIndexOf(seg.speaker_id),
      startX: e.clientX,
      startY: e.clientY,
    }
  }

  // Middle-button = pan the timeline like a canvas; left-drag on empty = select.
  const startContentDrag = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      pendingRef.current = { kind: 'pan', origScroll: scrollRef.current?.scrollLeft ?? 0, startX: e.clientX }
      return
    }
    if (e.button !== 0) return
    const tgt = e.target as HTMLElement
    if (tgt.closest('.mtk-seg, .mtk-ghost, .mtk-sel, button, input, textarea')) return
    if (insert) return
    pendingRef.current = { kind: 'select', origStart: magnet(Math.max(0, timeFromClientX(e.clientX))), startX: e.clientX }
  }

  // Zoom by a factor, holding the time at `viewportX` (px from the scroll
  // viewport's left edge) fixed under the anchor. Shared by shift+scroll (anchor
  // = cursor) and the +/− keys (anchor = viewport center).
  const zoomAt = useCallback(
    (factor: number, viewportX: number) => {
      const scrollEl = scrollRef.current
      if (!scrollEl) return
      const timeAtAnchor = (scrollEl.scrollLeft + viewportX) / pxPerSec
      const next = clampPps(pxPerSec * factor)
      if (next === pxPerSec) return
      setPxPerSec(next)
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, timeAtAnchor * next - viewportX)
      })
    },
    [pxPerSec],
  )

  // Shift + mouse wheel zooms, keeping the time under the cursor fixed.
  const onWheelZoom = (e: React.WheelEvent) => {
    if (!e.shiftKey) return
    e.preventDefault()
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - scrollEl.getBoundingClientRect().left)
  }

  // +/= zoom in, -/_ zoom out (main row and numpad), centered on the timeline's
  // visible middle. Ctrl/Cmd held → leave it to the browser's own page zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (document.querySelector('.modal-overlay, .modal-backdrop')) return
      const zoomIn = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd'
      const zoomOut = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract'
      if (!zoomIn && !zoomOut) return
      e.preventDefault()
      const scrollEl = scrollRef.current
      zoomAt(zoomIn ? 1.18 : 1 / 1.18, scrollEl ? scrollEl.clientWidth / 2 : 0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomAt])

  const openTrim = (seg: MultitrackSegment) => {
    setTrimIndex(seg.index)
    setTrimDraft({ trimStart: seg.trim_start_s, trimEnd: seg.trim_end_s, speed: seg.speed, gain: seg.gain_db || 0 })
    setTrimText(seg.text)
    setPreviewSpeed(seg.speed || 1)
  }
  const saveTrim = () => {
    if (trimIndex == null) return
    onEditSegment(trimIndex, {
      trim_start_s: trimDraft.trimStart,
      trim_end_s: trimDraft.trimEnd,
      speed: trimDraft.speed,
      gain_db: trimDraft.gain,
    })
    // Text changes in the trim panel are alignment (no regen flag).
    const orig = flatSegs.find((s) => s.index === trimIndex)?.text ?? ''
    if (trimText.trim() !== orig.trim()) onSetText(trimIndex, trimText.trim())
    setTrimIndex(null)
  }
  const whisperTrim = async () => {
    if (trimIndex == null) return
    setTranscribing('trim')
    const t = await onTranscribe(trimIndex, { trim_start_s: trimDraft.trimStart, trim_end_s: trimDraft.trimEnd, speed: trimDraft.speed })
    setTranscribing(null)
    if (t != null) setTrimText(t)
  }
  const whisperAlign = async (index: number) => {
    setTranscribing(index)
    const t = await onTranscribe(index)
    setTranscribing(null)
    if (t != null) onSetText(index, t)
  }

  const laneIndexOf = (sid: string) => session.tracks.findIndex((t) => t.speaker_id === sid)

  // Vertical drag on a track label's grip → reorder lanes. Purely organizational
  // (the mix is additive so nothing re-renders) — generative speakers renumber so
  // top-to-bottom always reads Speaker 1..N.
  const startTrackDrag = useCallback(
    (e: React.MouseEvent, from: number) => {
      e.preventDefault()
      e.stopPropagation()
      const slotAt = (clientY: number) => {
        const rect = labelsRef.current?.getBoundingClientRect()
        if (!rect) return from
        return Math.max(0, Math.min(session.tracks.length, Math.round((clientY - rect.top - RULER_H) / rowH)))
      }
      const st = { from, slot: from }
      trackDragRef.current = st
      setTrackDrag(st)
      const onMove = (ev: MouseEvent) => {
        const slot = slotAt(ev.clientY)
        if (trackDragRef.current && trackDragRef.current.slot !== slot) {
          trackDragRef.current = { from, slot }
          setTrackDrag({ from, slot })
        }
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        const s = trackDragRef.current
        trackDragRef.current = null
        setTrackDrag(null)
        if (!s) return
        const at = s.slot > s.from ? s.slot - 1 : s.slot
        if (at === s.from) return
        const ids = session.tracks.map((t) => t.speaker_id)
        const [moved] = ids.splice(s.from, 1)
        ids.splice(at, 0, moved)
        onReorderTracks(ids)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [session, rowH, onReorderTracks],
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

  const working = !!busy || regenIndex != null || finalizing
  return (
    <div className={`mtk${working ? ' working' : ''}`}>
      {gainDrag && (
        <div
          className="mtk-gain-float"
          style={{ position: 'fixed', left: gainDrag.x + 16, top: gainDrag.y - 10, zIndex: 1000, pointerEvents: 'none' }}
        >
          {gainDrag.gain >= 0 ? '+' : ''}{gainDrag.gain.toFixed(1)} dB
        </div>
      )}
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
          <Toggle checked={follow} onChange={setFollow} label="Follow" />
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Zoom
            <input type="range" min={MIN_PPS} max={MAX_PPS} step={2} value={pxPerSec} onChange={(e) => setPxPerSec(clampPps(parseInt(e.target.value, 10)))} title="Zoom — shift+scroll over the timeline, or the +/− keys" />
          </label>
          {selValid.length > 0 && (
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <button
                className="btn sm primary"
                disabled={!canMerge || busy || merging}
                title={canMerge
                  ? 'Merge the selected clips on this track into one continuous segment (gaps become silence)'
                  : 'Select 2+ clips on the SAME track to merge (shift-click clips)'}
                onClick={doMerge}
              >
                {merging ? '… ' : '🔗 '}Merge {selValid.length}
              </button>
              <button className="btn sm ghost" onClick={() => setSelSegs(new Set())} title="Clear the merge selection">✕</button>
            </div>
          )}
          <button className="btn sm ghost" onClick={onUndo} disabled={busy || !session.can_undo} title="Undo the last action (single step back — regenerate, move, trim, add, delete, etc.)">
            ↶ Undo
          </button>
          <button className="btn sm ghost" onClick={() => uploadInputRef.current?.click()} disabled={busy} title="Upload audio OR video files as new layered channels (soundtrack / SFX) — pick several at once; each lands on its own track. Video audio is stripped automatically.">
            ＋🎵 Audio channel
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept="audio/*,video/*"
            multiple
            style={{ display: 'none' }}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              // Each file lands as its own channel at the playhead (small foley/SFX
              // where you're working, not at t=0). Await sequentially so concurrent
              // session writes don't race.
              for (const f of files) {
                await onUploadChannel(f, f.name.replace(/\.[^.]+$/, ''), Math.max(0, head.cur))
              }
            }}
          />
          <button className="btn primary" onClick={onFinalize} disabled={busy || finalizing}>
            {finalizing ? <span className="spinner" /> : '✓'} Finalize audio
          </button>
        </div>
      </div>

      {/* Transport + global controls */}
      <div className="mtk-transport">
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm ghost" onClick={() => seekTo(0)} title="Start">⏮</button>
          <button className="btn sm ghost" onClick={prevSeg} title="Previous segment">◀</button>
          <button
            className={`btn sm playbtn ${head.playing ? 'live' : head.cur > 0.02 ? 'stopped' : 'idle'}`}
            onClick={() => playerRef.current?.toggle()}
            title="Play / pause (space)"
          >
            {head.playing ? '⏸' : '▶'}
          </button>
          <button className="btn sm ghost" onClick={nextSeg} title="Next segment">▶</button>
          <button className="btn sm ghost" onClick={() => seekTo(total)} title="End">⏭</button>
        </div>
        <div className="row" style={{ gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="hint mtk-glob" title="Global speed (re-flows the timeline; resets per-segment speeds)">
            Speed {speedVal.toFixed(2)}×
            <input
              type="range" min={0.5} max={1.5} step={0.05} value={speedVal} disabled={busy}
              onChange={(e) => setSpeedVal(parseFloat(e.target.value))}
              onMouseUp={() => onReflow({ speed: speedVal })}
              onTouchEnd={() => onReflow({ speed: speedVal })}
            />
          </label>
          <label className="hint mtk-glob" title="Gap between turns (re-flows the timeline sequentially)">
            Gap {gapVal}ms
            <input
              type="range" min={0} max={800} step={25} value={gapVal} disabled={busy}
              onChange={(e) => setGapVal(parseInt(e.target.value, 10))}
              onMouseUp={() => onReflow({ gap_ms: gapVal })}
              onTouchEnd={() => onReflow({ gap_ms: gapVal })}
            />
          </label>
        </div>
      </div>

      {/* Full stitched mix */}
      <AudioPlayer
        ref={playerRef}
        key={session.mix_url}
        url={session.mix_url}
        title="Full mix (auto-stitched)"
        filename={`${session.title || 'scene'}.wav`}
        autoPlay={false}
        waveHeight={Math.round(70 * vScale)}
        onTime={onTime}
      />

      <div className="mtk-grid" style={{ marginTop: 12 }}>
        <div className="mtk-labels" style={{ width: LABEL_W, position: 'relative' }} ref={labelsRef}>
          <button
            type="button"
            className="mtk-corner mtk-add-track"
            style={{ height: RULER_H }}
            disabled={!!busy}
            onClick={() => setAddTrack({ ...newSpeakerCfg(), ...(newTrackDefaults ?? {}) })}
            title="Add a new speaker track to the end of the stack"
          >
            + Speaker track
          </button>
          {session.tracks.map((t, ti) => (
            <ChannelLabel
              key={t.speaker_id}
              track={t}
              rowH={rowH}
              busy={!!busy || regenIndex != null}
              promoting={promoting === t.speaker_id}
              dragging={trackDrag?.from === ti}
              onGrip={(e) => startTrackDrag(e, ti)}
              onSetChannel={onSetChannel}
              onRegenChannel={onRegenChannel}
              onPromote={async (pos, name) => { setPromoting(pos); try { await onPromoteChannel(pos, name) } finally { setPromoting(null) } }}
              onCollapse={onCollapseTrack}
              onRemove={onRemoveTrack}
              lastTrack={session.tracks.length <= 1}
            />
          ))}
          {trackDrag && (
            <div className="mtk-track-drop" style={{ top: RULER_H + trackDrag.slot * rowH - 1 }} />
          )}
        </div>

        <div className="mtk-scroll" ref={scrollRef} onWheel={onWheelZoom}>
          <div
            className="mtk-content"
            ref={contentRef}
            style={{ width: laneWidth }}
            onClick={seekFromClick}
            onMouseDown={startContentDrag}
          >
            <div className="mtk-ruler" style={{ height: RULER_H }}>
              {ruler.map((t) => (
                <span key={t} className="mtk-tick" style={{ left: t * pxPerSec }}>{t}s</span>
              ))}
            </div>

            {session.tracks.map((t, ti) => {
              const hue = hueFor(t.speaker_id)
              const laneAudio = t.kind === 'audio'
              return (
                <div
                  key={t.speaker_id}
                  className={`mtk-lane${laneAudio ? ' audio' : ''}`}
                  style={{ height: rowH, backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px ${pxPerSec}px)` }}
                  onDoubleClick={(e) => {
                    if ((e.target as HTMLElement).closest('.mtk-seg')) return
                    // Close the gap the click sits IN: from the nearest clip-end
                    // before the click to the nearest clip-start after it — both
                    // measured across ALL tracks so it tracks the true silence at
                    // the cursor and never crushes clips on other tracks.
                    const clickT = timeFromClientX(e.clientX)
                    const all = session.tracks.flatMap((tr) =>
                      tr.segments.map((s) => ({ start: s.start_s, end: s.start_s + s.duration_s })),
                    )
                    const endsBefore = all.map((s) => s.end).filter((x) => x <= clickT + 1e-3)
                    const startsAfter = all.map((s) => s.start).filter((x) => x >= clickT - 1e-3)
                    let gapStart: number | undefined
                    let gapAmount: number | undefined
                    if (endsBefore.length && startsAfter.length) {
                      const gs = Math.max(...endsBefore)
                      const ge = Math.min(...startsAfter)
                      // Bail if any clip straddles the candidate gap (it'd be
                      // crushed) — e.g. a long bed on another track under the click.
                      const covered = all.some((s) => s.start < ge - 1e-3 && s.end > gs + 1e-3)
                      if (!covered && ge - gs > 0.05) {
                        gapStart = gs
                        gapAmount = ge - gs
                      }
                    }
                    setInsert({ kind: 'new', speakerId: t.speaker_id, start_s: snap(clickT), ripple: false, phase: 'menu', text: '', menuX: e.clientX, menuY: e.clientY, gapStart, gapAmount })
                  }}
                  title="Double-click an empty spot to add a segment"
                >
                  {t.segments.map((seg) => {
                    // Live (uncommitted) tool-drag overrides: trim edges, fades, gain.
                    const segTool = tool && tool.index === seg.index ? tool : null
                    const trimS = segTool?.trimStart ?? seg.trim_start_s ?? 0
                    const trimE = segTool?.trimEnd ?? seg.trim_end_s ?? seg.raw_duration_s ?? 0
                    const spd = seg.speed || 1
                    const liveDur =
                      segTool && (segTool.trimStart != null || segTool.trimEnd != null)
                        ? Math.max(0.05, (trimE - trimS) / spd)
                        : seg.duration_s || 0
                    // Dragging onto ANOTHER lane: the clip stays put (dimmed) and a
                    // ghost rides the cursor on the target lane instead.
                    const lifting = drag && drag.index === seg.index && drag.lane !== ti
                    const live =
                      drag && drag.index === seg.index && !lifting ? drag.cur : segTool?.start ?? seg.start_s
                    const left = live * pxPerSec
                    const width = Math.max(MIN_SEG_PX, liveDur * pxPerSec)
                    // `?? 0` matters: a backend that predates fades omits these
                    // fields, and `undefined.toFixed()` would blank the whole page.
                    const fadeIn = segTool?.fadeIn ?? seg.fade_in_s ?? 0
                    const fadeOut = segTool?.fadeOut ?? seg.fade_out_s ?? 0
                    const gain = segTool?.gain ?? seg.gain_db ?? 0
                    // Collapse inline controls into the ⋯ menu as the clip shrinks.
                    const tier = width >= 232 ? 4 : width >= 172 ? 3 : width >= 120 ? 2 : width >= 70 ? 1 : 0
                    const isPlaying = playingSeg === seg.index
                    const isRegen = regenIndex === seg.index
                    const isEditing = editingIndex === seg.index
                    const isTrimming = trimIndex === seg.index
                    const text = edits[seg.index] ?? seg.text
                    const dirty = edits[seg.index] !== undefined && edits[seg.index] !== seg.text
                    return (
                      <div
                        key={seg.index}
                        className={`mtk-seg${isRegen ? ' regen' : ''}${dirty ? ' dirty' : ''}${isTrimming ? ' trimming' : ''}${seg.inpaint ? ' inpaint' : ''}${seg.perform ? ' perform' : ''}${seg.perform?.dirty ? ' perform-dirty' : ''}${selSegs.has(seg.index) ? ' selected' : ''}${drag && drag.index === seg.index ? ' dragging' : ''}${lifting ? ' lifting' : ''}${sliceArmed === seg.index ? ' slice-armed' : ''}`}
                        style={{ left, width, background: `hsl(${hue} 45% 22%)`, borderColor: dirty ? 'var(--warn)' : `hsl(${hue} 60% 45%)` }}
                        title={sliceArmed === seg.index ? 'Press on the clip and release to slice here (Esc to cancel)' : `${text}\n(drag to move · pull up/down to another track · ctrl+click to slice)`}
                        onMouseDown={(e) => {
                          // Ctrl/Cmd+click = jump straight into a manual slice gesture
                          // (press-move-release). startSlice preventDefaults/stops so
                          // it won't also seek or start a segment drag.
                          if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
                            setSliceArmed(seg.index)
                            startSlice(e, seg.index, live, liveDur)
                            return
                          }
                          // Middle-click bubbles to the lanes for canvas-style pan.
                          if (e.button === 1) return
                          if (sliceArmed === seg.index) startSlice(e, seg.index, live, liveDur)
                          else startSegDrag(e, seg)
                        }}
                        onMouseMove={(e) => {
                          if (sliceArmed !== seg.index || sliceRef.current) return
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setSliceX(Math.max(0, Math.min(rect.width, e.clientX - rect.left)))
                        }}
                      >
                        <SegWave
                          sid={session.id}
                          seg={seg}
                          width={width}
                          height={rowH - 14}
                          trimStart={trimS}
                          trimEnd={trimE}
                          fadeIn={fadeIn}
                          fadeOut={fadeOut}
                          gainDb={gain}
                        />
                        {sliceArmed === seg.index && sliceX != null && (
                          <div className="mtk-slice-cursor" style={{ left: sliceX }} />
                        )}
                        <div className="mtk-seg-bar" onMouseDown={(e) => { e.stopPropagation(); if (e.button === 1) e.preventDefault() }} onClick={(e) => e.stopPropagation()}>
                          {tier >= 1 && (
                            <button className={`mtk-ic${isPlaying ? ' play-on' : ''}`} onClick={() => playSeg(seg)} title={isPlaying ? 'Stop' : 'Play'}>
                              {isPlaying ? '■' : '▶'}
                            </button>
                          )}
                          {tier >= 2 && (
                            <button className={`mtk-ic${dirty ? ' warn' : ''}`} onClick={() => onRegen(seg.index, dirty ? edits[seg.index].trim() : undefined)} disabled={busy} title={dirty ? 'Regenerate with edited line' : 'Regenerate'}>
                              {isRegen ? <span className="spinner sm" /> : '↻'}
                            </button>
                          )}
                          {tier >= 2 && !laneAudio && (
                            <button
                              className={`mtk-ic${seg.perform ? ' perf-on' : ''}`}
                              onClick={() => setPerfModal({ index: seg.index, mic: true, capture: true })}
                              title={
                                seg.perform
                                  ? `Edit vocal performance (${seg.perform.mode === 'voice' ? 'voice' : 'character'} · ${seg.perform.strength})`
                                  : 'Record / upload a vocal performance — act the line, paint this voice over it'
                              }
                            >
                              🎙
                            </button>
                          )}
                          {tier >= 4 && <button className="mtk-ic" onClick={() => startEdit(seg.index, text)} title="Edit dialogue">✎</button>}
                          {tier >= 4 && <button className="mtk-ic" onClick={() => downloadSeg(seg)} title="Download this slice">⬇</button>}
                          {tier >= 3 && (
                            <button className={`mtk-ic${isTrimming ? ' on' : ''}`} onClick={() => (isTrimming ? saveTrim() : openTrim(seg))} title={isTrimming ? 'Save trim' : 'Trim / speed'}>
                              {isTrimming ? '💾' : '✂'}
                            </button>
                          )}
                          {tier >= 4 && (
                            <button
                              className={`mtk-ic${sliceArmed === seg.index ? ' on' : ''}`}
                              onClick={() => { setSliceArmed((v) => (v === seg.index ? null : seg.index)); setSliceX(null) }}
                              title={sliceArmed === seg.index ? 'Slice armed — press on the clip & release to cut (Esc to cancel)' : 'Slice into two clips (or ctrl+click the clip)'}
                            >
                              🪒
                            </button>
                          )}
                          <button
                            className="mtk-ic"
                            title="More actions"
                            onClick={(e) => setSegMenu({ index: seg.index, x: e.clientX, y: e.clientY })}
                          >
                            ⋯
                          </button>
                          {tier >= 2 && spd !== 1 && <span className="mtk-badge">{spd.toFixed(2)}×</span>}
                          {tier >= 3 && <span className="mtk-seg-dur">{(seg.duration_s || 0).toFixed(1)}s</span>}
                        </div>
                        {isEditing ? (
                          <textarea
                            className="mtk-seg-edit"
                            autoFocus
                            value={editText}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditText(e.target.value)}
                            onFocus={(e) => focusTag(e.currentTarget, setEditText)}
                            onBlur={() => { blurTag(); commitEdit(seg.index) }}
                            onKeyDown={(e) => {
                              e.stopPropagation()
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                commitEdit(seg.index)
                              } else if (e.key === 'Escape') setEditingIndex(null)
                            }}
                          />
                        ) : (
                          <div className="mtk-seg-text" onClick={(e) => e.stopPropagation()} onDoubleClick={() => startEdit(seg.index, text)} title="Double-click to edit">
                            {dirty ? '✎ ' : ''}
                            {text}
                          </div>
                        )}
                        {/* DAW handles: trim edges, fade corners, dB line */}
                        {width >= 36 && !isEditing && (
                          <>
                            <div
                              className="mtk-trim-h l"
                              title="Drag to trim the clip start"
                              onMouseDown={(e) => {
                                if (e.button !== 0) return
                                e.stopPropagation()
                                pendingRef.current = {
                                  kind: 'seg-l',
                                  index: seg.index,
                                  origTrimStart: seg.trim_start_s,
                                  origStart: seg.start_s,
                                  speed: spd,
                                  trimEnd: seg.trim_end_s,
                                  startX: e.clientX,
                                }
                              }}
                            />
                            <div
                              className="mtk-trim-h r"
                              title="Drag to trim the clip end"
                              onMouseDown={(e) => {
                                if (e.button !== 0) return
                                e.stopPropagation()
                                pendingRef.current = {
                                  kind: 'seg-r',
                                  index: seg.index,
                                  origTrimEnd: seg.trim_end_s,
                                  trimStart: seg.trim_start_s,
                                  rawDur: seg.raw_duration_s,
                                  speed: spd,
                                  startX: e.clientX,
                                }
                              }}
                            />
                          </>
                        )}
                        {width >= 56 && !isEditing && (
                          <>
                            <div
                              className={`mtk-fade-h in${fadeIn > 0.01 ? ' set' : ''}`}
                              style={{ left: Math.min(Math.max(0, fadeIn * pxPerSec - 5), width - 14) }}
                              title={`Fade in · ${fadeIn.toFixed(2)}s — drag right to lengthen`}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return
                                e.stopPropagation()
                                pendingRef.current = {
                                  kind: 'fade',
                                  index: seg.index,
                                  side: 'in',
                                  orig: seg.fade_in_s || 0,
                                  eff: seg.duration_s || 0,
                                  startX: e.clientX,
                                }
                              }}
                            />
                            <div
                              className={`mtk-fade-h out${fadeOut > 0.01 ? ' set' : ''}`}
                              style={{ right: Math.min(Math.max(0, fadeOut * pxPerSec - 5), width - 14) }}
                              title={`Fade out · ${fadeOut.toFixed(2)}s — drag left to lengthen`}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return
                                e.stopPropagation()
                                pendingRef.current = {
                                  kind: 'fade',
                                  index: seg.index,
                                  side: 'out',
                                  orig: seg.fade_out_s || 0,
                                  eff: seg.duration_s || 0,
                                  startX: e.clientX,
                                }
                              }}
                            />
                          </>
                        )}
                        {rowH >= 56 && width >= 44 && !isEditing && (
                          <div
                            className={`mtk-gain-line${segTool?.gain != null ? ' active' : ''}${Math.abs(gain) > 0.05 ? ' set' : ''}`}
                            style={{ top: `calc(50% - ${(gain * (rowH - 24)) / 36}px)` }}
                            title={`Clip gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB — drag up/down`}
                            onMouseDown={(e) => {
                              if (e.button !== 0) return
                              e.stopPropagation()
                              pendingRef.current = {
                                kind: 'seg-gain',
                                index: seg.index,
                                orig: seg.gain_db || 0,
                                pxRange: rowH - 24,
                                startX: e.clientX,
                                startY: e.clientY,
                              }
                            }}
                          >
                            {(segTool?.gain != null || Math.abs(gain) > 0.05) && (
                              <span className="mtk-gain-tag">{gain >= 0 ? '+' : ''}{gain.toFixed(1)}dB</span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {/* Insert ghost */}
            {insert && insert.phase !== 'menu' && (
              <div
                className="mtk-ghost"
                style={{ left: insert.start_s * pxPerSec, width: GHOST_W, top: RULER_H + laneIndexOf(insert.speakerId) * rowH + 6, height: rowH - 12 }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => {
                  if ((e.target as HTMLElement).closest('button, input')) return
                  pendingRef.current = { kind: 'ghost', origStart: insert.start_s, startX: e.clientX }
                }}
              >
                {insert.phase === 'place' ? (
                  <div className="mtk-ghost-place">
                    <span className="mtk-ghost-time">{insert.kind === 'dup' ? 'copy ' : ''}@{insert.start_s.toFixed(1)}s {insert.ripple ? '· ripple' : ''}</span>
                    <div className="row" style={{ gap: 4 }}>
                      {insert.kind === 'dup' ? (
                        <button
                          className="mtk-ic on"
                          title="Drop copy here"
                          onClick={() => {
                            if (insert.srcIndex != null) onDuplicateSegment(insert.srcIndex, insert.start_s, insert.ripple)
                            setInsert(null)
                          }}
                        >✓</button>
                      ) : (
                        <button className="mtk-ic on" title="Insert here, then type" onClick={() => setInsert((i) => (i ? { ...i, phase: 'type' } : i))}>✓</button>
                      )}
                      <button className="mtk-ic" title="Cancel" onClick={() => setInsert(null)}>✕</button>
                    </div>
                  </div>
                ) : (
                  <input
                    className="mtk-ghost-input"
                    autoFocus
                    placeholder="Type dialogue, Enter…"
                    value={insert.text}
                    onChange={(e) => setInsert((i) => (i ? { ...i, text: e.target.value } : i))}
                    onFocus={(e) => focusTag(e.currentTarget, (next) => setInsert((i) => (i ? { ...i, text: next } : i)))}
                    onBlur={blurTag}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        if (insert.text.trim()) onInsertSegment(insert.speakerId, insert.text.trim(), insert.start_s, insert.ripple)
                        setInsert(null)
                      } else if (e.key === 'Escape') setInsert(null)
                    }}
                  />
                )}
              </div>
            )}

            {/* Lift-off ghost: a clip dragged onto another lane rides the cursor
                until dropped — the audio stays as-is, regenerate to re-voice it. */}
            {drag && (() => {
              const seg = flatSegs.find((s) => s.index === drag.index)
              if (!seg) return null
              const fromLane = laneIndexOf(seg.speaker_id)
              if (drag.lane === fromLane) return null
              const dst = session.tracks[drag.lane]
              const src = session.tracks[fromLane]
              const valid = !!dst && !!src && (dst.kind === 'audio') === (src.kind === 'audio')
              return (
                <div
                  className={`mtk-seg-ghost${valid ? '' : ' invalid'}`}
                  style={{
                    left: drag.cur * pxPerSec,
                    top: RULER_H + drag.lane * rowH + 6,
                    width: Math.max(MIN_SEG_PX, seg.duration_s * pxPerSec),
                    height: rowH - 12,
                  }}
                >
                  <span className="mtk-seg-ghost-tag">
                    {valid ? `→ ${dst.name} @ ${drag.cur.toFixed(1)}s` : '⃠ incompatible track'}
                  </span>
                </div>
              )
            })()}

            {/* Segment-edge guides — shown while a selection is active so empty-space
                wipes snap cleanly; the edge you're snapped to lights up. */}
            {sel && edges.map((e) => {
              const onEdge = Math.abs(e - sel.a) < 1e-3 || Math.abs(e - sel.b) < 1e-3
              return (
                <div
                  key={e}
                  className={`mtk-edge${onEdge ? ' on' : ''}`}
                  style={{ left: e * pxPerSec, height: RULER_H + session.tracks.length * rowH }}
                />
              )
            })}

            {sel && (() => {
              const a = Math.min(sel.a, sel.b)
              const w = Math.min(Math.abs(sel.b - sel.a), sel.mode === 'add' ? 60 : 1e9)
              const isAdd = sel.mode === 'add'
              const setWidth = (val: number) => {
                const v = Math.max(0.1, Math.min(val, isAdd ? 60 : 1e9))
                updateSel({ a, b: a + v, mode: sel.mode })
              }
              return (
                <>
                  <div
                    className={`mtk-sel${isAdd ? ' add' : ''}`}
                    style={{ left: a * pxPerSec, width: w * pxPerSec, top: RULER_H, height: session.tracks.length * rowH }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => {
                      if ((e.target as HTMLElement).closest('.mtk-sel-h')) return
                      e.stopPropagation()
                      pendingRef.current = { kind: 'sel-move', origA: a, origB: a + w, startX: e.clientX }
                    }}
                  >
                    <div className="mtk-sel-h l" onMouseDown={(e) => { e.stopPropagation(); pendingRef.current = { kind: 'sel-l', origA: a, origB: a + w, startX: e.clientX } }} />
                    <div className="mtk-sel-h r" onMouseDown={(e) => { e.stopPropagation(); pendingRef.current = { kind: 'sel-r', origA: a, origB: a + w, startX: e.clientX } }} />
                  </div>
                  <div className={`mtk-sel-menu${isAdd ? ' add' : ''}`} style={{ left: a * pxPerSec, top: RULER_H + 2 }} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                    {selEditing ? (
                      <input
                        className="mtk-sel-num"
                        type="number"
                        min={0.1}
                        max={isAdd ? 60 : undefined}
                        step={0.1}
                        defaultValue={w.toFixed(2)}
                        autoFocus
                        onBlur={(e) => { setWidth(parseFloat(e.target.value) || w); setSelEditing(false) }}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { setWidth(parseFloat((e.target as HTMLInputElement).value) || w); setSelEditing(false) }
                          else if (e.key === 'Escape') setSelEditing(false)
                        }}
                      />
                    ) : (
                      <span className="mtk-sel-dur" title="Double-click to set exact duration" onDoubleClick={() => setSelEditing(true)}>{w.toFixed(2)}s</span>
                    )}
                    {isAdd ? (
                      <button className="btn sm primary" onClick={() => { onAddSpace(a, w); updateSel(null) }}>⏱ Add space</button>
                    ) : (
                      <>
                        <button className="btn sm bad" onClick={() => { onDeleteSpace(a, w); updateSel(null) }}>🗑 Delete space</button>
                        <button
                          className="btn sm good"
                          title="Insert this much empty time at the selection start (pushes everything after it later)"
                          onClick={() => { onAddSpace(a, w); updateSel(null) }}
                        >
                          ⏱ Add space
                        </button>
                      </>
                    )}
                    <button className="btn sm ghost" onClick={() => updateSel(null)}>✕</button>
                  </div>
                </>
              )
            })()}

            {head.cur > 0 && (
              <div className="mtk-head" style={{ left: head.cur * pxPerSec, height: RULER_H + session.tracks.length * rowH }} />
            )}
          </div>
        </div>
      </div>

      <div
        className="mtk-vresize"
        onMouseDown={startVResize}
        onDoubleClick={() => setVScale(1)}
        title="Drag to grow/shrink the track rows + waveform · double-click to reset"
      >
        <span className="mtk-vresize-grip">⇕ rows {Math.round(vScale * 100)}%</span>
      </div>

      {/* Insert / duplicate mode menu */}
      {insert && insert.phase === 'menu' && (() => {
        const insertAudio = session.tracks.find((t) => t.speaker_id === insert.speakerId)?.kind === 'audio'
        return (
        <>
          <div className="mtk-backdrop" onClick={() => setInsert(null)} />
          <div ref={insertMenuRef} className="mtk-menu" style={{ left: insert.menuX, top: insert.menuY }}>
            {insert.kind === 'dup' ? (
              <>
                <div className="mtk-menu-title">Duplicate @ {insert.start_s.toFixed(1)}s</div>
                <button className="btn sm" onClick={() => setInsert((i) => (i ? { ...i, ripple: false, phase: 'place' } : i))}>
                  ⧉ Place copy (no update)
                </button>
                <button className="btn sm" onClick={() => setInsert((i) => (i ? { ...i, ripple: true, phase: 'place' } : i))}>
                  ⇥ Place copy (ripple — push later lines)
                </button>
              </>
            ) : (
              <>
                <div className="mtk-menu-title">{insertAudio ? '🎵 Uploaded audio track' : `Add @ ${insert.start_s.toFixed(1)}s`}</div>
                <button className="btn sm" disabled={insertAudio} title={insertAudio ? 'Uploaded audio tracks are not generative — promote it to a voice channel to add dialogue' : undefined} onClick={() => setInsert((i) => (i ? { ...i, ripple: false, phase: 'place' } : i))}>
                  ＋ Add segment (no update)
                </button>
                <button className="btn sm" disabled={insertAudio} title={insertAudio ? 'Uploaded audio tracks are not generative' : undefined} onClick={() => setInsert((i) => (i ? { ...i, ripple: true, phase: 'place' } : i))}>
                  ⇥ Add segment (ripple — push later lines)
                </button>
                <button
                  className="btn sm"
                  disabled={insertAudio}
                  title={insertAudio ? 'Uploaded audio tracks are not generative' : 'Speak the line, Whisper transcribes it, render it here in this track\u2019s voice'}
                  onClick={() => {
                    const speakerId = insert.speakerId
                    const startS = insert.start_s
                    setInsert(null)
                    setPerfModal({ draft: { speakerId, startS }, mic: true, capture: false })
                  }}
                >
                  🎙 Record dialog…
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    const a = insert.start_s
                    setInsert(null)
                    updateSel({ a, b: a + 3, mode: 'add' })
                  }}
                >
                  ⏱ Add empty playtime
                </button>
                {insert.gapAmount != null && insert.gapStart != null && (
                  <button
                    className="btn sm bad"
                    title="Close the gap between the previous and next clip, pulling everything downstream up"
                    onClick={() => { onDeleteSpace(insert.gapStart!, insert.gapAmount!); setInsert(null) }}
                  >
                    ⇤ Close gap (−{insert.gapAmount.toFixed(2)}s)
                  </button>
                )}
              </>
            )}
          </div>
        </>
        )
      })()}

      {/* Segment actions menu (also the full action set for collapsed clips) */}
      {segMenu && (() => {
        const seg = flatSegs.find((s) => s.index === segMenu.index)
        if (!seg) return null
        const dirty = edits[seg.index] !== undefined && edits[seg.index] !== seg.text
        const isPlaying = playingSeg === seg.index
        const canSplit = head.cur > seg.start_s + 0.05 && head.cur < seg.start_s + seg.duration_s - 0.05
        const track = session.tracks.find((t) => t.speaker_id === seg.speaker_id)
        const isAudioChan = track?.kind === 'audio'
        return (
          <>
            <div className="mtk-backdrop" onClick={() => setSegMenu(null)} />
            <div ref={segMenuRef} className="mtk-menu" style={{ left: segMenu.x, top: segMenu.y }}>
              <div className="mtk-menu-title">{(isAudioChan ? '🎵 ' : '') + (seg.text.slice(0, 32) || `Segment #${seg.index}`)}</div>
              <button className="btn sm" onClick={() => { playSeg(seg); setSegMenu(null) }}>{isPlaying ? '■ Stop' : '▶ Play'}</button>
              {!isAudioChan && (
                <button
                  className={`btn sm${seg.perform?.dirty ? ' perf-glow' : ''}`}
                  disabled={busy}
                  title={seg.perform ? 'Renders the vocal performance transfer (V2V)' : undefined}
                  onClick={() => { onRegen(seg.index, dirty ? edits[seg.index].trim() : undefined); setSegMenu(null) }}
                >
                  ↻ Regenerate{dirty ? ' (edited)' : seg.perform?.dirty ? ' (render performance)' : ''}
                </button>
              )}
              {!isAudioChan && (
                <button
                  className="btn sm"
                  title="Open the dialogue editor — comfortable editing for long lines, render in place, or flip on Capture Performance to act the line yourself"
                  onClick={() => { setPerfModal({ index: seg.index, mic: true, capture: false }); setSegMenu(null) }}
                >
                  ✎ Edit dialogue…
                </button>
              )}
              <button className="btn sm" onClick={() => { openTrim(seg); setSegMenu(null) }}>✂ Trim / speed</button>
              {!isAudioChan && (
                <button className="btn sm" disabled={transcribing != null} title="Transcribe the audio and align the displayed text — no regenerate" onClick={() => { setSegMenu(null); whisperAlign(seg.index) }}>
                  {transcribing === seg.index ? '… ' : '🎤 '}Update dialogue (Whisper)
                </button>
              )}
              <button className="btn sm" onClick={() => { downloadSeg(seg); setSegMenu(null) }}>⬇ Download slice</button>
              <div className="mtk-menu-sep" />
              <button className="btn sm" disabled={!canSplit} title={canSplit ? 'Split at the playhead' : 'Move the playhead inside this clip first'} onClick={() => { onSplitSegment(seg.index, head.cur); setSegMenu(null) }}>
                ⮂ Split at playhead
              </button>
              <button
                className="btn sm"
                title="Slice this clip in two — then press on the waveform and release at the exact cut point"
                onClick={() => { setSliceArmed(seg.index); setSliceX(null); setSegMenu(null) }}
              >
                🪒 Slice here…
              </button>
              {!isAudioChan && (
                <button
                  className="btn sm"
                  disabled={slicing != null}
                  title="Transcribe and auto-split this clip into one segment per sentence"
                  onClick={async () => { const i = seg.index; setSegMenu(null); setSlicing(i); try { await onAutoSlice(i) } finally { setSlicing(null) } }}
                >
                  {slicing === seg.index ? '… Slicing…' : '✁ Auto-slice by sentence'}
                </button>
              )}
              <button
                className="btn sm"
                title="Duplicate this clip — choose a spot to drop the copy"
                onClick={() => {
                  const start = snap(seg.start_s + seg.duration_s + 0.2)
                  setSegMenu(null)
                  setInsert({ kind: 'dup', srcIndex: seg.index, speakerId: seg.speaker_id, start_s: start, ripple: false, phase: 'menu', text: '', menuX: segMenu.x, menuY: segMenu.y })
                }}
              >
                ⧉ Duplicate…
              </button>
              {!isAudioChan && (
                <>
                  <div className="mtk-menu-sep" />
                  <button
                    className={`btn sm${seg.inpaint ? ' on' : ''}`}
                    disabled={inpainting != null}
                    title="Pin this clip's own current audio as the voice reference, then regenerate the line to speak it in that same voice (per-segment ADR). Channel vocal-processing still applies."
                    onClick={async () => { const i = seg.index; const en = !seg.inpaint; setSegMenu(null); setInpainting(i); try { await onSetInpaint(i, en) } finally { setInpainting(null) } }}
                  >
                    {inpainting === seg.index ? '… ' : seg.inpaint ? '☑ ' : '☐ '}Pin Current Voice to Segment{seg.inpaint ? ' (pinned)' : ''}
                  </button>
                  {seg.inpaint && (
                    <button
                      className={`btn sm${seg.preserve_nonvocal ? ' on' : ''}`}
                      disabled={inpainting != null || !seg.has_bed}
                      title={seg.has_bed
                        ? "Preserve non-vocal: mix this clip's original background (music/noise/room) back under the regenerated voice, trimmed to the new voice length."
                        : 'No non-vocal bed was captured (isolation unavailable for this clip).'}
                      onClick={async () => { const i = seg.index; const en = !seg.preserve_nonvocal; setSegMenu(null); setInpainting(i); try { await onSetPreserveNonvocal(i, en) } finally { setInpainting(null) } }}
                    >
                      {seg.preserve_nonvocal ? '☑ ' : '☐ '}Preserve non-vocal
                    </button>
                  )}
                  <div className="mtk-menu-sep" />
                  {!seg.perform ? (
                    <button
                      className="btn sm"
                      title="Act the line yourself (record or upload) and paint this clip's voice over YOUR performance — timing, emphasis, emotion preserved"
                      onClick={() => { setPerfModal({ index: seg.index, mic: true, capture: true }); setSegMenu(null) }}
                    >
                      🎙 Record/Upload Vocal Performance…
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn sm on"
                        onClick={() => { setPerfModal({ index: seg.index, mic: true, capture: true }); setSegMenu(null) }}
                      >
                        🎙 Edit performance ({seg.perform.mode === 'voice' ? 'voice' : 'character'} · {seg.perform.strength})
                      </button>
                      <button
                        className="btn sm"
                        title="Detach the performance — back to plain TTS regeneration"
                        onClick={async () => { const i = seg.index; setSegMenu(null); await onClearPerformance(i) }}
                      >
                        ✕ Remove performance
                      </button>
                    </>
                  )}
                </>
              )}
              <div className="mtk-menu-sep" />
              <button className="btn sm" onClick={() => { onDeleteSegment(seg.index, true); setSegMenu(null) }}>
                ⇤ Delete (ripple — pull later up)
              </button>
              <button className="btn sm bad" onClick={() => { onDeleteSegment(seg.index, false); setSegMenu(null) }}>
                🗑 Delete (leave gap)
              </button>
            </div>
          </>
        )
      })()}

      {/* Trim / speed tool modal */}
      {trimSeg && (
        <ToolModal
          open
          title={<span>✂ Trim / speed — “{trimSeg.text.slice(0, 48)}”</span>}
          onClose={() => setTrimIndex(null)}
          onSpace={() => trimPlayerRef.current?.toggle()}
          actions={
            <button className="btn sm primary" onClick={saveTrim}>💾 Save</button>
          }
        >
          <AudioPlayer
            ref={trimPlayerRef}
            key={`trim-${trimSeg.index}-${trimSeg.url}`}
            url={trimSeg.url}
            autoPlay={false}
            showDownload={false}
            initialStart={trimSeg.trim_start_s}
            initialEnd={trimSeg.trim_end_s}
            initialGain={trimSeg.gain_db || 0}
            playbackRate={previewSpeed}
            onTrimChange={(s, e) => setTrimDraft((d) => ({ ...d, trimStart: s, trimEnd: e }))}
            onGainChange={(g) => setTrimDraft((d) => ({ ...d, gain: g }))}
          />
          <div className="hint" style={{ marginTop: 6, opacity: 0.85 }}>Gain: {trimDraft.gain >= 0 ? '+' : ''}{trimDraft.gain.toFixed(1)} dB — set with the player's dB control; saved with the segment.</div>
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <span style={{ minWidth: 130 }}>Segment speed · {trimDraft.speed.toFixed(2)}×</span>
            <input
              type="range" min={0.5} max={1.5} step={0.05} value={trimDraft.speed} style={{ flex: 1 }}
              onChange={(e) => setTrimDraft((d) => ({ ...d, speed: parseFloat(e.target.value) }))}
              onMouseUp={() => setPreviewSpeed(trimDraft.speed)}
              onTouchEnd={() => setPreviewSpeed(trimDraft.speed)}
            />
          </label>
          <div className="hint" style={{ marginTop: 4, opacity: 0.8 }}>Preview speed updates when you release the slider.</div>

          <div className="flex-between" style={{ marginTop: 10, marginBottom: 4 }}>
            <span className="hint">Dialogue (aligns text to audio — no regenerate)</span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={whisperTrim} disabled={transcribing != null} title="Transcribe the trimmed clip with Whisper">
                {transcribing === 'trim' ? <span className="spinner sm" /> : '🎤'} Whisper
              </button>
              <button className="btn sm ghost" onClick={() => setTrimText(flatSegs.find((s) => s.index === trimIndex)?.text ?? '')} title="Revert to current text">
                ↺ Revert
              </button>
            </div>
          </div>
          <textarea
            className="input"
            rows={2}
            value={trimText}
            onChange={(e) => setTrimText(e.target.value)}
            onFocus={(e) => focusTag(e.currentTarget, setTrimText)}
            onBlur={blurTag}
            placeholder="Dialogue for this segment…"
          />
        </ToolModal>
      )}

      {/* Vocal performance / record-dialog tool modal */}
      {perfModal && (() => {
        const segIndex = 'index' in perfModal ? perfModal.index : null
        const seg = segIndex != null ? flatSegs.find((s) => s.index === segIndex) ?? null : null
        if (segIndex != null && !seg) return null
        const draft = 'draft' in perfModal ? perfModal.draft : null
        const spkId = seg?.speaker_id ?? draft?.speakerId
        const track = spkId != null ? session.tracks.find((t) => t.speaker_id === spkId) : undefined
        const targetVoice = track?.mode === 'clone' ? track?.voice ?? null : null
        return (
          <PerformanceModal
            seg={seg}
            draft={draft}
            defaultCapture={perfModal.capture}
            withMic={perfModal.mic}
            targetVoice={targetVoice}
            onSave={(i, wav, params) => onSetPerformance(i, wav, params)}
            onRender={(i, wav, params) => onRenderPerformance(i, wav, params)}
            onRenderPlain={(i, text) => onRegenAndWait(i, text)}
            onInsertRender={(text, perf) =>
              draft ? onInsertAndRender(draft.speakerId, text, draft.startS, perf) : Promise.resolve(null)
            }
            onSetText={(i, text) => onSetText(i, text)}
            onApplyOutput={(i, fields) => onEditSegment(i, fields)}
            onWhisper={onTranscribeClip}
            onVoiceSaved={onVoiceSaved}
            trimSilence={trimSilence}
            onClose={() => setPerfModal(null)}
          />
        )
      })()}

      {addTrack && (
        <ToolModal
          open
          title="🎚 Add speaker track"
          width={560}
          onClose={() => setAddTrack(null)}
          actions={
            <button
              className="btn sm good"
              onClick={() => { onAddSpeaker(addTrack); setAddTrack(null) }}
              title="Append this speaker as a new track at the bottom of the stack"
            >
              + Add track
            </button>
          }
        >
          <SpeakerCard
            index={session.tracks.filter((t) => t.kind !== 'audio').length + 1}
            config={addTrack}
            voices={voices}
            onChange={setAddTrack}
          />
          <div className="hint" style={{ marginTop: 10 }}>
            The new track lands at the bottom of the stack. Leave the transcript blank to auto-Whisper the reference on first render.
          </div>
        </ToolModal>
      )}

      <div className="hint" style={{ marginTop: 8 }}>
        Drag a clip to move — <strong>pull it up/down</strong> to drop it on another track (regenerate to re-voice) ·
        drag a clip's <strong>edges</strong> to trim, its <strong>top corners</strong> to fade in/out, the{' '}
        <strong>center line</strong> up/down for clip gain · drag the <strong>⠿ grip</strong> on a track pin to
        reorder tracks · <strong>shift+click</strong> clips to select &amp; <strong>Merge</strong> them ·
        <strong> shift+scroll</strong> or <strong>+/−</strong> to zoom · <strong>middle-drag</strong> to pan ·
        <strong> ctrl+click</strong> a clip to slice · ⋯ for all
        actions (play / regenerate / edit / trim / Whisper-align / download / split / duplicate / delete) · double-click an
        empty spot to <strong>add a line</strong>, <strong>add empty playtime</strong> or <strong>close a gap</strong> · drag
        across empty space to <strong>delete playtime</strong>. On a track pin: 🔊 mute, ⬓ collapse, ✕ delete. Spacebar
        plays/pauses; click the timeline to move the playhead. <strong>Finalize audio</strong> bakes it down and saves.
      </div>
    </div>
  )
}

function ChannelLabel({
  track,
  rowH,
  busy,
  promoting,
  dragging,
  onGrip,
  onSetChannel,
  onRegenChannel,
  onPromote,
  onCollapse,
  onRemove,
  lastTrack,
}: {
  track: MultitrackTrack
  rowH: number
  busy: boolean
  promoting: boolean
  dragging?: boolean
  onGrip?: (e: React.MouseEvent) => void
  onSetChannel: (pos: string, fields: { name?: string | null; gain_db?: number; muted?: boolean }) => void
  onRegenChannel: (pos: string) => void
  onPromote: (pos: string, name: string) => void
  onCollapse: (pos: string) => Promise<void>
  onRemove: (pos: string) => Promise<void>
  lastTrack?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(track.name)
  const [confirmDel, setConfirmDel] = useState(false)
  const [working, setWorking] = useState(false)
  const isAudio = track.kind === 'audio'
  const muted = !!track.muted
  const applied = track.gain_db ?? 0
  // Gain is edited freely as a local draft and only committed (one re-stitch /
  // player reload) when you hit the green check — fast clicks won't thrash.
  const [gainDraft, setGainDraft] = useState(applied)
  useEffect(() => { setGainDraft(applied) }, [applied])
  const gainDirty = Math.abs(gainDraft - applied) > 1e-6
  const bumpGain = (delta: number) =>
    setGainDraft((g) => Math.max(-36, Math.min(36, Math.round((g + delta) * 10) / 10)))
  const applyGain = () => { if (gainDirty) onSetChannel(track.speaker_id, { gain_db: gainDraft }) }
  const commitName = () => {
    setEditing(false)
    const v = draft.trim()
    if (v !== track.name) onSetChannel(track.speaker_id, { name: v })
  }
  const doDelete = async () => {
    if (track.segments.length === 0) {
      setWorking(true)
      try { await onRemove(track.speaker_id) } finally { setWorking(false) }
    } else {
      setConfirmDel(true)
    }
  }
  return (
    <div
      className={`mtk-label${muted ? ' muted' : ''}${dragging ? ' dragging' : ''}`}
      style={{ height: rowH, borderLeft: `3px solid hsl(${hueFor(track.speaker_id)} 70% 60%)` }}
      title={track.voice_name && track.voice_name !== track.name ? `Voice: ${track.voice_name}` : track.name}
    >
      {confirmDel && (
        <div className="mtk-label-confirm" onClick={(e) => e.stopPropagation()}>
          <span>Delete “{track.name}” &amp; {track.segments.length} seg?</span>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm bad" disabled={working} onClick={async () => { setWorking(true); try { await onRemove(track.speaker_id) } finally { setWorking(false); setConfirmDel(false) } }}>Delete</button>
            <button className="btn sm ghost" onClick={() => setConfirmDel(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="mtk-label-top">
        {onGrip && (
          <span className="mtk-grip" title="Drag to reorder tracks" onMouseDown={onGrip}>
            ⠿
          </span>
        )}
        {editing ? (
          <input
            className="mtk-name-edit"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') { setDraft(track.name); setEditing(false) }
            }}
          />
        ) : (
          <span
            className="mtk-label-name"
            onDoubleClick={() => { setDraft(track.name); setEditing(true) }}
            title="Double-click to rename channel"
          >
            {track.name}
          </span>
        )}
        <div className="mtk-label-actions">
          <button
            className={`mtk-label-x mute${muted ? ' on' : ''}`}
            onClick={() => onSetChannel(track.speaker_id, { muted: !muted })}
            title={muted ? 'Unmute track' : 'Mute track'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button
            className="mtk-label-x del"
            disabled={working || busy || lastTrack}
            onClick={doDelete}
            title={lastTrack ? 'A scene needs at least one track — add another before deleting this one' : 'Delete this track'}
          >
            ✕
          </button>
        </div>
      </div>
      {!isAudio && track.voice_name && track.voice_name !== track.name && (
        <span className="mtk-label-voice" title="Voice in this channel">🎙 {track.voice_name}</span>
      )}
      <div className="mtk-label-ctrls">
        <span className="mtk-label-sub">{track.segments.length} seg</span>
        <span className={`mtk-db${gainDirty ? ' dirty' : ''}`}>
          <button className="mtk-db-btn" onClick={() => bumpGain(-1)} title="−1 dB">−</button>
          <button className="mtk-db-val" onClick={() => setGainDraft(0)} title="Channel gain — click to zero (apply with ✓)">
            {gainDraft >= 0 ? '+' : ''}{gainDraft.toFixed(0)}dB
          </button>
          <button className="mtk-db-btn" onClick={() => bumpGain(1)} title="+1 dB">+</button>
          {gainDirty && (
            <button className="mtk-db-apply" onClick={applyGain} title="Apply channel gain">✓</button>
          )}
        </span>
        <button
          className="mtk-regen-all"
          disabled={busy || working || track.segments.length < 2}
          onClick={async () => { setWorking(true); try { await onCollapse(track.speaker_id) } finally { setWorking(false) } }}
          title="Collapse every clip on this track into one continuous segment (timing preserved)"
        >
          {working ? '…' : '⬓ flat'}
        </button>
        {!isAudio && (
          <button
            className="mtk-regen-all"
            disabled={busy || track.segments.length === 0}
            onClick={() => onRegenChannel(track.speaker_id)}
            title="Regenerate every segment on this channel (e.g. after re-casting the voice)"
          >
            ↻ all
          </button>
        )}
        {isAudio && (
          <button
            className="mtk-promote"
            disabled={busy || promoting || track.segments.length === 0}
            onClick={() => onPromote(track.speaker_id, track.name)}
            title="Promote to a voice track: clones the voice, transcribes the dialogue, adds a speaker slot, and removes this upload track"
          >
            {promoting ? '…' : '⭐'}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// In-clip waveform: amplitude peaks fetched once per audio revision (seg.rev),
// drawn bottom-pinned — only the upper envelope, half the pixels for the same
// information. Trim, gain and fades are applied at draw time, so live handle
// drags re-render instantly without refetching.
// ---------------------------------------------------------------------------
const peaksCache = new Map<string, { peaks: number[]; rawDur: number }>()
const PEAKS_CACHE_MAX = 500

function SegWave({
  sid,
  seg,
  width,
  height,
  trimStart,
  trimEnd,
  fadeIn,
  fadeOut,
  gainDb,
}: {
  sid: string
  seg: MultitrackSegment
  width: number
  height: number
  trimStart: number
  trimEnd: number
  fadeIn: number
  fadeOut: number
  gainDb: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const key = `${sid}:${seg.index}:${seg.rev}`
  const [data, setData] = useState<{ peaks: number[]; rawDur: number } | null>(() => peaksCache.get(key) ?? null)

  useEffect(() => {
    const hit = peaksCache.get(key)
    if (hit) {
      setData(hit)
      return
    }
    let alive = true
    // Resolution scales with clip length: ~150 peaks/sec (min 1200, capped at
    // 8000) so multi-minute clips don't get the blocky, stair-stepped "stretched"
    // look that a fixed low peak count gives.
    const dur = seg.raw_duration_s || seg.duration_s || 4
    const want = Math.min(8000, Math.max(1200, Math.round(dur * 150)))
    api
      .segmentPeaks(sid, seg.index, want)
      .then((r) => {
        if (!r.peaks.length || r.raw_duration_s <= 0) return
        const d = { peaks: r.peaks, rawDur: r.raw_duration_s }
        if (peaksCache.size > PEAKS_CACHE_MAX) peaksCache.clear()
        peaksCache.set(key, d)
        if (alive) setData(d)
      })
      .catch(() => {}) // background eye-candy — never surface an error
    return () => {
      alive = false
    }
  }, [key, sid, seg.index, seg.raw_duration_s, seg.duration_s])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    // Render the backing store at (device-pixel) the clip's on-screen width so the
    // waveform stays crisp instead of a low-res canvas stretched by CSS — capped
    // so an extreme zoom on a long clip doesn't allocate a huge per-segment canvas.
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.min(4096, Math.round(width * dpr)))
    const h = Math.max(1, Math.round(height * dpr))
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    const { peaks, rawDur } = data
    const te = trimEnd || rawDur
    const f0 = Math.max(0, Math.min(1, trimStart / rawDur))
    const f1 = Math.max(f0, Math.min(1, te / rawDur))
    const n = peaks.length
    const gain = Math.pow(10, gainDb / 20)
    const audDur = Math.max(0.01, (te - trimStart) / (seg.speed || 1))
    const fiFrac = Math.max(0, Math.min(1, fadeIn / audDur))
    const foFrac = Math.max(0, Math.min(1, fadeOut / audDur))
    const bw = Math.max(1, Math.round(1.5 * dpr))
    const bars = Math.max(1, Math.floor(w / bw))
    // Ice-white reads against every track hue (clip bodies are dark ~22% lightness).
    ctx.fillStyle = 'rgba(236, 245, 255, 0.62)'
    for (let i = 0; i < bars; i++) {
      const x = (i + 0.5) / bars
      const idx = Math.min(n - 1, Math.floor((f0 + x * (f1 - f0)) * n))
      let amp = Math.min(1, (peaks[idx] || 0) * gain)
      if (fiFrac > 0 && x < fiFrac) amp *= x / fiFrac
      if (foFrac > 0 && x > 1 - foFrac) amp *= (1 - x) / foFrac
      const bh = Math.max(1, amp * h * 0.96)
      ctx.fillRect(i * bw, h - bh, bw - 0.6, bh)
    }
    // Fade envelope lines (corner → top), the classic DAW read.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth = 1
    if (fiFrac > 0.004) {
      ctx.beginPath()
      ctx.moveTo(0, h)
      ctx.lineTo(fiFrac * w, 0)
      ctx.stroke()
    }
    if (foFrac > 0.004) {
      ctx.beginPath()
      ctx.moveTo(w, h)
      ctx.lineTo(w - foFrac * w, 0)
      ctx.stroke()
    }
  }, [data, width, height, trimStart, trimEnd, fadeIn, fadeOut, gainDb, seg.speed])

  return <canvas ref={canvasRef} className="mtk-seg-wave" aria-hidden />
}
