import { useState } from 'react'
import ToolModal from './ToolModal'
import { resolveUrl } from '../basePath'
import type { ImportableVoice } from '../api'

type VoicePick = { track: string; file: string; name: string; folder: string }

/** Offered after importing an .omvp whose voices aren't in this library yet.
 * The exact voice snapshots travel inside the project, so each can be added to
 * the library (and relinked) without the original source. Built on ToolModal so
 * it can grow to handle other bundled assets (foley/SFX) down the road. */
export default function ProjectImportModal({
  voices,
  onImport,
  onClose,
}: {
  voices: ImportableVoice[]
  onImport: (picks: VoicePick[]) => Promise<void> | void
  onClose: () => void
}) {
  const [rows, setRows] = useState(() => voices.map((v) => ({ ...v, selected: true })))
  const [busy, setBusy] = useState(false)

  const update = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))

  const picked = rows.filter((r) => r.selected)
  const doImport = async () => {
    setBusy(true)
    try {
      await onImport(picked.map((r) => ({ track: r.track, file: r.file, name: r.name.trim(), folder: r.folder.trim() })))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolModal
      open
      title="Import voices into your library"
      onClose={onClose}
      width={640}
      actions={
        <button className="btn sm" disabled={busy || picked.length === 0} onClick={doImport}>
          {busy ? 'Importing…' : `Import ${picked.length} voice${picked.length === 1 ? '' : 's'}`}
        </button>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        This project uses voices that aren&rsquo;t in your library yet. The exact snapshots that produced its samples
        travel inside the project — import the ones you want to keep and they&rsquo;ll relink automatically. Identical
        voices already in your library are matched (no duplicates); skipped voices still play from the project&rsquo;s
        cached takes.
      </p>
      {rows.map((r, i) => (
        <div key={r.track} className="import-voice-row">
          <input type="checkbox" checked={r.selected} onChange={(e) => update(i, { selected: e.target.checked })} title="Import this voice" />
          <audio controls src={resolveUrl(r.preview_url)} preload="none" style={{ height: 34, flex: 1, minWidth: 0 }} />
          <input
            className="input"
            placeholder="folder (optional)"
            value={r.folder}
            disabled={!r.selected}
            onChange={(e) => update(i, { folder: e.target.value })}
            style={{ width: 130 }}
          />
          <input
            className="input"
            placeholder="voice name"
            value={r.name}
            disabled={!r.selected}
            onChange={(e) => update(i, { name: e.target.value })}
            style={{ width: 150 }}
          />
        </div>
      ))}
    </ToolModal>
  )
}
