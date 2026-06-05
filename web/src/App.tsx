import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { GenerateBody, HistoryEntry, Job, MultitrackSession, OutputFile, Provider, SpeakerConfig, SystemInfo, Voice, VoiceNode } from './api'
import { SidePanel } from './components/SidePanel'
import { Studio, type Injected } from './components/Studio'
import { TopBar } from './components/TopBar'
import { Toasts, type ToastItem } from './components/ui'
import { VoiceLab } from './components/VoiceLab'
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
  const [regenIndex, setRegenIndex] = useState<number | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [scriptBusy, setScriptBusy] = useState(false)
  const [injected, setInjected] = useState<Injected>({ nonce: 0, script: '' })
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [playingUrl, setPlayingUrl] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

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
            setSession(j.result.session)
            setRegenIndex(null)
            notify(j.result.regenerated_index !== undefined ? 'Segment regenerated' : 'Scene ready — edit in multitrack', 'success')
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
      setSession(null)
      const { job_id } = multitrack ? await api.multitrackGenerate(body) : await api.generate(body)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack } })
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const regenSegment = async (index: number) => {
    if (!session) return
    try {
      setRegenIndex(index)
      const { job_id } = await api.regenSegment(session.id, index)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack: true, regen: index } })
    } catch (e) {
      notify(String(e), 'error')
      setRegenIndex(null)
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
