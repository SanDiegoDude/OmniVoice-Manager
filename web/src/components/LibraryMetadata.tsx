import { useEffect, useState } from 'react'
import { api, type SampleMeta } from '../api'
import ToolModal from './ToolModal'

export interface MetaTarget {
  kind: 'sound' | 'voice'
  id: string
  name: string
}

// Manual fields offered per library. Sounds get music-cataloguing fields; voices
// are "who", so actor/character lead. Both share tags + notes.
const MANUAL_FIELDS: Record<'sound' | 'voice', { key: string; label: string; placeholder?: string }[]> = {
  sound: [
    { key: 'title', label: 'Title' },
    { key: 'artist', label: 'Artist' },
    { key: 'album', label: 'Album' },
    { key: 'notes', label: 'Notes' },
  ],
  voice: [
    { key: 'actor', label: 'Voice actor' },
    { key: 'character', label: 'Character' },
    { key: 'accent', label: 'Accent / region' },
    { key: 'notes', label: 'Notes' },
  ],
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="chip" style={{ marginRight: 4, marginBottom: 4, display: 'inline-block' }}>{children}</span>
}

function fmtTime(ts: number | null): string {
  if (!ts) return ''
  try { return new Date(ts * 1000).toLocaleString() } catch { return '' }
}

export function LibraryMetadata({
  target,
  onClose,
  notify,
}: {
  target: MetaTarget | null
  onClose: () => void
  notify: (msg: string) => void
}) {
  const [meta, setMeta] = useState<SampleMeta | null>(null)
  const [manual, setManual] = useState<Record<string, string>>({})
  const [tags, setTags] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const fetchMeta = async () => {
    if (!target) return
    setLoading(true)
    try {
      const m = target.kind === 'sound' ? await api.soundMeta(target.id) : await api.voiceMeta(target.id)
      setMeta(m)
      const man = (m.manual || {}) as Record<string, unknown>
      const flat: Record<string, string> = {}
      for (const f of MANUAL_FIELDS[target.kind]) flat[f.key] = man[f.key] != null ? String(man[f.key]) : ''
      setManual(flat)
      setTags(Array.isArray(man.tags) ? (man.tags as string[]).join(', ') : '')
    } catch (e) {
      notify(`Couldn't load metadata: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setMeta(null)
    if (target) void fetchMeta()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.kind, target?.id])

  if (!target) return null
  const a = meta?.analysis
  const isSound = target.kind === 'sound'

  const analyze = async () => {
    setBusy(true)
    try {
      const m = await api.analyzeSound(target.id)
      setMeta(m)
      notify('Analyzed.')
    } catch (e) {
      notify(`Analysis failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {}
      for (const f of MANUAL_FIELDS[target.kind]) payload[f.key] = manual[f.key]?.trim() ? manual[f.key].trim() : null
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
      payload.tags = tagList.length ? tagList : null
      const m = isSound ? await api.setSoundMeta(target.id, payload) : await api.setVoiceMeta(target.id, payload)
      setMeta(m)
      notify('Saved.')
    } catch (e) {
      notify(`Save failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolModal open={!!target} title={`🏷 Metadata — ${target.name}`} onClose={onClose} width={620}>
      {loading ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {/* ---- Analysis (machine, read-only) — sounds only ---- */}
          {isSound && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-head">
                <h3>Analysis</h3>
                <button className="btn sm" disabled={busy || !meta?.analysis_available} onClick={analyze}
                  title={meta?.analysis_available ? '' : 'The built-in Audio Analyzer is still bootstrapping (or its bootstrap failed) — check the manager logs'}>
                  {busy ? 'Analyzing…' : a ? 'Re-analyze' : 'Analyze'}
                </button>
              </div>
              <div className="card-body">
                {!meta?.analysis_available && (
                  <div className="hint" style={{ marginBottom: 8 }}>
                    Analyzer not ready — the built-in Audio Analyzer bootstraps automatically on launch (<code>plugins/built-in-audio-analyzer/bootstrap.sh</code>). If this persists, check the manager logs.
                  </div>
                )}
                {a ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 16px' }}>
                    <Stat label="BPM" value={a.bpm != null ? Math.round(a.bpm) : '—'} />
                    <Stat label="Key" value={a.key || '—'} />
                    <Stat label="Loudness" value={a.loudness_lufs != null ? `${a.loudness_lufs} LUFS` : '—'} />
                    <Stat label="Duration" value={a.duration_s != null ? `${a.duration_s}s` : '—'} />
                    <Stat label="Danceability" value={a.danceability != null ? `${Math.round(a.danceability * 100)}%` : '—'} />
                    <Stat label="Vocal" value={a.voice_instrumental || '—'} />
                    <Block label="Genre" items={a.genre} />
                    <Block label="Mood" items={a.mood} />
                    <Block label="Instruments" items={a.instruments} />
                  </div>
                ) : (
                  <div className="empty" style={{ padding: 8 }}>
                    Not analyzed yet.{meta?.analysis_available ? ' Click Analyze.' : ''}
                  </div>
                )}
                {a && meta?.analyzed_at && (
                  <div className="hint" style={{ marginTop: 8 }}>
                    via {meta.analyzer || 'analyzer'} · {fmtTime(meta.analyzed_at)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ---- Manual (user-edited) ---- */}
          <div className="card">
            <div className="card-head"><h3>Details</h3></div>
            <div className="card-body" style={{ display: 'grid', gap: 10 }}>
              {MANUAL_FIELDS[target.kind].map((f) => (
                <label key={f.key} className="field">
                  <span className="field-label">{f.label}</span>
                  {f.key === 'notes' ? (
                    <textarea className="input" rows={2} value={manual[f.key] || ''}
                      onChange={(e) => setManual({ ...manual, [f.key]: e.target.value })} />
                  ) : (
                    <input className="input" value={manual[f.key] || ''} placeholder={f.placeholder}
                      onChange={(e) => setManual({ ...manual, [f.key]: e.target.value })} />
                  )}
                </label>
              ))}
              <label className="field">
                <span className="field-label">Tags <span className="hint">(comma-separated)</span></span>
                <input className="input" value={tags} placeholder="e.g. impact, metallic, sfx"
                  onChange={(e) => setTags(e.target.value)} />
              </label>
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button className="btn ghost" onClick={onClose}>Close</button>
            <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save details'}</button>
          </div>
        </>
      )}
    </ToolModal>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="hint" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  )
}

function Block({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <div className="hint" style={{ fontSize: 11 }}>{label}</div>
      <div>{items && items.length ? items.map((t) => <Tag key={t}>{t}</Tag>) : <span style={{ opacity: 0.5 }}>—</span>}</div>
    </div>
  )
}

export default LibraryMetadata
