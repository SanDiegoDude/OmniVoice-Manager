import { useRef, useState } from 'react'
import type { Sound, SoundNode } from '../api'
import { downloadFile } from '../api'
import { usePersistentBool } from '../uiState'
import { useContributions } from '../pluginRegistry'

// Explorer-style ordering, matching the voice library.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const natCmp = (a: string, b: string) => collator.compare(a, b)
const baseName = (s: Sound) => s.filename.replace(/\.[^.]+$/, '')

interface RowActions {
  selected?: string
  playingUrl: string | null
  hasSession: boolean
  onPlay: (s: Sound) => void
  onAddToProject: (s: Sound, opts?: { newTrack?: boolean }) => void
  onPick: (s: Sound) => void
  onDelete: (s: Sound) => void
  onMove: (id: string, folder: string) => void
  onRename: (id: string, name: string) => void
  onEdit: (s: Sound) => void
  onMeta: (s: Sound) => void
  folders: string[]
}

function SoundRow({ s, ...a }: { s: Sound } & RowActions) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [moving, setMoving] = useState(false)
  const playing = a.playingUrl === `/api/audio/sound/${s.id}`

  const commitRename = () => {
    const name = (renaming ?? '').trim()
    setRenaming(null)
    if (name && name !== baseName(s)) a.onRename(s.id, name)
  }

  return (
    <div
      className={`voice-item row2 ${a.selected === s.id ? 'sel' : ''}`}
      title={`${s.id}\nClick the name to add to the open project · Shift-click for a new channel`}
    >
      <div className="vrow-name">
        {renaming != null ? (
          <input
            className="input vname-edit"
            autoFocus
            value={renaming}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={commitRename}
          />
        ) : (
          <span
            className="vname"
            onClick={(e) => { a.onPick(s); if (a.hasSession) a.onAddToProject(s, { newTrack: e.shiftKey }) }}
          >
            {baseName(s)}
          </span>
        )}
      </div>
      <div className="vrow-bar" onClick={(e) => e.stopPropagation()}>
        <button
          className={`vplay ${playing ? 'stop' : 'go'}`}
          onClick={(e) => { e.stopPropagation(); a.onPlay(s) }}
          title={playing ? 'Stop' : 'Play'}
        >
          {playing ? '■' : '▶'}
        </button>
        {confirmDel ? (
          <span className="vrow-confirm">
            <span className="hint">Delete?</span>
            <button className="vplay danger" title="Confirm delete" onClick={() => { setConfirmDel(false); a.onDelete(s) }}>✓</button>
            <button className="vplay" title="Cancel" onClick={() => setConfirmDel(false)}>✕</button>
          </span>
        ) : moving ? (
          <select
            className="input vmove-select"
            autoFocus
            defaultValue={s.folder}
            onChange={(e) => { setMoving(false); if (e.target.value !== s.folder) a.onMove(s.id, e.target.value) }}
            onBlur={() => setMoving(false)}
          >
            <option value="">(library root)</option>
            {a.folders.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        ) : (
          <>
            {a.hasSession && (
              <button className="vplay" title="Add to project" onClick={() => a.onAddToProject(s)}>＋</button>
            )}
            <span className="grow" />
            <button className="vplay" title="Move to folder…" onClick={() => setMoving(true)}>📂</button>
            <button className="vplay" title="Rename" onClick={() => setRenaming(baseName(s))}>✎</button>
            <button className="vplay" title="Edit — clean up & add transforms, save a copy or overwrite" onClick={() => a.onEdit(s)}>🎚</button>
            <button className="vplay" title="Metadata — BPM / key / tags & details" onClick={() => a.onMeta(s)}>🏷</button>
            <button className="vplay" title="Download (honors MP3/FLAC export setting)" onClick={() => void downloadFile(`/api/sounds/${s.id}/download`, baseName(s)).catch(() => {})}>⬇</button>
            <button className="vplay" title="Delete" onClick={() => setConfirmDel(true)}>🗑</button>
          </>
        )}
      </div>
    </div>
  )
}

function FolderNode({ node, depth, actions }: { node: SoundNode; depth: number; actions: RowActions }) {
  const [open, setOpen] = useState(depth < 1)
  const folderNames = Object.keys(node.folders).sort(natCmp)
  const sounds = [...node.sounds].sort((a, b) => natCmp(baseName(a), baseName(b)))
  return (
    <div className="tree-folder">
      {node.name && (
        <div className="folder-label" onClick={() => setOpen(!open)}>
          <span>{open ? '▾' : '▸'}</span> 📁 {node.name}
        </div>
      )}
      {open && (
        <div className={node.name ? 'tree-children' : ''}>
          {folderNames.map((f) => (
            <FolderNode key={f} node={node.folders[f]} depth={depth + 1} actions={actions} />
          ))}
          {sounds.map((s) => (
            <SoundRow key={s.id} s={s} {...actions} />
          ))}
        </div>
      )}
    </div>
  )
}

