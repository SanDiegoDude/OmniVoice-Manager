import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, DEFAULT_TRANSFORM, type VocalTransform } from '../api'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import ToolModal from './ToolModal'
import { VocalTransforms } from './VocalTransforms'

export type EditTarget = {
  kind: 'voice' | 'sound'
  /** Library id (relative path). */
  id: string
  /** Display name (relative path without extension). */
  name: string
  /** Containing folder ('' = library root). */
  folder: string
}

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

const leaf = (name: string) => name.split('/').pop() || name

/** Reusable sample editor for BOTH libraries. Loads an existing voice/sound,
 * lets you stack vocal & audio transforms (pitch, echo, reverb, muffle, …),
 * preview non-destructively, then save a copy or overwrite the original in
 * place. Opened from the ✎-adjacent edit button; edit-opens default to
 * overwrite-on so a quick tweak replaces the sample. */
export function SampleEditModal({
  open,
  target,
  folders,
  onClose,
  onSaved,
  notify,
}: {
  open: boolean
  target: EditTarget | null
  folders: string[]
  onClose: () => void
  onSaved: () => void
  notify: (msg: string, kind?: 'info' | 'error' | 'success') => void
}) {
  const [tf, setTf] = useState<VocalTransform>({ ...DEFAULT_TRANSFORM })
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [overwrite, setOverwrite] = useState(true)
  const [saveFolder, setSaveFolder] = useState('')
  const [saveName, setSaveName] = useState('')
  const objUrlRef = useRef<string | null>(null)
  const playerRef = useRef<AudioPlayerHandle | null>(null)

  const srcUrl = useMemo(
    () => (target ? `/api/audio/${target.kind}/${target.id}` : ''),
    [target],
  )

  const clearPreview = useCallback(() => {
    if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current)
    objUrlRef.current = null
    setPreviewUrl(null)
  }, [])

  // Seed the form whenever a new sample is opened.
  useEffect(() => {
    if (!open || !target) return
    setTf({ ...DEFAULT_TRANSFORM })
    setOverwrite(true)
    setSaveFolder(target.folder || '')
    setSaveName(leaf(target.name))
    clearPreview()
  }, [open, target, clearPreview])

  useEffect(() => () => clearPreview(), [clearPreview])

  if (!target) return null

  const kindLabel = target.kind === 'voice' ? 'voice' : 'sound'
  const libLabel = target.kind === 'voice' ? 'voice library' : 'sound library'
  const active = transformActive(tf)
  const previewing = !!previewUrl

  const preview = async () => {
    setBusy(true)
    try {
      const blob = await (await fetch(srcUrl)).blob()
      const out = await api.transformClip(blob, tf)
      clearPreview()
      const u = URL.createObjectURL(out)
      objUrlRef.current = u
      setPreviewUrl(u)
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Preview failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  const composedSaveAs = () => {
    const nm = (saveName.trim() || leaf(target.name)).replace(/\//g, '-')
    return saveFolder ? `${saveFolder}/${nm}` : nm
  }

  const save = async () => {
    if (!overwrite && !saveName.trim()) return notify('Enter a name to save a copy', 'error')
    setBusy(true)
    try {
      if (target.kind === 'voice') {
        const desc = await api.processVoice({
          source: target.id,
          is_upload: false,
          isolate: false,
          trim: false,
          normalize: false,
          dereverb: false,
          gain_db: 0,
          transforms: tf,
          overwrite,
          save_as: composedSaveAs(),
        })
        notify(`${overwrite ? 'Overwrote' : 'Saved'} “${desc.name}” in the ${libLabel}`, 'success')
      } else {
        const desc = await api.transformSound({
          id: target.id,
          transforms: tf,
          overwrite,
          save_as: composedSaveAs(),
        })
        notify(`${overwrite ? 'Overwrote' : 'Saved'} “${desc.name}” in the ${libLabel}`, 'success')
      }
      onSaved()
      onClose()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Save failed', 'error')
      setBusy(false)
    }
  }

  return (
    <ToolModal
      open={open}
      title={
        <span>
          🎚 Edit {kindLabel} — <span style={{ opacity: 0.8 }}>{leaf(target.name)}</span>
        </span>
      }
      width={640}
      onClose={onClose}
      onSpace={() => playerRef.current?.toggle()}
    >
      <div className="hint" style={{ opacity: 0.85, marginBottom: 8 }}>
        Stack vocal &amp; audio transforms onto this {kindLabel}, preview, then save a copy or overwrite it in place.
        {target.kind === 'sound' && ' (Transforms render at 24k mono — great for SFX/foley.)'}
      </div>

      <VocalTransforms value={tf} onChange={setTf} target="output" defaultOpen title="🎚 Vocal & audio transforms" />

      <div style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <button className="btn sm" disabled={busy || !active} onClick={() => void preview()} title="Render these transforms onto the sample and audition — nothing is saved yet">
            {busy ? <span className="spinner sm" /> : '🎧'} Preview
          </button>
          {previewing && (
            <button className="btn sm ghost" disabled={busy} onClick={clearPreview} title="Play the untouched original">
              ↩ Original
            </button>
          )}
          <span className="hint" style={{ opacity: 0.75 }}>
            {previewing ? '✅ playing the transformed preview' : 'playing the original'}
          </span>
        </div>
        <AudioPlayer
          key={previewUrl ?? srcUrl}
          ref={playerRef}
          url={previewUrl ?? srcUrl}
          autoPlay={false}
          showDownload={false}
        />
      </div>

      <div className="card" style={{ marginTop: 14, padding: 12 }}>
        <label className="row" style={{ gap: 8, alignItems: 'center', marginBottom: overwrite ? 8 : 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite the existing {kindLabel} in place</span>
        </label>
        {overwrite ? (
          <div className="warn-banner">
            ⚠ This replaces <strong>{leaf(target.name)}</strong> in the {libLabel} — the original file is overwritten and
            cannot be undone.
            {target.kind === 'sound' && ' The sample is rewritten as a 24k-mono WAV.'}
          </div>
        ) : (
          <>
            <div className="field-label">Save a copy to</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="input" style={{ minWidth: 160 }} value={saveFolder} onChange={(e) => setSaveFolder(e.target.value)}>
                <option value="">📁 Library root</option>
                {folders.map((f) => (
                  <option key={f} value={f}>📁 {f}</option>
                ))}
              </select>
              <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              Saved as <code>{composedSaveAs()}</code>.
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          className={`btn ${overwrite ? 'danger-solid' : 'good'}`}
          disabled={busy || !active}
          onClick={() => void save()}
          title={active ? 'Bake the transforms and save' : 'Add at least one transform first'}
        >
          {busy ? <span className="spinner sm" /> : overwrite ? '⟳ Overwrite' : '💾 Save copy'}
        </button>
      </div>
    </ToolModal>
  )
}
