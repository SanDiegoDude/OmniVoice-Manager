/** Browser-side audio normalization: decode anything the browser can play
 * (mic webm/opus, uploaded mp3/wav/…) into a mono 16-bit PCM WAV blob, so the
 * server never has to deal with container formats. */

export async function blobToWav(blob: Blob): Promise<{ wav: Blob; duration: number }> {
  const ctx = new AudioContext()
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    return { wav: audioBufferToWav(buf), duration: buf.duration }
  } finally {
    void ctx.close()
  }
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