export function SoundLibrary({
  tree,
  flat,
  folders,
  count,
  selected,
  playingUrl,
  hasSession,
  onPlay,
  onPick,
  onAddToProject,
  onDelete,
  onMove,
  onRename,
  onEdit,
  onCreateFolder,
  onUpload,
  onRefresh,
  onGenerate,
  onMeta,
  onScan,
}: {
  tree: SoundNode | null
  flat: Sound[]
  folders: string[]
  count: number
  selected?: string
  playingUrl: string | null
  hasSession: boolean
  onPlay: (s: Sound) => void
  onPick: (s: Sound) => void
  onAddToProject: (s: Sound, opts?: { newTrack?: boolean }) => void
  onDelete: (s: Sound) => void
  onMove: (id: string, folder: string) => void
  onRename: (id: string, name: string) => void
  onEdit: (s: Sound) => void
  onCreateFolder: (path: string) => void
  onUpload: (file: File) => void
  onRefresh: () => void
  onGenerate: (pluginId: string) => void
  onMeta: (s: Sound) => void
  onScan: () => void
}) {
  const [query, setQuery] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [open, setOpen] = usePersistentBool('ov-soundlib', true)
  const fileRef = useRef<HTMLInputElement>(null)
  // Generation entry points are contributed by plug-ins (e.g. Stable Audio 3),
  // not hardcoded here — so any future audio generator shows up automatically.
  const genActions = useContributions('sound.library.action')

  const actions: RowActions = {
    selected, playingUrl, hasSession, onPlay, onAddToProject, onPick, onDelete, onMove, onRename, onEdit, onMeta, folders,
  }

  const q = query.trim().toLowerCase()
  const matches = q
    ? flat.filter((s) => s.name.toLowerCase().includes(q)).sort((a, b) => natCmp(baseName(a), baseName(b))).slice(0, 60)
    : []

  const submitFolder = () => {
    const name = (newFolder ?? '').trim()
    setNewFolder(null)
    if (name) onCreateFolder(name)
  }

  return (
    <div className={`card flush col vlib${open ? '' : ' collapsed'}`} style={{ flex: open ? 1 : '0 0 auto', minHeight: open ? 200 : 0 }}>
      <div className="card-head">
        <h3 style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'} Sound Library ({count})
        </h3>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn ghost sm" onClick={() => fileRef.current?.click()} title="Upload a sound file">⤴</button>
          <button className="btn ghost sm" onClick={onScan} title="Scan & analyze — enrich any un-analyzed sounds (incl. files copied into the folder)">🔬</button>
          <button className="btn ghost sm" onClick={() => setNewFolder(newFolder == null ? '' : null)} title="New folder">📁+</button>
          <button className="btn ghost sm" onClick={onRefresh} title="Refresh">↻</button>
        </div>
      </div>
      {!open ? null : (
       <>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onUpload(f)
          e.currentTarget.value = ''
        }}
      />

      <div className="vlib-search">
        <input className="input" placeholder="🔍 Search sounds…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button className="btn ghost sm" onClick={() => setQuery('')} title="Clear">✕</button>}
      </div>

      {newFolder != null && (
        <div className="vlib-search">
          <input
            className="input"
            autoFocus
            placeholder="New folder (e.g. ambience/forest)"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitFolder()
              else if (e.key === 'Escape') setNewFolder(null)
            }}
            onBlur={submitFolder}
          />
        </div>
      )}

      <div className="card-body" style={{ overflowY: 'auto', flex: 1 }}>
        {q ? (
          matches.length ? (
            <div className="tree">{matches.map((s) => <SoundRow key={s.id} s={s} {...actions} />)}</div>
          ) : (
            <div className="empty">No sounds match “{query}”.</div>
          )
        ) : tree && count > 0 ? (
          <div className="tree"><FolderNode node={tree} depth={0} actions={actions} /></div>
        ) : (
          <div className="empty">
            No sounds yet.
            <br />
            Generate foley with Stable Audio 3, or upload your own samples.
          </div>
        )}
      </div>
      {genActions.length > 0 && (
        <div style={{ padding: 12, borderTop: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Plug-in actions stack vertically and grow downward. */}
          {genActions.map((c) => (
            <button key={`${c.plugin.id}:${c.label}`} className="btn" onClick={() => onGenerate(c.plugin.id)} title={c.plugin.description}>
              {c.icon ? `${c.icon} ` : ''}{c.label}
            </button>
          ))}
        </div>
      )}
       </>
      )}
    </div>
  )
}
