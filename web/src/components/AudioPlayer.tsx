import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { claimPlayback, releasePlayback } from '../audioBus'

export interface AudioPlayerHandle {
  seek: (t: number) => void
  seekAndPlay: (t: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
  /** Render the current trim window + output gain into a WAV Blob (same bake as
   * the ⬇ Download button). Returns null if the buffer isn't decoded yet. */
  exportBlob: () => Promise<Blob | null>
  /** Current trim window + gain, in the clip's own timebase. */
  getEdits: () => { start: number; end: number; duration: number; gainDb: number }
}

function fmt(t: number) {
  if (!isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const cs = Math.floor((t * 100) % 100) // hundredths — audio needs sub-second accuracy
  return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

function encodeWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels
  const sr = buffer.sampleRate
  const len = buffer.length
  const data = new DataView(new ArrayBuffer(44 + len * numCh * 2))
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) data.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  data.setUint32(4, 36 + len * numCh * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, numCh, true)
  data.setUint32(24, sr, true)
  data.setUint32(28, sr * numCh * 2, true)
  data.setUint16(32, numCh * 2, true)
  data.setUint16(34, 16, true)
  writeStr(36, 'data')
  data.setUint32(40, len * numCh * 2, true)
  const chans: Float32Array[] = []
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c))
  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]))
      data.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([data], { type: 'audio/wav' })
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, {
  url: string
  title?: string
  filename?: string
  autoPlay?: boolean
  showDownload?: boolean
  showPlay?: boolean
  downloadUrl?: string
  encodeUrl?: string
  initialStart?: number
  initialEnd?: number
  initialGain?: number
  playbackRate?: number
  waveHeight?: number
  onTrimChange?: (start: number, end: number, duration: number) => void
  onGainChange?: (gainDb: number) => void
  onTime?: (cur: number, duration: number, playing: boolean) => void
}>(function AudioPlayer({
  url,
  title,
  filename,
  autoPlay = true,
  showDownload = true,
  showPlay = true,
  downloadUrl,
  encodeUrl,
  initialStart,
  initialEnd,
  initialGain,
  playbackRate = 1,
  waveHeight = 70,
  onTrimChange,
  onGainChange,
  onTime,
}, ref) {
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const srcNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingAutoplayRef = useRef(false)
  const pendingSeekRef = useRef<{ t: number; play: boolean } | null>(null)
  const playingRef = useRef(false)
  const busIdRef = useRef(Symbol('audio-player'))

  const [duration, setDuration] = useState(0)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [gainDb, setGainDb] = useState(0)
  const [playing, setPlaying] = useState(false)
  // Has playback ever started (and then stopped)? Drives the three-state play
  // button: resting green → playing green → stopped red.
  const [started, setStarted] = useState(false)
  const [cur, setCur] = useState(0)
  const [downloading, setDownloading] = useState(false)
  // Visible window in seconds (zoom/pan). Trim times live in absolute seconds,
  // so they survive any amount of zooming or going off-screen.
  const [view, setView] = useState<{ t0: number; t1: number }>({ t0: 0, t1: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const trimRef = useRef({ start: 0, end: 0 })
  trimRef.current = { start, end }
  // Active handle drag: which handle, its pre-grab value (for cancel), and
  // whether the pointer is currently over the waveform.
  const handleDragRef = useRef<{ which: 'start' | 'end'; orig: number; over: boolean } | null>(null)
  const [dragTick, setDragTick] = useState(0) // repaint trigger during drags

  // Decode the audio once for the waveform + offline processing on download.
  useEffect(() => {
    let cancelled = false
    setPlaying(false)
    setCur(0)
    setGainDb(initialGain ?? 0)
    pendingAutoplayRef.current = autoPlay
    ;(async () => {
      try {
        const resp = await fetch(url)
        const arr = await resp.arrayBuffer()
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const buf = await ctx.decodeAudioData(arr)
        ctx.close()
        if (cancelled) return
        bufferRef.current = buf
        setDuration(buf.duration)
        setStart(initialStart != null ? Math.max(0, Math.min(initialStart, buf.duration)) : 0)
        setEnd(initialEnd != null ? Math.max(0, Math.min(initialEnd, buf.duration)) : buf.duration)
        setView({ t0: 0, t1: buf.duration })
        draw(0)
      } catch {
        /* decoding failed (e.g. unsupported) — controls still work via element */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // Map an absolute time to canvas x for the current view window.
  const timeToX = useCallback((t: number, w: number) => {
    const v = viewRef.current
    const span = Math.max(1e-6, v.t1 - v.t0)
    return ((t - v.t0) / span) * w
  }, [])
  const xToTime = useCallback((x: number, w: number) => {
    const v = viewRef.current
    const span = Math.max(1e-6, v.t1 - v.t0)
    return v.t0 + (x / Math.max(1, w)) * span
  }, [])

  const HANDLE_GRAB_PX = 9

  // Where a handle is drawn: its real x, or ghosted at the edge when the trim
  // point is outside the visible window (still grabbable there).
  const handleDrawX = useCallback(
    (t: number, w: number): { x: number; ghost: 'left' | 'right' | null } => {
      const x = timeToX(t, w)
      if (x < 0) return { x: 5, ghost: 'left' }
      if (x > w) return { x: w - 5, ghost: 'right' }
      return { x, ghost: null }
    },
    [timeToX],
  )

  const draw = useCallback(
    (playhead: number) => {
      const canvas = canvasRef.current
      const buf = bufferRef.current
      if (!canvas || !buf) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      const v = viewRef.current
      const span = Math.max(1e-6, v.t1 - v.t0)

      // Per-draw peaks over the visible window (stride-sampled so even fully
      // zoomed-out long clips stay cheap).
      const ch = buf.getChannelData(0)
      const sr = buf.sampleRate
      const bars = Math.max(64, Math.floor(w / 2))
      const s0 = Math.floor(v.t0 * sr)
      const block = Math.max(1, Math.floor((span * sr) / bars))
      const stride = Math.max(1, Math.floor(block / 64))
      const gain = Math.pow(10, gainDb / 20)
      const sx = timeToX(start, w)
      const ex = timeToX(end, w)
      const bw = w / bars
      for (let i = 0; i < bars; i++) {
        let max = 0
        const base = s0 + i * block
        for (let j = 0; j < block; j += stride) {
          const val = Math.abs(ch[base + j] || 0)
          if (val > max) max = val
        }
        const x = i * bw
        const inRegion = x + bw >= sx && x <= ex
        const amp = Math.min(1, max * gain)
        const bh = Math.max(1, amp * (h * 0.92))
        ctx.fillStyle = inRegion ? '#6d8bff' : '#33405e'
        ctx.fillRect(x, (h - bh) / 2, Math.max(1, bw - 0.5), bh)
      }
      // Dim outside the trim region.
      ctx.fillStyle = 'rgba(10,14,24,.55)'
      if (sx > 0) ctx.fillRect(0, 0, Math.min(sx, w), h)
      if (ex < w) ctx.fillRect(Math.max(0, ex), 0, w - Math.max(0, ex), h)

      // Playhead.
      const px = timeToX(playhead, w)
      if (px >= 0 && px <= w) {
        ctx.fillStyle = '#ff6b7d'
        ctx.fillRect(px - 0.5, 0, 1.5, h)
      }

      // Trim handles — start green, end red; ghosted at the edge when their
      // time is off-screen (translucent + arrow showing which way it lives).
      const drawHandle = (t: number, color: string, which: 'start' | 'end') => {
        const { x, ghost } = handleDrawX(t, w)
        ctx.save()
        ctx.globalAlpha = ghost ? 0.45 : 1
        ctx.fillStyle = color
        ctx.fillRect(x - 1, 0, 2, h)
        if (ghost) ctx.setLineDash([3, 3])
        // Grab tab: flag at the top pointing into the kept region.
        const dir = which === 'start' ? 1 : -1
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x + 9 * dir, 0)
        ctx.lineTo(x + 9 * dir, 7)
        ctx.lineTo(x, 12)
        ctx.closePath()
        ctx.fill()
        if (ghost) {
          // Arrow pointing off-screen toward the real position.
          const ax = ghost === 'left' ? x + 4 : x - 4
          const adir = ghost === 'left' ? -1 : 1
          ctx.beginPath()
          ctx.moveTo(ax + 4 * adir, h / 2)
          ctx.lineTo(ax, h / 2 - 5)
          ctx.lineTo(ax, h / 2 + 5)
          ctx.closePath()
          ctx.fill()
        }
        ctx.restore()
      }
      drawHandle(start, '#34d399', 'start')
      drawHandle(end, '#ef4444', 'end')

      // Zoom indicator.
      if (v.t0 > 0.01 || v.t1 < duration - 0.01) {
        ctx.fillStyle = 'rgba(255,255,255,.55)'
        ctx.font = '9px sans-serif'
        ctx.fillText(`${fmt(v.t0)} – ${fmt(v.t1)}  (shift+scroll: zoom · scroll: pan)`, 6, h - 5)
      }
    },
    [duration, start, end, gainDb, timeToX, handleDrawX],
  )

  useEffect(() => {
    draw(cur)
  }, [draw, cur, waveHeight, view, dragTick])

  // Report the trim window to a parent (Voice Lab uses this to send the cut to
  // the backend). Fires whenever the region or loaded duration changes.
  useEffect(() => {
    onTrimChange?.(start, end, duration)
  }, [start, end, duration, onTrimChange])

  // Report manual gain so the multitrack trim panel can persist per-segment dB.
  useEffect(() => {
    onGainChange?.(gainDb)
  }, [gainDb, onGainChange])

  // Report playback position (drives the multitrack playhead).
  useEffect(() => {
    onTime?.(cur, duration, playing)
  }, [cur, duration, playing, onTime])

  const ensureGraph = useCallback(() => {
    if (!audioElRef.current) return
    if (!ctxRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      const srcNode = ctx.createMediaElementSource(audioElRef.current)
      const gainNode = ctx.createGain()
      srcNode.connect(gainNode)
      gainNode.connect(ctx.destination)
      ctxRef.current = ctx
      srcNodeRef.current = srcNode
      gainNodeRef.current = gainNode
    }
    if (gainNodeRef.current) gainNodeRef.current.gain.value = Math.pow(10, gainDb / 20)
  }, [gainDb])

  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = Math.pow(10, gainDb / 20)
  }, [gainDb])

  // Pitch-preserving speed preview (browser time-stretch, no echo).
  useEffect(() => {
    const el = audioElRef.current as (HTMLAudioElement & { preservesPitch?: boolean }) | null
    if (el) {
      el.preservesPitch = true
      el.playbackRate = playbackRate || 1
    }
  }, [playbackRate])

  const tick = useCallback(() => {
    const el = audioElRef.current
    if (!el) return
    // Clamp the stop point to the media element's real duration: the decoded
    // AudioBuffer can run a hair longer than the <audio> element (codec/encoder
    // padding on MP3s especially), so currentTime may never reach `end` — the
    // element just fires 'ended' and we'd otherwise never flip `playing` off.
    const stopAt = el.duration ? Math.min(end, el.duration) : end
    if (el.ended || el.currentTime >= stopAt) {
      el.pause()
      el.currentTime = start
      setPlaying(false)
      setCur(start)
      releasePlayback(busIdRef.current)
      return
    }
    setCur(el.currentTime)
    rafRef.current = requestAnimationFrame(tick)
  }, [start, end])

  // Safety net: if the element ends on its own (duration mismatch, rAF throttled
  // in a background tab), reset the button instead of leaving it stuck on Stop.
  const handleEnded = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    const el = audioElRef.current
    if (el) el.currentTime = start
    setPlaying(false)
    setCur(start)
    releasePlayback(busIdRef.current)
  }, [start])

  const stop = useCallback(() => {
    const el = audioElRef.current
    if (el) el.pause()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
    releasePlayback(busIdRef.current)
  }, [])

  const play = useCallback(async () => {
    const el = audioElRef.current
    if (!el) return
    claimPlayback(busIdRef.current, stop)
    ensureGraph()
    ;(el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true
    el.playbackRate = playbackRate || 1
    if (ctxRef.current?.state === 'suspended') await ctxRef.current.resume()
    if (el.currentTime < start || el.currentTime >= end) el.currentTime = start
    await el.play().catch(() => {})
    setPlaying(true)
    setStarted(true)
    rafRef.current = requestAnimationFrame(tick)
  }, [start, end, ensureGraph, tick, playbackRate, stop])

  // Imperative seek (used by the multitrack timeline). Queues until the media
  // element knows its duration so it works right after a remount.
  const applySeek = useCallback(() => {
    const el = audioElRef.current
    const p = pendingSeekRef.current
    if (!el || !p) return
    const go = () => {
      const dur = el.duration || duration || 0
      const t = Math.max(0, dur ? Math.min(p.t, dur) : p.t)
      ensureGraph()
      el.currentTime = t
      setCur(t)
      pendingSeekRef.current = null
      if (p.play) {
        claimPlayback(busIdRef.current, stop)
        if (ctxRef.current?.state === 'suspended') ctxRef.current.resume()
        el.play()
          .then(() => {
            setPlaying(true)
            if (rafRef.current) cancelAnimationFrame(rafRef.current)
            rafRef.current = requestAnimationFrame(tick)
          })
          .catch(() => {})
      }
    }
    if (el.readyState >= 1 && el.duration) go()
    else el.addEventListener('loadedmetadata', go, { once: true })
  }, [duration, ensureGraph, tick, stop])

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  // If this player unmounts while holding the bus, let go of it.
  useEffect(() => () => releasePlayback(busIdRef.current), [])

  // Bake the current trim window + output gain into a WAV blob (no pitch-altering
  // speed — that's applied non-destructively on the timeline). Shared by the ⬇
  // Download button and the imperative `exportBlob()` (Sound Lab library save).
  const renderEditedBlob = useCallback(async (): Promise<Blob | null> => {
    const buf = bufferRef.current
    if (!buf) return null
    const sr = buf.sampleRate
    const s = Math.floor(start * sr)
    const e = Math.floor(end * sr)
    const len = Math.max(1, e - s)
    const offline = new OfflineAudioContext(buf.numberOfChannels, len, sr)
    const sliced = offline.createBuffer(buf.numberOfChannels, len, sr)
    for (let c = 0; c < buf.numberOfChannels; c++) {
      sliced.copyToChannel(buf.getChannelData(c).subarray(s, e), c)
    }
    const node = offline.createBufferSource()
    node.buffer = sliced
    const g = offline.createGain()
    g.gain.value = Math.pow(10, gainDb / 20)
    node.connect(g)
    g.connect(offline.destination)
    node.start()
    const rendered = await offline.startRendering()
    return encodeWav(rendered)
  }, [start, end, gainDb])

  useImperativeHandle(
    ref,
    () => ({
      seek: (t: number) => {
        pendingSeekRef.current = { t, play: false }
        applySeek()
      },
      seekAndPlay: (t: number) => {
        pendingSeekRef.current = { t, play: true }
        applySeek()
      },
      play: () => play(),
      pause: () => stop(),
      toggle: () => (playingRef.current ? stop() : play()),
      exportBlob: () => renderEditedBlob(),
      getEdits: () => ({ start, end, duration, gainDb }),
    }),
    [applySeek, play, stop, renderEditedBlob, start, end, duration, gainDb],
  )

  // Auto-play once the buffer is decoded (so start/end are set first). Runs after
  // a user-initiated generation, so the page already has audio permission.
  useEffect(() => {
    if (duration > 0 && pendingAutoplayRef.current) {
      pendingAutoplayRef.current = false
      play()
    }
  }, [duration, play])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      ctxRef.current?.close().catch(() => {})
    }
  }, [])

  const reset = () => {
    stop()
    setStart(0)
    setEnd(duration)
    setGainDb(0)
    setCur(0)
    setStarted(false)
    setView({ t0: 0, t1: duration })
    if (audioElRef.current) audioElRef.current.currentTime = 0
  }

  // ---- waveform pointer interactions: handle dragging + click-to-seek ----
  const onWaveMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const w = rect.width

    // Middle-button drag → pan the visible window horizontally (grab-scroll).
    // preventDefault stops the browser's middle-click autoscroll cursor.
    if (e.button === 1) {
      e.preventDefault()
      const v0 = { ...viewRef.current }
      const span = Math.max(1e-6, v0.t1 - v0.t0)
      const startX = e.clientX
      const onMove = (ev: MouseEvent) => {
        const dur = duration
        if (!dur) return
        let dt = -((ev.clientX - startX) / Math.max(1, w)) * span
        let t0 = v0.t0 + dt
        let t1 = v0.t1 + dt
        if (t0 < 0) { t1 -= t0; t0 = 0 }
        if (t1 > dur) { t0 -= t1 - dur; t1 = dur }
        setView({ t0: Math.max(0, t0), t1: Math.min(dur, t1) })
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }
    // Hit-test handles at their drawn (possibly ghosted) position; when both
    // are within grab range prefer the closer one.
    const hs = handleDrawX(trimRef.current.start, w)
    const he = handleDrawX(trimRef.current.end, w)
    const dS = Math.abs(x - hs.x)
    const dE = Math.abs(x - he.x)
    let which: 'start' | 'end' | null = null
    if (dS <= HANDLE_GRAB_PX && dS <= dE) which = 'start'
    else if (dE <= HANDLE_GRAB_PX) which = 'end'

    if (which) {
      e.preventDefault()
      const orig = which === 'start' ? trimRef.current.start : trimRef.current.end
      handleDragRef.current = { which, orig, over: true }
      const setVal = (t: number) => {
        const { start: s, end: en } = trimRef.current
        if (handleDragRef.current!.which === 'start') setStart(Math.max(0, Math.min(t, en - 0.05)))
        else setEnd(Math.min(duration, Math.max(t, s + 0.05)))
      }
      const onMove = (ev: MouseEvent) => {
        const r = canvas.getBoundingClientRect()
        const over =
          ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 24 && ev.clientY <= r.bottom + 24
        handleDragRef.current!.over = over
        if (over) {
          setVal(xToTime(ev.clientX - r.left, r.width))
        } else {
          // Preview the cancel: snap back to where it was grabbed from.
          setVal(handleDragRef.current!.orig)
        }
        setDragTick((n) => n + 1)
      }
      const onUp = (ev: MouseEvent) => {
        const r = canvas.getBoundingClientRect()
        const over =
          ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 24 && ev.clientY <= r.bottom + 24
        if (!over) setVal(handleDragRef.current!.orig) // released off the waveform → cancel the grab
        handleDragRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setDragTick((n) => n + 1)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      return
    }

    // Plain click → seek.
    const t = Math.max(trimRef.current.start, Math.min(trimRef.current.end, xToTime(x, w)))
    setCur(t)
    if (audioElRef.current) audioElRef.current.currentTime = t
  }

  const onWaveMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (handleDragRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const hs = handleDrawX(trimRef.current.start, rect.width)
    const he = handleDrawX(trimRef.current.end, rect.width)
    const near = Math.abs(x - hs.x) <= HANDLE_GRAB_PX || Math.abs(x - he.x) <= HANDLE_GRAB_PX
    e.currentTarget.style.cursor = near ? 'ew-resize' : 'pointer'
  }

  // Shift+scroll → zoom around the cursor; plain scroll → pan when zoomed in.
  // Native listener so preventDefault actually blocks page scroll.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      const dur = duration
      if (!dur) return
      const v = viewRef.current
      const span = Math.max(1e-6, v.t1 - v.t0)
      if (e.shiftKey) {
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const anchor = v.t0 + frac * span
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
        const factor = delta > 0 ? 1.3 : 1 / 1.3
        const minSpan = Math.min(0.25, dur)
        const newSpan = Math.max(minSpan, Math.min(dur, span * factor))
        let t0 = anchor - frac * newSpan
        let t1 = t0 + newSpan
        if (t0 < 0) {
          t1 -= t0
          t0 = 0
        }
        if (t1 > dur) {
          t0 -= t1 - dur
          t1 = dur
        }
        setView({ t0: Math.max(0, t0), t1: Math.min(dur, t1) })
      } else if (span < dur - 1e-3) {
        e.preventDefault()
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
        let dt = delta * span * 0.0015
        dt = Math.max(-v.t0, Math.min(dur - v.t1, dt))
        setView({ t0: v.t0 + dt, t1: v.t1 + dt })
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [duration])

  const download = async () => {
    // Server-side download (honors the configured FLAC/MP3 export format).
    // Fetch as a blob rather than pointing an <a> at the URL: a plain anchor
    // navigation trips the app's beforeunload "leave site?" guard before the
    // browser sees Content-Disposition. The blob URL downloads with no nav, and
    // we lift the real filename (+ extension) from the response header.
    if (downloadUrl) {
      setDownloading(true)
      try {
        const res = await fetch(downloadUrl)
        if (!res.ok) throw new Error('Download failed')
        const cd = res.headers.get('Content-Disposition') || ''
        const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd)
        const name = m ? decodeURIComponent(m[1]) : (filename || 'mix')
        const blob = await res.blob()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = name
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      } finally {
        setDownloading(false)
      }
      return
    }
    const buf = bufferRef.current
    if (!buf) {
      // Fallback: download the raw file.
      const a = document.createElement('a')
      a.href = url
      a.download = filename || 'audio.wav'
      a.click()
      return
    }
    setDownloading(true)
    try {
      const blob = await renderEditedBlob()
      if (!blob) return
      const base = (filename || 'audio.wav').replace(/\.[^.]+$/, '')
      const edited = start > 0.01 || end < duration - 0.01 || Math.abs(gainDb) > 0.01
      // Transcode to the configured export format (MP3/FLAC) server-side so
      // downloads aren't giant WAVs. Trim/gain are already baked into `blob`.
      if (encodeUrl) {
        try {
          const fd = new FormData()
          fd.append('file', blob, `${base}.wav`)
          fd.append('name', edited ? `${base}_edited` : base)
          const res = await fetch(encodeUrl, { method: 'POST', body: fd })
          if (res.ok) {
            const cd = res.headers.get('Content-Disposition') || ''
            const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd)
            const enc = await res.blob()
            const a = document.createElement('a')
            a.href = URL.createObjectURL(enc)
            a.download = m ? decodeURIComponent(m[1]) : `${base}.wav`
            a.click()
            setTimeout(() => URL.revokeObjectURL(a.href), 2000)
            return
          }
        } catch {
          // Fall through to a raw WAV download if transcoding fails.
        }
      }
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = edited ? `${base}_edited.wav` : `${base}.wav`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="player">
      <div className="flex-between">
        <div>
          {title && <div className="ptitle">{title}</div>}
          <div className="pmeta">
            {fmt(start)} – {fmt(end)} · {(end - start).toFixed(2)}s
            {Math.abs(gainDb) > 0.01 ? ` · ${gainDb > 0 ? '+' : ''}${gainDb} dB` : ''}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {showPlay && (
            <button
              className={`btn sm playbtn ${playing ? 'live' : started ? 'stopped' : 'idle'}`}
              onClick={playing ? stop : play}
              title={playing ? 'Stop' : 'Play'}
            >
              {playing ? '■ Stop' : '▶ Play'}
            </button>
          )}
          <button className="btn sm ghost" onClick={reset} title="Reset trim & gain">
            ↺ Reset
          </button>
          {showDownload && (
            <button className="btn sm" onClick={download} disabled={downloading}>
              {downloading ? '…' : '⬇ Download'}
            </button>
          )}
        </div>
      </div>

      <canvas
        ref={canvasRef}
        className="waveform"
        onMouseDown={onWaveMouseDown}
        onMouseMove={onWaveMouseMove}
        style={{ width: '100%', height: waveHeight, marginTop: 10, cursor: 'pointer', borderRadius: 6 }}
      />
      <div className="hint" style={{ marginTop: 4, opacity: 0.7 }}>
        Drag the <span style={{ color: '#34d399' }}>green</span>/<span style={{ color: '#ef4444' }}>red</span> edges to
        trim · shift+scroll to zoom · middle-drag to pan
      </div>

      <audio ref={audioElRef} src={url} preload="auto" crossOrigin="anonymous" onEnded={handleEnded} style={{ display: 'none' }} />

      <div className="row wrap" style={{ gap: 16, marginTop: 10 }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="hint" style={{ marginBottom: 2 }}>
            Output gain · {gainDb > 0 ? '+' : ''}
            {gainDb} dB
          </div>
          <input
            type="range"
            min={-24}
            max={24}
            step={0.5}
            value={gainDb}
            onChange={(ev) => setGainDb(parseFloat(ev.target.value))}
            style={{ width: '100%' }}
          />
        </div>
      </div>
    </div>
  )
})
