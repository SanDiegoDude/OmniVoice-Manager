import { useState } from 'react'
import type { Voice, VoiceNode } from '../api'

function FolderNode({
  node,
  depth,
  onPlay,
  onPick,
  onDelete,
  selected,
}: {
  node: VoiceNode
  depth: number
  onPlay: (v: Voice) => void
  onPick: (v: Voice) => void
  onDelete: (v: Voice) => void
  selected?: string
}) {
  const [open, setOpen] = useState(depth < 1)
  const folderNames = Object.keys(node.folders).sort()
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
            <FolderNode
              key={f}
              node={node.folders[f]}
              depth={depth + 1}
              onPlay={onPlay}
              onPick={onPick}
              onDelete={onDelete}
              selected={selected}
            />
          ))}
          {node.voices.map((v) => (
            <div
              key={v.id}
              className={`voice-item ${selected === v.id ? 'sel' : ''}`}
              onClick={() => onPick(v)}
              title={v.id}
            >
              <span
                className="vplay"
                onClick={(e) => {
                  e.stopPropagation()
                  onPlay(v)
                }}
              >
                ▶
              </span>
              <span className="vname">{v.filename.replace(/\.[^.]+$/, '')}</span>
              <span
                className="vplay"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(v)
                }}
                title="Delete"
              >
                🗑
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function VoiceLibrary({
  tree,
  count,
  selected,
  onPlay,
  onPick,
  onDelete,
  onRefresh,
  onOpenLab,
}: {
  tree: VoiceNode | null
  count: number
  selected?: string
  onPlay: (v: Voice) => void
  onPick: (v: Voice) => void
  onDelete: (v: Voice) => void
  onRefresh: () => void
  onOpenLab: () => void
}) {
  return (
    // min-height keeps the library usable (head + a few voices + the Voice Lab
    // button) on short viewports; the tag library below shrinks/scrolls instead.
    <div className="card flush col" style={{ flex: 1, minHeight: 240 }}>
      <div className="card-head">
        <h3>Voice Library ({count})</h3>
        <button className="btn ghost sm" onClick={onRefresh} title="Refresh">
          ↻
        </button>
      </div>
      <div className="card-body" style={{ overflowY: 'auto', flex: 1 }}>
        {tree && (count > 0) ? (
          <div className="tree">
            <FolderNode node={tree} depth={0} onPlay={onPlay} onPick={onPick} onDelete={onDelete} selected={selected} />
          </div>
        ) : (
          <div className="empty">
            No voices yet.
            <br />
            Use the Voice Lab to add and clean up reference samples.
          </div>
        )}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid var(--border-soft)' }}>
        <button className="btn primary block" onClick={onOpenLab}>
          ⚗ Voice Lab — Isolate & Boost
        </button>
      </div>
    </div>
  )
}
