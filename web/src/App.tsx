import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { GenParams, GenerateBody, HistoryEntry, Job, MultitrackSession, OutputFile, Provider, SpeakerConfig, SystemInfo, Voice, VoiceNode } from './api'
import { SidePanel } from './components/SidePanel'
import { Studio, type Injected } from './components/Studio'
import { TopBar } from './components/TopBar'
import { Toasts, type ToastItem } from './components/ui'
import { VoiceLab } from './components/VoiceLab'
import { TagLibrary } from './components/TagLibrary'
import { VoiceLibrary } from './components/VoiceLibrary'

export default function App() {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [voices, setVoices] = useState<Voice[]>([])
  const [tree, setTree] = useState<VoiceNode | null>(null)
  const [selectedVoice, setSelectedVoice] = useState<string>()
  const [labOpen, setLabOpen] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [outputs, setOutputs] = useState<OutputFile[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [session, setSession] = useState<MultitrackSession | null>(null)
  const sessionRef = useRef<MultitrackSession | null>(null)
  const replacingRef = useRef<string | null>(null)
  const [regenIndex, setRegenIndex] = useState<number | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [scriptBusy, setScriptBusy] = useState(false)
  const [injected, setInjected] = useState<Injected>({ nonce: 0, script: '' })
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [playingUrl, setPlayingUrl] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const notify = useCallback((message: string, kind: 'info' | 'error' | 'success' = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, message, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await api.systemInfo())
    } catch {
      /* server may be starting */
    }
  }, [])

  const refreshVoices = useCallback(async () => {
    try {
      const v = await api.voices()
      setVoices(v.flat)
      setTree(v.tree)
    } catch (e) {
      notify(String(e), 'error')
    }
  }, [notify])

  const refreshHistory = useCallback(async () => {
    try {
      setHistory((await api.history()).entries)
    } catch {
      /* ignore */
    }
  }, [])

  const refreshOutputs = useCallback(async () => {
    try {
      setOutputs((await api.outputs()).outputs)
    } catch {
      /* ignore */
    }
  }, [])

  const refreshProviders = useCallback(async () => {
    try {
      const r = await api.scriptProviders()
      setProviders(r.providers)
      setActiveProvider(r.active)
    } catch {
      /* ignore */
    }
  }, [])

  const selectProvider = useCallback(
    async (id: string) => {
      try {
        const r = await api.selectProvider(id)
        setProviders(r.providers)
        setActiveProvider(r.active)
      } catch (e) {
        notify(String(e), 'error')
      }
    },
    [notify],
  )

  const reloadProviders = useCallback(async () => {
    try {
      const r = await api.reloadProviders()
      setProviders(r.providers)
      setActiveProvider(r.active)
      notify(`Reloaded ${r.providers.length} provider(s) from .env`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }, [notify])

  useEffect(() => {
    refreshInfo()
    refreshVoices()
    refreshHistory()
    refreshOutputs()
    refreshProviders()
    const iv = setInterval(refreshInfo, 4000)
    return () => clearInterval(iv)
  }, [refreshInfo, refreshVoices, refreshHistory, refreshOutputs, refreshProviders])

  // Poll the active job.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return
    const iv = setInterval(async () => {
      try {
        const j = await api.job(job.id)
        setJob(j)
        if (j.status === 'done') {
          if (j.result?.session) {
            const newSession = j.result.session
            setSession(newSession)
            if (replacingRef.current && replacingRef.current !== newSession.id) {
              api.discardSession(replacingRef.current).catch(() => {})
            }
            replacingRef.current = null
            setRegenIndex(null)
            const msg =
              j.result.regenerated_index !== undefined
                ? 'Segment regenerated'
                : j.result.inserted_index !== undefined
                ? 'Segment added'
                : j.result.channel_regen !== undefined
                ? 'Channel regenerated'
                : 'Scene ready — edit in multitrack'
            notify(msg, 'success')
          } else {
            notify('Generation complete', 'success')
          }
          refreshHistory()
          refreshOutputs()
          refreshInfo()
        } else if (j.status === 'error') {
          notify('Generation failed', 'error')
          setRegenIndex(null)
        }
      } catch {
        /* ignore */
      }
    }, 600)
    return () => clearInterval(iv)
  }, [job, notify, refreshHistory, refreshOutputs, refreshInfo])

  // ---- model actions ----
  const loadModel = async () => {
    setBusy(true)
    try {
      setInfo(await api.loadModel())
      notify('Model loaded', 'success')
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const unloadModel = async () => {
    setBusy(true)
    try {
      setInfo(await api.unloadModel())
      notify('Model unloaded', 'success')
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const toggleLod = async (v: boolean) => {
    try {
      setInfo(await api.setLod(v))
      notify(`Load-on-demand ${v ? 'enabled' : 'disabled'}`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const toggleLowVram = async (v: boolean) => {
    try {
      setInfo(await api.setLowVram(v))
      notify(`Low VRAM mode ${v ? 'enabled' : 'disabled'}`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  // ---- voices ----
  const playVoice = (v: Voice) => playUrl(`/api/audio/voice/${v.id}`)
  const deleteVoice = async (v: Voice) => {
    if (!confirm(`Delete voice “${v.name}”?`)) return
    try {
      await api.deleteVoice(v.id)
      refreshVoices()
      notify('Voice deleted')
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const playUrl = (url: string) => {
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current
    a.onended = () => setPlayingUrl(null)
    a.src = url
    a.play().then(() => setPlayingUrl(url)).catch(() => setPlayingUrl(null))
  }

  const stopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    setPlayingUrl(null)
  }

  const togglePlay = (url: string) => {
    if (playingUrl === url) stopPlayback()
    else playUrl(url)
  }

  // ---- generation ----
  const startGenerate = async (body: GenerateBody, _title: string, multitrack = false) => {
    try {
      if (multitrack) {
        // Keep any current skeleton up until the populated scene arrives, then
        // swap + discard the old one (see job poll).
        replacingRef.current = sessionRef.current?.id ?? null
      } else {
        setSession(null)
      }
      const { job_id } = multitrack ? await api.multitrackGenerate(body) : await api.generate(body)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack } })
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  // ---- multitrack composition: blank skeleton + on-the-fly speakers ----
  const creatingRef = useRef(false)
  const ensureEmptySession = useCallback(
    async (speakers: Record<string, SpeakerConfig>, params: GenParams) => {
      if (sessionRef.current || creatingRef.current) return
      creatingRef.current = true
      try {
        const s = await api.multitrackEmpty({ title: 'Untitled Scene', speakers, params })
        sessionRef.current = s
        setSession(s)
      } catch (e) {
        notify(String(e), 'error')
      } finally {
        creatingRef.current = false
      }
    },
    [notify],
  )
  const addSpeakerToSession = useCallback(async (cfg: SpeakerConfig) => {
    const s = sessionRef.current
    if (!s) return
    try {
      setSession(await api.addSpeaker(s.id, cfg))
    } catch (e) {
      notify(String(e), 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const updateSpeakerInSession = useCallback(async (pos: string, cfg: SpeakerConfig) => {
    const s = sessionRef.current
    if (!s) return
    try {
      setSession(await api.updateSpeaker(s.id, pos, cfg))
    } catch {
      /* roster edits are best-effort */
    }
  }, [])
  const removeSpeakerFromSession = useCallback(async (pos: string) => {
    const s = sessionRef.current
    if (!s) return
    try {
      setSession(await api.removeSpeaker(s.id, pos))
    } catch (e) {
      notify(String(e), 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const deleteSegment = async (index: number, ripple: boolean) => {
    if (!session) return
    try {
      setSession(await api.deleteSegment(session.id, index, ripple))
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const splitSegment = async (index: number, at_s: number) => {
    if (!session) return
    try {
      setSession(await api.splitSegment(session.id, index, at_s))
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const autoSlice = async (index: number) => {
    if (!session) return
    try {
      const s = await api.autoSlice(session.id, index)
      const before = session.segment_count
      setSession(s)
      notify(`Sliced into ${s.segment_count - before + 1} sentence clips`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const setInpaint = async (index: number, enabled: boolean) => {
    if (!session) return
    try {
      setSession(await api.setInpaint(session.id, index, enabled))
      notify(enabled ? 'Vocal Inpaint locked — regen uses this clip’s voice' : 'Vocal Inpaint off', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const setPreserveNonvocal = async (index: number, enabled: boolean) => {
    if (!session) return
    try {
      setSession(await api.setPreserveNonvocal(session.id, index, enabled))
      notify(enabled ? 'Non-vocal bed will be mixed back on regen' : 'Non-vocal bed off', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const promoteChannel = async (pos: string, name: string) => {
    if (!session) return null
    try {
      const s = await api.promoteChannel(session.id, pos, name)
      setSession(s)
      notify('Promoted to a new voice channel', 'success')
      return s
    } catch (e) {
      notify(String(e), 'error')
      return null
    }
  }
  const undoSession = async () => {
    if (!session) return
    try {
      setSession(await api.undo(session.id))
      notify('Undid the last action', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const deleteSpace = async (start_s: number, amount: number) => {
    if (!session) return
    try {
      setSession(await api.deleteSpace(session.id, start_s, amount))
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const addSpace = async (start_s: number, amount: number) => {
    if (!session) return
    try {
      setSession(await api.addSpace(session.id, start_s, amount))
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const duplicateSegment = async (index: number, start_s: number, ripple: boolean) => {
    if (!session) return
    try {
      setSession(await api.duplicateSegment(session.id, index, start_s, ripple))
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const setSegmentText = async (index: number, text: string) => {
    if (!session) return
    try {
      setSession(await api.setSegmentText(session.id, index, text))
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const transcribeSegment = async (index: number, draft?: { trim_start_s?: number; trim_end_s?: number; speed?: number }) => {
    if (!session) return null
    try {
      const res = await api.transcribeSegment(session.id, index, draft)
      return res.text
    } catch (e) {
      notify(String(e), 'error')
      return null
    }
  }

  const regenSegment = async (index: number, text?: string) => {
    if (!session) return
    try {
      setRegenIndex(index)
      const { job_id } = await api.regenSegment(session.id, index, text)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack: true, regen: index } })
    } catch (e) {
      notify(String(e), 'error')
      setRegenIndex(null)
    }
  }

  const editSegment = async (index: number, fields: { start_s?: number; trim_start_s?: number; trim_end_s?: number; speed?: number; gain_db?: number }) => {
    if (!session) return
    try {
      setSession(await api.editSegment(session.id, index, fields))
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const setChannel = async (pos: string, fields: { name?: string | null; gain_db?: number }) => {
    if (!session) return
    try {
      setSession(await api.setChannel(session.id, pos, fields))
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const regenChannel = async (pos: string) => {
    if (!session) return
    try {
      const { job_id } = await api.regenChannel(session.id, pos)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack: true, channel_regen: pos } })
      notify('Regenerating all segments on this channel…', 'info')
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const uploadChannel = async (file: File, name: string) => {
    if (!session) return
    try {
      setSession(await api.uploadChannel(session.id, file, name))
      notify('Audio channel added', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const reflowSession = async (fields: { gap_ms?: number; speed?: number }) => {
    if (!session) return
    try {
      setSession(await api.reflowSession(session.id, fields))
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const insertSegment = async (speaker_id: string, text: string, start_s: number, ripple: boolean) => {
    if (!session) return
    try {
      const { job_id } = await api.insertSegment(session.id, { speaker_id, text, start_s, ripple })
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack: true } })
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const finalizeSession = async () => {
    if (!session) return
    setFinalizing(true)
    try {
      const r = await api.finalizeSession(session.id)
      notify(`Finalized “${r.title || session.title}” → saved to history`, 'success')
      refreshHistory()
      refreshOutputs()
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      setFinalizing(false)
    }
  }

  const generateScript = async (prompt: string, numSpeakers: number, speakers: SpeakerConfig[], existing: string) => {
    setScriptBusy(true)
    try {
      const res = await api.script({
        prompt,
        num_speakers: numSpeakers,
        speakers: speakers.map((s) => ({
          name: s.voice ? s.voice.split('/').pop()?.replace(/\.[^.]+$/, '') : undefined,
          instruct: s.instruct || undefined,
          voice: s.voice || undefined,
        })),
        existing_script: existing,
      })
      notify(`Script “${res.title}” ready`, 'success')
      refreshHistory()
      return { title: res.title, script: res.script }
    } catch (e) {
      notify(String(e), 'error')
      return null
    } finally {
      setScriptBusy(false)
    }
  }

  // ---- history ----
  const restore = (e: HistoryEntry) => {
    setInjected({
      nonce: Date.now(),
      script: e.script ?? '',
      prompt: e.prompt ?? '',
      title: e.title,
      multi_speaker: e.multi_speaker,
      num_speakers: e.num_speakers,
      speakers: e.speakers,
      params: e.params,
    })
    const restored = e.speakers && Object.keys(e.speakers).length ? ' (with speakers & settings)' : ''
    notify(`Restored “${e.title}”${restored}`)
  }
  const deleteHistory = async (id: string) => {
    await api.deleteHistory(id)
    refreshHistory()
  }
  const clearHistory = async () => {
    if (!confirm('Clear all history?')) return
    await api.clearHistory()
    refreshHistory()
  }

  return (
    <div className="app">
      <TopBar
        info={info}
        busy={busy}
        onLoad={loadModel}
        onUnload={unloadModel}
        onToggleLod={toggleLod}
        onToggleLowVram={toggleLowVram}
      />
      <div className="workspace">
        <div className="col">
          <VoiceLibrary
            tree={tree}
            count={voices.length}
            selected={selectedVoice}
            onPlay={playVoice}
            onPick={(v) => setSelectedVoice(v.id)}
            onDelete={deleteVoice}
            onRefresh={refreshVoices}
            onOpenLab={() => setLabOpen(true)}
          />
          <TagLibrary notify={notify} />
        </div>

        <Studio
          voices={voices}
          job={job}
          scriptBusy={scriptBusy}
          injected={injected}
          providers={providers}
          activeProvider={activeProvider}
          session={session}
          regenIndex={regenIndex}
          finalizing={finalizing}
          onSelectProvider={selectProvider}
          onReloadProviders={reloadProviders}
          onGenerate={startGenerate}
          onGenerateScript={generateScript}
          onLucky={startGenerate}
          onRegenSegment={regenSegment}
          onEditSegment={editSegment}
          onReflow={reflowSession}
          onInsertSegment={insertSegment}
          onEnsureSession={ensureEmptySession}
          onAddSpeaker={addSpeakerToSession}
          onUpdateSpeaker={updateSpeakerInSession}
          onRemoveSpeaker={removeSpeakerFromSession}
          onDeleteSegment={deleteSegment}
          onSplitSegment={splitSegment}
          onAutoSlice={autoSlice}
          onSetInpaint={setInpaint}
          onSetPreserveNonvocal={setPreserveNonvocal}
          onPromoteChannel={promoteChannel}
          onUndo={undoSession}
          onDeleteSpace={deleteSpace}
          onAddSpace={addSpace}
          onDuplicateSegment={duplicateSegment}
          onSetSegmentText={setSegmentText}
          onTranscribeSegment={transcribeSegment}
          onSetChannel={setChannel}
          onRegenChannel={regenChannel}
          onUploadChannel={uploadChannel}
          onFinalize={finalizeSession}
          notify={notify}
        />

        <div className="col">
          <SidePanel
            history={history}
            outputs={outputs}
            playingUrl={playingUrl}
            onRestore={restore}
            onDeleteHistory={deleteHistory}
            onClearHistory={clearHistory}
            onTogglePlay={togglePlay}
          />
        </div>
      </div>

      {labOpen && (
        <VoiceLab voices={voices} onClose={() => setLabOpen(false)} onSaved={refreshVoices} notify={notify} />
      )}
      <Toasts items={toasts} />
    </div>
  )
}
