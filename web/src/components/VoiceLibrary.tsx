import { useState } from 'react'
import type { Voice, VoiceNode } from '../api'
import { downloadFile } from '../api'
import { usePersistentBool } from '../uiState'
import { useContributions } from '../pluginRegistry'

// Windows Explorer-style ordering: case-insensitive and number-aware, so
// "clip2" sorts before "clip10" and casing doesn't fragment the list.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const natCmp = (a: string, b: string) => collator.compare(a, b)

const baseName = (v: Voice) => v.filename.replace(/\.[^.]+$/, '')

interface RowActions {
  selected?: string
  playingUrl: string | null
  onPlay: (v: Voice) => void
  onCast: (voiceId: string, opts?: { newTrack?: boolean }) => void
  onPick: (v: Voice) => void
  onDelete: (v: Voice) => void
  onMove: (id: string, folder: string) => void
  onRename: (id: string, name: string) => void
  onEdit: (v: Voice) => void
  onMeta: (v: Voice) => void
  folders: string[]
}

function VoiceRow({
  v,
  selected,
  playingUrl,
  onPlay,
  onCast,
  onPick,
  onDelete,
  onMove,
  onRename,
  onEdit,
  onMeta,
  folders,
}: { v: Voice } & RowActions) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [moving, setMoving] = useState(false)
  const playing = playingUrl === `/api/audio/voice/${v.id}`

  const commitRename = () => {
    const name = (renaming ?? '').trim()
    setRenaming(null)
    if (name && name !== baseName(v)) onRename(v.id, name)
  }

  return (
    <div className={`voice-item row2 ${selected === v.id ? 'sel' : ''}`} title={`${v.id}\nClick the name to cast · Shift-click for a new track`}>
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
            onClick={(e) => { onPick(v); onCast(v.id, { newTrack: e.shiftKey }) }}
          >
            {baseName(v)}
          </span>
        )}
      </div>
      <div className="vrow-bar" onClick={(e) => e.stopPropagation()}>
        <button
          className={`vplay ${playing ? 'stop' : 'go'}`}
          onClick={(e) => { e.stopPropagation(); onPlay(v) }}
          title={playing ? 'Stop' : 'Play'}
        >
          {playing ? '■' : '▶'}
        </button>
        {confirmDel ? (
          <span className="vrow-confirm">
            <span className="hint">Delete?</span>
            <button className="vplay danger" title="Confirm delete" onClick={() => { setConfirmDel(false); onDelete(v) }}>✓</button>
            <button className="vplay" title="Cancel" onClick={() => setConfirmDel(false)}>✕</button>
          </span>
        ) : moving ? (
          <select
            className="input vmove-select"
            autoFocus
            defaultValue={v.folder}
            onChange={(e) => { setMoving(false); if (e.target.value !== v.folder) onMove(v.id, e.target.value) }}
            onBlur={() => setMoving(false)}
          >
            <option value="">(library root)</option>
            {folders.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        ) : (
          <>
            <span className="grow" />
            <button className="vplay" title="Move to folder…" onClick={() => setMoving(true)}>📂</button>
            <button className="vplay" title="Rename" onClick={() => setRenaming(baseName(v))}>✎</button>
            <button className="vplay" title="Edit — clean up & add transforms, save a copy or overwrite" onClick={() => onEdit(v)}>🎚</button>
            <button className="vplay" title="Metadata — actor / character & details" onClick={() => onMeta(v)}>🏷</button>
            <button className="vplay" title="Download (honors MP3/FLAC export setting)" onClick={() => void downloadFile(`/api/voices/${v.id}/download`, baseName(v)).catch(() => {})}>⬇</button>
            <button className="vplay" title="Delete" onClick={() => setConfirmDel(true)}>🗑</button>
          </>
        )}
      </div>
    </div>
  )
}

function FolderNode({ node, depth, actions }: { node: VoiceNode; depth: number; actions: RowActions }) {
  const [open, setOpen] = useState(depth < 1)
  const folderNames = Object.keys(node.folders).sort(natCmp)
  const voices = [...node.voices].sort((a, b) => natCmp(baseName(a), baseName(b)))
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
          {voices.map((v) => (
            <VoiceRow key={v.id} v={v} {...actions} />
          ))}
        </div>
      )}
    </div>
  )
}

