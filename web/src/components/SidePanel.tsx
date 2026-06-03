import { useState } from 'react'
import type { HistoryEntry, OutputFile } from '../api'

export function SidePanel({
  history,
  outputs,
  playingUrl,
  onRestore,
  onDeleteHistory,
  onClearHistory,
  onTogglePlay,
}: {
  history: HistoryEntry[]
  outputs: OutputFile[]
  playingUrl: string | null
  onRestore: (e: HistoryEntry) => void
  onDeleteHistory: (id: string) => void
  onClearHistory: () => void
  onTogglePlay: (url: string) => void
}) {
  const [tab, setTab] = useState<'history' | 'outputs'>('history')

  const filenameFromUrl = (url: string) => url.split('/').pop() || 'audio.wav'

  return (
    <div className="card flush col" style={{ flex: 1, minHeight: 0 }}>
      <div className="tabs" style={{ padding: '4px 6px', borderBottom: '1px solid var(--border-soft)' }}>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History
        </button>
        <button className={tab === 'outputs' ? 'active' : ''} onClick={() => setTab('outputs')}>
          Outputs ({outputs.length})
        </button>
      </div>

      <div className="card-body" style={{ overflowY: 'auto', flex: 1 }}>
        {tab === 'history' ? (
          history.length === 0 ? (
            <div className="empty">No history yet. Scripts and generations show up here.</div>
          ) : (
            <>
              <div className="flex-between" style={{ marginBottom: 8 }}>
                <span className="hint">{history.length} entries</span>
                <button className="btn ghost sm danger" onClick={onClearHistory}>
                  Clear all
                </button>
              </div>
              {history.map((e) => {
                const playing = !!e.audio_url && playingUrl === e.audio_url
                return (
                  <div key={e.id} className="list-item" onClick={() => onRestore(e)}>
                    <div className="li-title">
                      <span className={`tag ${e.type}`}>{e.type}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.title}
                      </span>
                      {e.audio_url && (
                        <>
                          <span
                            className={`btn ghost sm ${playing ? 'playing' : ''}`}
                            title={playing ? 'Stop' : 'Play'}
                            onClick={(ev) => {
                              ev.stopPropagation()
                              onTogglePlay(e.audio_url!)
                            }}
                          >
                            {playing ? '■' : '▶'}
                          </span>
                          <a
                            className="btn ghost sm"
                            href={e.audio_url}
                            download={e.filename || filenameFromUrl(e.audio_url)}
                            title="Download"
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            ⬇
                          </a>
                        </>
                      )}
                      <span
                        className="btn ghost sm"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onDeleteHistory(e.id)
                        }}
                      >
                        🗑
                      </span>
                    </div>
                    <div className="li-sub">
                      {e.created} · {e.prompt || e.script?.slice(0, 60) || ''}
                    </div>
                  </div>
                )
              })}
            </>
          )
        ) : outputs.length === 0 ? (
          <div className="empty">No generated audio yet.</div>
        ) : (
          outputs.map((o) => {
            const playing = playingUrl === o.audio_url
            return (
              <div key={o.filename} className="list-item" onClick={() => onTogglePlay(o.audio_url)}>
                <div className="li-title">
                  <span
                    className={`play-dot ${playing ? 'playing' : ''}`}
                    title={playing ? 'Stop' : 'Play'}
                  >
                    {playing ? '■' : '▶'}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.filename}
                  </span>
                  <a
                    className="btn ghost sm"
                    href={o.audio_url}
                    download={o.filename}
                    title="Download"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    ⬇
                  </a>
                </div>
                <div className="li-sub">
                  {o.modified} · {o.size_kb} KB
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
