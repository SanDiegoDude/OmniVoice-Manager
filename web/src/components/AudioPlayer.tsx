import { useCallback, useEffect, useRef, useState } from 'react'

function fmt(t: number) {
  if (!isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const ds = Math.floor((t * 10) % 10)
  return `${m}:${s.toString().padStart(2, '0')}.${ds}`
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

export function AudioPlayer({
  url,
  title,
  filename,
  autoPlay = true,
}: {
  url: string
  title?: string
  filename?: string
  autoPlay?: boolean
}) {
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const srcNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const peaksRef = useRef<number[]>([])
  const pendingAutoplayRef = useRef(false)

  const [duration, setDuration] = useState(0)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [gainDb, setGainDb] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [downloading, setDownloading] = useState(false)

  // Decode the audio once for the waveform + offline processing on download.
  useEffect(() => {
    let cancelled = false
    setPlaying(false)
    setCur(0)
    setGainDb(0)
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
        setStart(0)
        setEnd(buf.duration)
        // Precompute waveform peaks.
        const ch = buf.getChannelData(0)
        const bars = 320
        const block = Math.floor(ch.length / bars) || 1
        const peaks: number[] = []
        for (let i = 0; i < bars; i++) {
          let max = 0
          for (let j = 0; j < block; j++) {
            const v = Math.abs(ch[i * block + j] || 0)
            if (v > max) max = v
          }
          peaks.push(max)
        }
        peaksRef.current = peaks
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

  const draw = useCallback(
    (playhead: number) => {
      const canvas = canvasRef.current
      const peaks = peaksRef.current
      if (!canvas || !peaks.length) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      const dur = duration || 1
      const sx = (start / dur) * w
      const ex = (end / dur) * w
      const gain = Math.pow(10, gainDb / 20)
      const bw = w / peaks.length
      for (let i = 0; i < peaks.length; i++) {
        const x = i * bw
        const inRegion = x >= sx && x <= ex
        const amp = Math.min(1, peaks[i] * gain)
        const bh = Math.max(1, amp * (h * 0.92))
        ctx.fillStyle = inRegion ? '#6d8bff' : '#33405e'
        ctx.fillRect(x, (h - bh) / 2, Math.max(1, bw - 0.5), bh)
      }
      // Dim outside the trim region.
      ctx.fillStyle = 'rgba(10,14,24,.55)'
      ctx.fillRect(0, 0, sx, h)
      ctx.fillRect(ex, 0, w - ex, h)
      // Playhead.
      const px = (playhead / dur) * w
      ctx.fillStyle = '#ff6b7d'
      ctx.fillRect(px - 0.5, 0, 1.5, h)
    },
    [duration, start, end, gainDb],
  )

  useEffect(() => {
    draw(cur)
  }, [draw, cur])

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

  const tick = useCallback(() => {
    const el = audioElRef.current
    if (!el) return
    if (el.currentTime >= end) {
      el.pause()
      el.currentTime = start
      setPlaying(false)
      setCur(start)
      return
    }
    setCur(el.currentTime)
    rafRef.current = requestAnimationFrame(tick)
  }, [start, end])

  const play = useCallback(async () => {
    const el = audioElRef.current
    if (!el) return
    ensureGraph()
    if (ctxRef.current?.state === 'suspended') await ctxRef.current.resume()
    if (el.currentTime < start || el.currentTime >= end) el.currentTime = start
    await el.play().catch(() => {})
    setPlaying(true)
    rafRef.current = requestAnimationFrame(tick)
  }, [start, end, ensureGraph, tick])

  const stop = useCallback(() => {
    const el = audioElRef.current
    if (el) el.pause()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }, [])

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
    if (audioElRef.current) audioElRef.current.currentTime = 0
  }

  const seek = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    const t = Math.max(start, Math.min(end, frac * duration))
    setCur(t)
    if (audioElRef.current) audioElRef.current.currentTime = t
  }

  const download = async () => {
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
      const blob = encodeWav(rendered)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      const base = (filename || 'audio.wav').replace(/\.[^.]+$/, '')
      const edited = start > 0.01 || end < duration - 0.01 || Math.abs(gainDb) > 0.01
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
            {fmt(start)} – {fmt(end)} · {(end - start).toFixed(1)}s
            {Math.abs(gainDb) > 0.01 ? ` · ${gainDb > 0 ? '+' : ''}${gainDb} dB` : ''}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn sm ${playing ? 'stopbtn' : ''}`} onClick={playing ? stop : play}>
            {playing ? '■ Stop' : '▶ Play'}
          </button>
          <button className="btn sm ghost" onClick={reset} title="Reset trim & gain">
            ↺ Reset
          </button>
          <button className="btn sm" onClick={download} disabled={downloading}>
            {downloading ? '…' : '⬇ Download'}
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        className="waveform"
        onClick={seek}
        style={{ width: '100%', height: 70, marginTop: 10, cursor: 'pointer', borderRadius: 6 }}
      />

      <audio ref={audioElRef} src={url} preload="auto" crossOrigin="anonymous" style={{ display: 'none' }} />

      <div className="row wrap" style={{ gap: 16, marginTop: 10 }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="hint" style={{ marginBottom: 2 }}>
            Trim start · {fmt(start)}
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={start}
            onChange={(ev) => setStart(Math.min(parseFloat(ev.target.value), end - 0.1))}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div className="hint" style={{ marginBottom: 2 }}>
            Trim end · {fmt(end)}
          </div>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={end}
            onChange={(ev) => setEnd(Math.max(parseFloat(ev.target.value), start + 0.1))}
            style={{ width: '100%' }}
          />
        </div>
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
}
