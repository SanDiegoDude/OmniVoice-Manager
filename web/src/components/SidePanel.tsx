import { useRef, useState } from 'react'
import { api, type HistoryEntry, type HistoryState, type OutputFile, type Project, type ProjectAssets } from '../api'

type Tab = 'projects' | 'outputs' | 'history'

function ago(ts?: number): string {
  if (!ts) return ''
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function fmtDur(s: number): string {
  if (!s) return '0:00'
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

export function SidePanel({
  projects,
  outputs,
  histState,
  scripts,
  activeSessionId,
  playingUrl,
  onOpenProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  onNewProject,
  onImportProject,
  onDeleteOutput,
  onRenameOutput,
  onUndo,
  onRedo,
  onJumpHistory,
  onRestoreScript,
  onDeleteScript,
  onTogglePlay,
}: {
  projects: Project[]
  outputs: OutputFile[]
  histState: HistoryState | null
  scripts: HistoryEntry[]
  activeSessionId: string | null
  playingUrl: string | null
  onOpenProject: (sid: string) => void
  onRenameProject: (sid: string, title: string) => void
  onDuplicateProject: (sid: string) => void
  onDeleteProject: (sid: string) => void
  onNewProject: () => void
  onImportProject: (file: File) => void
  onDeleteOutput: (filename: string) => void
  onRenameOutput: (filename: string, name: string) => void
  onUndo: () => void
  onRedo: () => void
  onJumpHistory: (index: number) => void
  onRestoreScript: (e: HistoryEntry) => void
  onDeleteScript: (id: string) => void
  onTogglePlay: (url: string) => void
}) {
  const [tab, setTab] = useState<Tab>('projects')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [showScripts, setShowScripts] = useState(false)
  const [infoFor, setInfoFor] = useState<string | null>(null)
  const [assets, setAssets] = useState<ProjectAssets | null>(null)
  const importRef = useRef<HTMLInputElement | null>(null)

  const toggleInfo = async (id: string) => {
    if (infoFor === id) {
      setInfoFor(null)
      return
    }
    setInfoFor(id)
    setAssets(null)
    try {
      setAssets(await api.projectAssets(id))
    } catch {
      setAssets({ id, voices: [], uploads: [], plugins: [] })
    }
  }

  const beginRename = (id: string, current: string) => {
    setRenaming(id)
    setDraft(current)
  }
  const commitRename = (kind: 'project' | 'output', id: string) => {
    const v = draft.trim()
    if (v) {
      if (kind === 'project') onRenameProject(id, v)
      else onRenameOutput(id, v)
    }
    setRenaming(null)
  }

  // Fetch-as-blob download (mirrors AudioPlayer): a plain <a href> navigation
  // trips the app's beforeunload "leave site?" guard before the browser sees
  // Content-Disposition. The blob URL downloads with no navigation, and we lift
  // the real filename from the response header.
  const downloadFile = async (url: string, fallback: string) => {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('Download failed')
      const cd = res.headers.get('Content-Disposition') || ''
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)
      const name = m ? decodeURIComponent(m[1]) : fallback
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch {
      /* swallow — a failed download shouldn't disturb the column */
    }
  }

  return (
    <div className="card flush col" style={{ flex: 1, minHeight: 0 }}>
      <div className="tabs" style={{ padding: '4px 6px', borderBottom: '1px solid var(--border-soft)' }}>
        <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')} title="Editable, re-openable scenes">
          Projects ({projects.length})
        </button>
        <button className={tab === 'outputs' ? 'active' : ''} onClick={() => setTab('outputs')} title="Finished, non-project files">
          Outputs ({outputs.length})
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')} title="Undo / redo chain of the open project">
          History
        </button>
      </div>

      <div className="card-body" style={{ overflowY: 'auto', flex: 1 }}>
        {tab === 'projects' && (
          <>
            <div className="row" style={{ marginBottom: 8, gap: 6 }}>
              <button
                className="btn sm"
                style={{ flex: 1 }}
                title="Start a fresh, empty project — clears the editor for the next job. Your current project stays saved here."
                onClick={onNewProject}
              >
                ✚ New Blank Project
              </button>
              <button className="btn ghost sm" title="Import a .omvp project bundle" onClick={() => importRef.current?.click()}>
                ⬆ Import
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".omvp,application/zip,application/octet-stream"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onImportProject(f)
                  e.target.value = ''
                }}
              />
            </div>
            {projects.length === 0 ? (
              <div className="empty">No projects yet. Generate a scene or compose one in ADR Studio — it auto-saves here.</div>
            ) : (
              projects.map((p) => {
                const active = p.id === activeSessionId
                const playing = playingUrl === p.mix_url
                return (
                  <div key={p.id} className={`list-item${active ? ' active' : ''}`} style={{ position: 'relative' }}>
                    {/* Title gets its own full-width row so long scene names stay readable. */}
                    {renaming === p.id ? (
                      <input
                        className="inline-edit"
                        autoFocus
                        value={draft}
                        style={{ width: '100%' }}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename('project', p.id)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => commitRename('project', p.id)}
                      />
                    ) : (
                      <div className="proj-name" title="Open this project in the editor" onClick={() => onOpenProject(p.id)}>
                        <span className="tag project">proj</span>
                        <span style={{ fontWeight: active ? 600 : 500 }}>{p.title}</span>
                        {active && <span className="hint">· open</span>}
                      </div>
                    )}
                    <div className="proj-actions">
                      <span
                        className={`btn ghost sm ${playing ? 'playing' : ''}`}
                        title={playing ? 'Stop' : 'Play mix preview'}
                        onClick={() => onTogglePlay(p.mix_url)}
                      >
                        {playing ? '■' : '▶'}
                      </span>
                      <span
                        className={`btn ghost sm${infoFor === p.id ? ' playing' : ''}`}
                        title="Project details — voices, uploads & plug-in data used"
                        onClick={() => toggleInfo(p.id)}
                      >
                        ⓘ
                      </span>
                      <span className="btn ghost sm" title="Rename project" onClick={() => beginRename(p.id, p.title)}>
                        ✎
                      </span>
                      <span
                        className="btn ghost sm"
                        title="Download .omvp project bundle (share / archive)"
                        onClick={() => downloadFile(`/api/multitrack/${p.id}/export`, `${p.title}.omvp`)}
                      >
                        ⬇
                      </span>
                      <span
                        className="btn ghost sm"
                        title="Export per-track FLAC stems (DAW hand-off)"
                        onClick={() => downloadFile(`/api/multitrack/${p.id}/export-stems`, `${p.title}_stems.zip`)}
                      >
                        ♫
                      </span>
                      <span
                        className="btn ghost sm"
                        title="Duplicate project — make an independent “Copy of …”"
                        onClick={() => onDuplicateProject(p.id)}
                      >
                        ⧉
                      </span>
                      <span
                        className="btn ghost sm danger"
                        title="Delete project"
                        onClick={() => {
                          if (confirm(`Delete project “${p.title}”? This removes its media and history.`)) onDeleteProject(p.id)
                        }}
                      >
                        🗑
                      </span>
                    </div>
                    <div className="li-sub" onClick={() => onOpenProject(p.id)} style={{ cursor: 'pointer' }}>
                      {fmtDur(p.total_duration_s)} · {p.segment_count} clip{p.segment_count === 1 ? '' : 's'} ·{' '}
                      {p.voice_count ?? p.track_count} voice{(p.voice_count ?? p.track_count) === 1 ? '' : 's'} ·{' '}
                      {p.track_count} track{p.track_count === 1 ? '' : 's'} · edited {ago(p.updated)}
                    </div>
                    {infoFor === p.id && (
                      <div className="asset-pop" onClick={(ev) => ev.stopPropagation()}>
                        <div className="asset-pop-head">
                          <span>Assets used</span>
                          <span className="btn ghost sm" title="Close" onClick={() => setInfoFor(null)}>
                            ✕
                          </span>
                        </div>
                        {!assets ? (
                          <div className="empty">Loading…</div>
                        ) : (
                          <>
                            <div className="asset-group">Voices ({assets.voices.length})</div>
                            {assets.voices.length === 0 ? (
                              <div className="asset-row hint">None</div>
                            ) : (
                              assets.voices.map((v) => (
                                <div key={v.track} className="asset-row">
                                  <span className="asset-name">{v.name}</span>
                                  <span className={`asset-badge ${v.in_library ? 'ok' : v.bundled ? 'warn' : 'bad'}`}>
                                    {v.in_library ? 'in library' : v.bundled ? 'bundled' : 'missing'}
                                  </span>
                                </div>
                              ))
                            )}
                            <div className="asset-group">Uploaded tracks ({assets.uploads.length})</div>
                            {assets.uploads.length === 0 ? (
                              <div className="asset-row hint">None</div>
                            ) : (
                              assets.uploads.map((u) => (
                                <div key={u.track} className="asset-row">
                                  <span className="asset-name">{u.name}</span>
                                  <span className="hint">{fmtDur(u.duration_s)}</span>
                                </div>
                              ))
                            )}
                            <div className="asset-group">Plug-in data ({assets.plugins.length})</div>
                            {assets.plugins.length === 0 ? (
                              <div className="asset-row hint">None</div>
                            ) : (
                              assets.plugins.map((pl) => (
                                <div key={pl.plugin} className="asset-row">
                                  <span className="asset-name">{pl.plugin}</span>
                                  <span className="hint">{pl.keys ? pl.keys.join(', ') : ''}</span>
                                </div>
                              ))
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}

            <div style={{ marginTop: 12, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
              <button className="btn ghost sm" style={{ width: '100%' }} onClick={() => setShowScripts((v) => !v)}>
                {showScripts ? '▾' : '▸'} Script drafts ({scripts.length})
              </button>
              {showScripts &&
                (scripts.length === 0 ? (
                  <div className="empty">No saved script drafts.</div>
                ) : (
                  scripts.map((e) => (
                    <div key={e.id} className="list-item" onClick={() => onRestoreScript(e)} title="Load this script draft into the Studio">
                      <div className="li-title">
                        <span className="tag script">script</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                        <span
                          className="btn ghost sm"
                          onClick={(ev) => {
                            ev.stopPropagation()
                            onDeleteScript(e.id)
                          }}
                        >
                          🗑
                        </span>
                      </div>
                      <div className="li-sub">
                        {e.created} · {e.prompt || e.script?.slice(0, 60) || ''}
                      </div>
                    </div>
                  ))
                ))}
            </div>
          </>
        )}

        {tab === 'outputs' &&
          (outputs.length === 0 ? (
            <div className="empty">No finished files yet. Finalize a project or save from the Voice Clone tab.</div>
          ) : (
            outputs.map((o) => {
              const playing = playingUrl === o.audio_url
              return (
                <div key={o.filename} className="list-item">
                  <div className="li-title">
                    <span
                      className={`play-dot ${playing ? 'playing' : ''}`}
                      title={playing ? 'Stop' : 'Play'}
                      onClick={() => onTogglePlay(o.audio_url)}
                    >
                      {playing ? '■' : '▶'}
                    </span>
                    {renaming === o.filename ? (
                      <input
                        className="inline-edit"
                        autoFocus
                        value={draft}
                        style={{ flex: 1 }}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename('output', o.filename)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => commitRename('output', o.filename)}
                      />
                    ) : (
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.filename}</span>
                    )}
                    <span className="btn ghost sm" title="Rename file" onClick={() => beginRename(o.filename, o.filename.replace(/\.[^.]+$/, ''))}>
                      ✎
                    </span>
                    <a className="btn ghost sm" href={o.audio_url} download={o.filename} title="Download" onClick={(ev) => ev.stopPropagation()}>
                      ⬇
                    </a>
                    <span
                      className="btn ghost sm danger"
                      title="Delete file"
                      onClick={() => {
                        if (confirm(`Delete “${o.filename}”?`)) onDeleteOutput(o.filename)
                      }}
                    >
                      🗑
                    </span>
                  </div>
                  <div className="li-sub">
                    {o.modified} · {o.size_kb} KB
                  </div>
                </div>
              )
            })
          ))}

        {tab === 'history' &&
          (!activeSessionId ? (
            <div className="empty">Open or generate a project to see its undo/redo history.</div>
          ) : !histState || histState.steps.length === 0 ? (
            <div className="empty">No edits yet. Each action you take on this project shows up here as a step you can jump back to.</div>
          ) : (
            <>
              <div className="flex-between" style={{ marginBottom: 8, gap: 6 }}>
                <button className="btn ghost sm" disabled={!histState.can_undo} onClick={onUndo} title="Step one action back">
                  ↶ Undo
                </button>
                <button className="btn ghost sm" disabled={!histState.can_redo} onClick={onRedo} title="Step one action forward">
                  Redo ↷
                </button>
              </div>
              {histState.steps
                .slice()
                .reverse()
                .map((s) => {
                  const current = s.index === histState.cursor
                  const future = s.index > histState.cursor
                  return (
                    <div
                      key={s.id}
                      className={`list-item${current ? ' active' : ''}`}
                      style={{ opacity: future ? 0.5 : 1, cursor: current ? 'default' : 'pointer' }}
                      title={current ? 'Current state' : future ? 'Redo to this step' : 'Undo to this step'}
                      onClick={() => !current && onJumpHistory(s.index)}
                    >
                      <div className="li-title">
                        <span className="tag step">{current ? '●' : future ? '↷' : '↶'}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: current ? 600 : 400 }}>
                          {s.label}
                        </span>
                      </div>
                      <div className="li-sub">{ago(s.ts)}</div>
                    </div>
                  )
                })}
            </>
          ))}
      </div>
    </div>
  )
}