export function VoiceLibrary({
  tree,
  flat,
  folders,
  count,
  selected,
  playingUrl,
  onPlay,
  onPick,
  onCast,
  onDelete,
  onMove,
  onRename,
  onEdit,
  onMeta,
  onCreateFolder,
  onRefresh,
  onOpenLab,
  onPluginGenerate,
}: {
  tree: VoiceNode | null
  flat: Voice[]
  folders: string[]
  count: number
  selected?: string
  playingUrl: string | null
  onPlay: (v: Voice) => void
  onPick: (v: Voice) => void
  onCast: (voiceId: string, opts?: { newTrack?: boolean }) => void
  onDelete: (v: Voice) => void
  onMove: (id: string, folder: string) => void
  onRename: (id: string, name: string) => void
  onEdit: (v: Voice) => void
  onMeta: (v: Voice) => void
  onCreateFolder: (path: string) => void
  onRefresh: () => void
  onOpenLab: () => void
  onPluginGenerate?: (pluginId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [open, setOpen] = usePersistentBool('ov-voicelib', true)
  // Plug-ins that contribute a voice-library action (e.g. a URL grabber) light
  // up here automatically — the voice-side twin of sound.library.action.
  const genActions = useContributions('voice.library.action')

  const actions: RowActions = { selected, playingUrl, onPlay, onCast, onPick, onDelete, onMove, onRename, onEdit, onMeta, folders }

  const q = query.trim().toLowerCase()
  const matches = q
    ? flat
        .filter((v) => v.name.toLowerCase().includes(q))
        .sort((a, b) => natCmp(baseName(a), baseName(b)))
        .slice(0, 60)
    : []

  const submitFolder = () => {
    const name = (newFolder ?? '').trim()
    setNewFolder(null)
    if (name) onCreateFolder(name)
  }

  return (
    <div className={`card flush col vlib${open ? '' : ' collapsed'}`} style={{ flex: open ? 1 : '0 0 auto', minHeight: open ? 240 : 0 }}>
      <div className="card-head">
        <h3 style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'} Voice Library ({count})
        </h3>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn ghost sm" onClick={() => setNewFolder(newFolder == null ? '' : null)} title="New folder">
            📁+
          </button>
          <button className="btn ghost sm" onClick={onRefresh} title="Refresh">
            ↻
          </button>
        </div>
      </div>
      {!open ? null : (
       <>
      <div className="vlib-search">
        <input
          className="input"
          placeholder="🔍 Search voices…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="btn ghost sm" onClick={() => setQuery('')} title="Clear">✕</button>
        )}
      </div>

      {newFolder != null && (
        <div className="vlib-search">
          <input
            className="input"
            autoFocus
            placeholder="New folder (e.g. movies/Heroes)"
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
            <div className="tree">
              {matches.map((v) => (
                <VoiceRow key={v.id} v={v} {...actions} />
              ))}
            </div>
          ) : (
            <div className="empty">No voices match “{query}”.</div>
          )
        ) : tree && count > 0 ? (
          <div className="tree">
            <FolderNode node={tree} depth={0} actions={actions} />
          </div>
        ) : (
          <div className="empty">
            No voices yet.
            <br />
            Use the Voice Lab to add and clean up reference samples.
          </div>
        )}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button className="btn" onClick={onOpenLab}>
          ⚗ Voice Lab — Isolate & Boost
        </button>
        {/* Plug-in actions grow downward, below the built-in lab button. */}
        {onPluginGenerate && genActions.map((c) => (
          <button key={`${c.plugin.id}:${c.label}`} className="btn" onClick={() => onPluginGenerate(c.plugin.id)} title={c.plugin.description}>
            {c.icon ? `${c.icon} ` : ''}{c.label}
          </button>
        ))}
      </div>
       </>
      )}
    </div>
  )
}
