import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, DEFAULT_TRANSFORM, type MultitrackSegment, type VocalTransform } from '../api'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import ToolModal from './ToolModal'
import { VocalTransforms } from './VocalTransforms'

const transformActive = (t: VocalTransform) =>
  Math.abs(t.pitch) > 0.01 ||
  Math.abs(t.formant) > 0.01 ||
  t.sub > 0.01 ||
  t.drive > 0.01 ||
  t.ringmod > 0.01 ||
  t.vibrato > 0.01 ||
  (t.tremolo ?? 0) > 0.01 ||
  (t.gate ?? 0) > 0.01 ||
  (t.chorus ?? 0) > 0.01 ||
  (t.muffle ?? 0) > 0.01 ||
  (t.echo ?? 0) > 0.01 ||
  (t.reverb ?? 0) > 0.01 ||
  (t.telephone ?? 0) > 0.01

/** Dedicated per-segment vocal-transforms plug-in. Reuses the shared transform
 * engine/UI (pitch/formant/growl/robot/telephone…) and previews the result on
 * the clip in-place before baking it onto the segment's audio. Built modal-first
 * so future per-segment effects slot into the same shell. */
export default function SegmentTransformModal({
  open,
  seg,
  onClose,
  onApply,
}: {
  open: boolean
  seg: MultitrackSegment | null
  onClose: () => void
  /** Bake the transforms onto the segment server-side (returns when the session
   * has refreshed). A no-op transform restores the clip's original audio. */
  onApply: (index: number, transforms: VocalTransform) => Promise<void>
}) {
  const baked = useMemo<VocalTransform>(
    () => ({ ...DEFAULT_TRANSFORM, ...(seg?.fx ?? {}) }),
    [seg?.fx],
  )
  const [tf, setTf] = useState<VocalTransform>(baked)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const objUrlRef = useRef<string | null>(null)
  const playerRef = useRef<AudioPlayerHandle | null>(null)

  const clearPreview = useCallback(() => {
    if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current)
    objUrlRef.current = null
    setPreviewUrl(null)
  }, [])

  // Revoke the in-flight preview URL on unmount. The parent remounts this modal
  // per segment (via `key`), so sliders seed cleanly from `baked` each open and
  // we don't need a reset effect.
  useEffect(() => () => clearPreview(), [clearPreview])

  if (!seg) return null
  const clipUrl = seg.clip_url

  // Render a non-destructive preview of the current sliders onto the clip.
  const preview = async () => {
    setBusy(true)
    setErr(null)
    try {
      const blob = await (await fetch(clipUrl)).blob()
      const out = await api.transformClip(blob, tf)
      clearPreview()
      const u = URL.createObjectURL(out)
      objUrlRef.current = u
      setPreviewUrl(u)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    setErr(null)
    try {
      await onApply(seg.index, tf)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Apply failed')
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setErr(null)
    try {
      await onApply(seg.index, { ...DEFAULT_TRANSFORM })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Remove failed')
      setBusy(false)
    }
  }

  const active = transformActive(tf)
  const previewing = !!previewUrl

  return (
    <ToolModal
      open={open}
      title={
        <span>
          🎚 Vocal &amp; audio transforms — <span style={{ opacity: 0.8 }}>segment {seg.index + 1}</span>
        </span>
      }
      width={620}
      onClose={onClose}
      onSpace={() => playerRef.current?.toggle()}
    >
      <div className="hint" style={{ opacity: 0.85, marginBottom: 8 }}>
        Reshape this clip's own audio (voice <em>or</em> foley) — pitch/formant move the register, the colours add
        character, <strong>🧱 Echo</strong>/<strong>🕳 Reverb</strong> place it in a space (alley bounce, big hall), and{' '}
        <strong>☎️ Telephone</strong> crushes it to a bad-phone sound. Preview, then bake it onto the segment
        (reversible, single-step undo).
      </div>

      <VocalTransforms value={tf} onChange={setTf} target="take" defaultOpen title="🎚 Vocal & audio transforms" />

      <div style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <button className="btn sm" disabled={busy || !active} onClick={() => void preview()} title="Render these transforms onto the clip and audition — nothing is saved yet">
            {busy ? <span className="spinner sm" /> : '🎧'} Preview
          </button>
          {previewing && (
            <button className="btn sm ghost" disabled={busy} onClick={clearPreview} title="Play the untouched original clip">
              ↩ Original
            </button>
          )}
          <span className="hint" style={{ opacity: 0.75 }}>
            {previewing ? '✅ playing the transformed preview' : 'playing the original clip'}
          </span>
        </div>
        <AudioPlayer
          key={previewUrl ?? clipUrl}
          ref={playerRef}
          url={previewUrl ?? clipUrl}
          autoPlay={false}
          showDownload={false}
        />
      </div>

      {err && (
        <div className="hint" style={{ color: 'var(--bad, #e5484d)', marginTop: 8 }}>
          {err}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          marginTop: 14,
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
        }}
      >
        <div>
          {seg.fx && (
            <button className="btn sm ghost" disabled={busy} onClick={() => void remove()} title="Restore this clip's original audio and clear its transforms">
              🗑 Remove transforms
            </button>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn good" disabled={busy || !active} onClick={() => void apply()} title="Bake the current transforms onto this segment's audio">
            {busy ? <span className="spinner sm" /> : '🎚'} Apply to segment
          </button>
        </div>
      </div>
    </ToolModal>
  )
}
