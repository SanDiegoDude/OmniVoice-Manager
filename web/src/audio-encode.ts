/** Browser-side audio normalization: decode anything the browser can play
 * (mic webm/opus, uploaded mp3/wav/…) into a mono 16-bit PCM WAV blob, so the
 * server never has to deal with container formats. */

export async function blobToWav(blob: Blob, normalizePeak = 0): Promise<{ wav: Blob; duration: number }> {
  const ctx = new AudioContext()
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    if (normalizePeak > 0) normalizeBuffer(buf, normalizePeak)
    return { wav: audioBufferToWav(buf), duration: buf.duration }
  } finally {
    void ctx.close()
  }
}

/** Peak-normalize in place (quiet mic takes come out at healthy levels). */
function normalizeBuffer(buf: AudioBuffer, targetPeak: number) {
  let peak = 0
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i])
      if (v > peak) peak = v
    }
  }
  if (peak < 1e-5 || peak >= targetPeak) return
  const g = targetPeak / peak
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < ch.length; i++) ch[i] *= g
  }
}

/** Encode an AudioBuffer preserving its channel count (16-bit PCM WAV) —
 * used for the stereo L/R comparison export. */
export function audioBufferToWavMulti(buf: AudioBuffer): Blob {
  const n = buf.length
  const nc = buf.numberOfChannels
  const sr = buf.sampleRate
  const bytes = 44 + n * nc * 2
  const ab = new ArrayBuffer(bytes)
  const v = new DataView(ab)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, bytes - 8, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, nc, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * nc * 2, true)
  v.setUint16(32, nc * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * nc * 2, true)
  const chans: Float32Array[] = []
  for (let c = 0; c < nc; c++) chans.push(buf.getChannelData(c))
  let off = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]))
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}

export function audioBufferToWav(buf: AudioBuffer): Blob {
  const n = buf.length
  const sr = buf.sampleRate
  // Mix down to mono.
  const mono = new Float32Array(n)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buf.numberOfChannels
  }
  const bytes = 44 + n * 2
  const ab = new ArrayBuffer(bytes)
  const v = new DataView(ab)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, bytes - 8, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([ab], { type: 'audio/wav' })
}
