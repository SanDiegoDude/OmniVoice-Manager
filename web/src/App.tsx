import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { GenParams, GenerateBody, HistoryEntry, HistoryState, ImportableVoice, Job, MultitrackSegment, MultitrackSession, OutputFile, Project, Provider, SegmentEdit, Sound, SoundNode, SpeakerConfig, SystemInfo, Voice, VocalTransform, VoiceNode } from './api'
import { SidePanel } from './components/SidePanel'
import ProjectImportModal from './components/ProjectImportModal'
import { Studio, type Injected } from './components/Studio'
import { injectedFromSession } from './sessionForm'
import type { PerfCaptureState } from './components/PerformanceCapture'
import { TopBar } from './components/TopBar'
import { Toasts, type ToastItem } from './components/ui'
import { VoiceLab } from './components/VoiceLab'
import { TagLibrary } from './components/TagLibrary'
import { VoiceLibrary } from './components/VoiceLibrary'
import { SoundLibrary } from './components/SoundLibrary'
import { SoundLab } from './components/SoundLab'
import { ClipGrabberLab } from './components/ClipGrabberLab'
import { AceStepLab } from './components/AceStepLab'
import { SampleEditModal, type EditTarget } from './components/SampleEditModal'
import { usePlugins } from './pluginRegistry'
import { claimPlayback, releasePlayback } from './audioBus'

export default function App() {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  // Persisted track-1 template (processing settings new tracks inherit).
  // undefined = still loading prefs; an object (possibly {}) = loaded.
  const [trackTemplate, setTrackTemplate] = useState<Partial<SpeakerConfig> | undefined>(undefined)
  const tplSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [busy, setBusy] = useState(false)
  // True from the instant a generate submit starts until the job lands in state
  // (or errors). Disables the Generate button through the async-submit gap.
  const [submitting, setSubmitting] = useState(false)
  const [voices, setVoices] = useState<Voice[]>([])
  const [tree, setTree] = useState<VoiceNode | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [selectedVoice, setSelectedVoice] = useState<string>()
  // Foley / SFX sound library (the non-vocal counterpart to the voice library).
  const [sounds, setSounds] = useState<Sound[]>([])
  const [soundTree, setSoundTree] = useState<SoundNode | null>(null)
  const [soundFolders, setSoundFolders] = useState<string[]>([])
  const [selectedSound, setSelectedSound] = useState<string>()
  // Sound Lab (generic plug-in generation modal): which plug-in, and whether
  // we're generating standalone (library) or to drop onto a timeline track.
  const [soundLab, setSoundLab] = useState<
    { pluginId: string; placement: 'library' | 'track'; defaultLibrary?: 'voice' | 'sound'; track?: { pos: string; startS: number; ripple: boolean } } | null
  >(null)
  const plugins = usePlugins()
  // Studio exposes its cast-voice action through this ref so the library can
  // load a clicked voice into a track without lifting all of Studio's state.
  const castRef = useRef<((voiceId: string, opts?: { newTrack?: boolean }) => void) | null>(null)
  const [labOpen, setLabOpen] = useState(false)
  // Sample editor (transforms → save copy / overwrite) shared by both libraries.
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [outputs, setOutputs] = useState<OutputFile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [histState, setHistState] = useState<HistoryState | null>(null)
  // Pending "import these voices into the library?" prompt after an .omvp import.
  const [voiceImport, setVoiceImport] = useState<{ sid: string; voices: ImportableVoice[] } | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [session, setSession] = useState<MultitrackSession | null>(null)
  // Cues the multitrack editor to play from a spot after a render completes.
  const [playCue, setPlayCue] = useState<{ nonce: number; index?: number; channel?: string; at?: number } | null>(null)
  // Side columns: collapsible on desktop, pop-over drawers on mobile.
  const isMobile = () => window.matchMedia('(max-width: 1000px)').matches
  const [leftOpen, setLeftOpen] = useState(() => !isMobile() && localStorage.getItem('ov-left') !== '0')
  const [rightOpen, setRightOpen] = useState(() => !isMobile() && localStorage.getItem('ov-right') !== '0')
  const toggleLeft = () =>
    setLeftOpen((v) => {
      localStorage.setItem('ov-left', v ? '0' : '1')
      return !v
    })
  const toggleRight = () =>
    setRightOpen((v) => {
      localStorage.setItem('ov-right', v ? '0' : '1')
      return !v
    })
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
  const previewBusRef = useRef(Symbol('voice-preview'))

  useEffect(() => {
    sessionRef.current = session
    // Remember the last project on screen so a refresh restores it (a brand-new
    // scene is a deliberate click on "new blank project", not a side effect of
    // reloading the page).
    if (session?.id) localStorage.setItem('ov-last-project', session.id)
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

  const refreshSounds = useCallback(async () => {
    try {
      const s = await api.sounds()
      setSounds(s.flat)
      setSoundTree(s.tree)
      setSoundFolders(s.folders ?? [])
    } catch (e) {
      notify(String(e), 'error')
    }
  }, [notify])

  const refreshVoices = useCallback(async () => {
    try {
      const v = await api.voices()
      setVoices(v.flat)
      setTree(v.tree)
      setFolders(v.folders ?? [])
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

  const refreshProjects = useCallback(async () => {
    try {
      setProjects((await api.projects()).projects)
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
    refreshSounds()
    refreshHistory()
    refreshOutputs()
    refreshProjects()
    refreshProviders()
    const iv = setInterval(refreshInfo, 4000)
    return () => clearInterval(iv)
  }, [refreshInfo, refreshVoices, refreshSounds, refreshHistory, refreshOutputs, refreshProjects, refreshProviders])

  // Keep the open project's action-history (undo/redo chain) in sync. The
  // session object changes identity on every edit, so this refetches the
  // labeled steps + cursor whenever the timeline mutates.
  useEffect(() => {
    if (!session?.id) {
      setHistState(null)
      return
    }
    let cancelled = false
    api
      .historyState(session.id)
      .then((s) => {
        if (!cancelled) setHistState(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [session])

  // Backstop for swipe-back / accidental close: confirm before leaving while a
  // scene has content (overscroll-behavior kills the gesture itself; this
  // catches actual navigation like back-button or tab close).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if ((sessionRef.current?.segment_count ?? 0) > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

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
                : j.result.bulk_sliced !== undefined
                ? `Sliced ${j.result.bulk_sliced} track${j.result.bulk_sliced === 1 ? '' : 's'} by sentence`
                : 'Scene ready — edit in multitrack'
            notify(msg, 'success')
            // Always play what was just rendered — instant "it's done" feedback.
            if (j.result.regenerated_index !== undefined) {
              setPlayCue({ nonce: Date.now(), index: j.result.regenerated_index as number })
            } else if (j.result.inserted_index !== undefined) {
              setPlayCue({ nonce: Date.now(), index: j.result.inserted_index as number })
            } else if (j.result.channel_regen !== undefined) {
              setPlayCue({ nonce: Date.now(), channel: String(j.result.channel_regen) })
            } else if (j.result.bulk_sliced === undefined) {
              // Fresh scene generation — autoplay from the top. A bulk slice just
              // re-cuts existing clips, so don't yank the playhead/playback.
              setPlayCue({ nonce: Date.now(), at: 0 })
            }
          } else {
            notify('Generation complete', 'success')
          }
          refreshHistory()
          refreshOutputs()
          refreshProjects()
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
  }, [job, notify, refreshHistory, refreshOutputs, refreshProjects, refreshInfo])

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
  const toggleTrimSilence = async (v: boolean) => {
    try {
      setInfo(await api.setTrimSilence(v))
      notify(`Auto-trim silence ${v ? 'enabled' : 'disabled'}`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const toggleAutoSlice = async (v: boolean) => {
    try {
      setInfo(await api.setAutoSlice(v))
      notify(`Auto-slice by sentence ${v ? 'enabled — new scenes slice on generate' : 'disabled'}`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const toggleFormat = async (format: string) => {
    try {
      setInfo(await api.setOutputFormat(format))
      notify(`Output format: ${format === 'mp3' ? 'MP3 (compact)' : 'FLAC (lossless)'}`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  // Load the persisted track-1 template once on mount.
  useEffect(() => {
    let cancelled = false
    api
      .getPrefs()
      .then((doc) => {
        if (cancelled) return
        const tracks = (doc?.tracks ?? {}) as { template?: Partial<SpeakerConfig> | null }
        setTrackTemplate(tracks.template ?? {})
      })
      .catch(() => {
        if (!cancelled) setTrackTemplate({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Persist the track-1 template (debounced) when Studio reports a change.
  const saveTrackTemplate = useCallback((tpl: Partial<SpeakerConfig>) => {
    setTrackTemplate(tpl)
    if (tplSaveRef.current) clearTimeout(tplSaveRef.current)
    tplSaveRef.current = setTimeout(() => {
      api.patchPrefs({ tracks: { template: tpl } }).catch(() => {})
    }, 600)
  }, [])

  // ---- voices ----
  // Delete confirmation now lives inline in the library row, so this just acts.
  const deleteVoice = async (v: Voice) => {
    try {
      await api.deleteVoice(v.id)
      refreshVoices()
      notify('Voice deleted')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const moveVoice = async (id: string, folder: string) => {
    try {
      const r = await api.moveVoice(id, folder)
      refreshVoices()
      notify(`Moved to ${r.folder || 'the library root'}`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const renameVoiceFn = async (id: string, name: string) => {
    try {
      await api.renameVoice(id, name)
      refreshVoices()
      notify('Voice renamed')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const createFolderFn = async (path: string) => {
    try {
      await api.createVoiceFolder(path)
      refreshVoices()
      notify(`Folder created`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const castVoice = (voiceId: string, opts?: { newTrack?: boolean }) => {
    if (!castRef.current) return
    castRef.current(voiceId, opts)
  }

  // ---- Sound library handlers ----
  const deleteSound = async (s: Sound) => {
    try {
      await api.deleteSound(s.id)
      refreshSounds()
      notify('Sound deleted')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const moveSound = async (id: string, folder: string) => {
    try {
      const r = await api.moveSound(id, folder)
      refreshSounds()
      notify(`Moved to ${r.folder || 'the library root'}`)
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const renameSound = async (id: string, name: string) => {
    try {
      await api.renameSound(id, name)
      refreshSounds()
      notify('Sound renamed')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const createSoundFolder = async (path: string) => {
    try {
      await api.createSoundFolder(path)
      refreshSounds()
      notify('Folder created')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const uploadSoundFn = async (file: File) => {
    try {
      await api.uploadSound(file)
      refreshSounds()
      notify(`Added “${file.name}” to the sound library`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  // Drop a freshly-generated (or library-picked) sound onto a specific audio
  // track at the double-clicked position — the in-track Sound Lab flow.
  const placeGeneratedInTrack = async (url: string, filename: string, edit?: SegmentEdit) => {
    const t = soundLab?.track
    if (!session || !t) {
      notify('Open a project to drop generated sounds onto the timeline.', 'error')
      return
    }
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error('Could not load the generated sound')
      const blob = await res.blob()
      const file = new File([blob], filename, { type: blob.type || 'audio/wav' })
      // Remember which clips exist so we can find the one we just dropped and
      // bake the Sound Lab's previewed trim/speed/gain (and foley provenance +
      // full prompt as dialogue) onto it — "what you previewed is what lands".
      const before = new Set(session.tracks.flatMap((tr) => tr.segments.map((s) => s.index)))
      const updated = await api.uploadAudioSegment(session.id, t.pos, file, t.startS, t.ripple)
      setSession(updated)
      if (edit && Object.keys(edit).length) {
        const placed = updated.tracks.flatMap((tr) => tr.segments).find((s) => !before.has(s.index))
        if (placed) {
          const fields: SegmentEdit = { ...edit }
          // The clip's dialogue is its source prompt (full text, not the slug).
          if (edit.meta?.prompt && !fields.text) fields.text = edit.meta.prompt
          setSession(await api.editSegment(updated.id, placed.index, fields))
        }
      }
      notify(`Audio sample dropped${t.ripple ? ' (rippled later clips)' : ''}`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  // Re-roll a foley clip in place via the plug-in that made it (current prompt + length).
  const regenFoley = async (index: number) => {
    if (!session) return
    try {
      setRegenIndex(index)
      const { job_id } = await api.regenFoley(session.id, index)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack: true, regen: index } })
    } catch (e) {
      notify(String(e), 'error')
      setRegenIndex(null)
    }
  }

  // Drop a library sound onto the open project as a new audio channel. Fetches
  // the sample from the server and reuses the existing upload-channel plumbing.
  const addSoundToProject = async (s: Sound) => {
    if (!session) {
      notify('Open or create a project first to drop sounds onto the timeline.', 'error')
      return
    }
    try {
      const res = await fetch(`/api/audio/sound/${s.id}`)
      if (!res.ok) throw new Error('Could not load sound')
      const blob = await res.blob()
      const file = new File([blob], s.filename, { type: blob.type || 'audio/wav' })
      await uploadChannel(file, s.name.split('/').pop() || s.name)
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const stopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    setPlayingUrl(null)
    releasePlayback(previewBusRef.current)
  }

  const playUrl = (url: string) => {
    if (!audioRef.current) audioRef.current = new Audio()
    const a = audioRef.current
    claimPlayback(previewBusRef.current, stopPlayback)
    a.onended = () => stopPlayback()
    a.src = url
    a.play().then(() => setPlayingUrl(url)).catch(() => stopPlayback())
  }

  const togglePlay = (url: string) => {
    if (playingUrl === url) stopPlayback()
    else playUrl(url)
  }

  // ---- generation ----
  // Guard against rapid-fire duplicate submits. The button disables only once a
  // job lands in state, but on slow machines the async submit (esp. perform,
  // which does heavy audio prep before returning) leaves a window where extra
  // clicks queue duplicate renders. `submitting` disables the button the instant
  // a submit starts; the ref blocks re-entry synchronously, before any await.
  const submittingRef = useRef(false)
  const beginSubmit = (): boolean => {
    if (submittingRef.current) return false
    submittingRef.current = true
    setSubmitting(true)
    return true
  }
  const endSubmit = () => {
    submittingRef.current = false
    setSubmitting(false)
  }

  const startGenerate = async (body: GenerateBody, _title: string, multitrack = false) => {
    if (!beginSubmit()) return
    try {
      if (multitrack) {
        // Keep any current skeleton up until the populated scene arrives, then
        // swap + discard the old one (see job poll).
        replacingRef.current = sessionRef.current?.id ?? null
      }
      // One-shot renders leave any ADR session untouched — the Voice Clone tab
      // is a side trip, not a scene replacement.
      const { job_id } = multitrack ? await api.multitrackGenerate(body) : await api.generate(body)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack } })
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      endSubmit()
    }
  }

  // Voice Clone tab: one-shot performance-guided render (V2V over the take).
  const performGenerate = async (
    body: GenerateBody,
    perf: PerfCaptureState,
  ) => {
    if (!beginSubmit()) return
    try {
      const { job_id } = await api.generatePerform(body, perf.blob, {
        mode: perf.mode,
        strength: perf.strength,
        gain_db: perf.gain_db,
        speed: perf.speed,
        transforms: perf.transforms,
        auto_pitch: perf.auto_pitch,
      })
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: {} })
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      endSubmit()
    }
  }

  // ---- multitrack composition: blank skeleton + on-the-fly speakers ----
  // Seed "creating" true when we have a last project to restore, so the Studio's
  // auto-create-blank effect (which fires before parent effects on mount) stands
  // down until the restore below resolves. Cleared once restore completes/fails.
  const creatingRef = useRef(!!localStorage.getItem('ov-last-project'))
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
  // Voice Clone → ADR Studio: drop a finished output at t=0 on the first
  // generative track (creating the scene with the current roster if needed).
  const importClipToStudio = useCallback(
    async (filename: string, text: string, speakers: Record<string, SpeakerConfig>, params: GenParams) => {
      try {
        if (!sessionRef.current) {
          const s = await api.multitrackEmpty({ title: 'Untitled Scene', speakers, params })
          sessionRef.current = s
          setSession(s)
        }
        const sess = sessionRef.current
        if (!sess) return
        const track = sess.tracks.find((t) => t.kind !== 'audio')
        if (!track) {
          notify('No generative track to import onto', 'error')
          return
        }
        // The session may predate the user's voice pick (an empty scene is
        // auto-created on load with a voiceless roster) — push the Voice Clone
        // tab's speaker config onto the target track so regens and performance
        // renders use the right voice, not a stale empty one.
        const cfg = speakers['1']
        if (cfg) {
          const us = await api.updateSpeaker(sess.id, track.speaker_id, cfg)
          sessionRef.current = us
          setSession(us)
        }
        const ns = await api.importClip(sess.id, {
          filename,
          speaker_id: track.speaker_id,
          text,
          start_s: 0,
        })
        sessionRef.current = ns
        setSession(ns)
        notify('Imported to ADR Studio — clip placed at 0:00 on track 1', 'success')
      } catch (e) {
        notify(String(e), 'error')
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
  const addAudioTrackToSession = useCallback(async () => {
    const s = sessionRef.current
    if (!s) return
    try {
      setSession(await api.addAudioTrack(s.id))
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
    if (!s) return null
    try {
      const next = await api.removeSpeaker(s.id, pos)
      setSession(next)
      return next
    } catch (e) {
      notify(String(e), 'error')
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const mergeSegments = async (indices: number[]) => {
    if (!session) return
    try {
      setSession(await api.mergeSegments(session.id, indices))
      notify(`Merged ${indices.length} segments into one`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const collapseTrack = async (pos: string) => {
    if (!session) return
    try {
      setSession(await api.collapseTrack(session.id, pos))
      notify('Collapsed track into one segment', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }

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
      const before = new Set<number>()
      session.tracks.forEach((t) => t.segments.forEach((s) => before.add(s.index)))
      // Whisper makes sense for speech, but it goes haywire on music/SFX — so for
      // uploaded audio channels we slice silently (no re-transcription).
      const srcTrack = session.tracks.find((t) => t.segments.some((s) => s.index === index))
      const isAudio = srcTrack?.kind === 'audio'
      const next = await api.splitSegment(session.id, index, at_s)
      setSession(next)
      if (isAudio) return
      // A manual slice duplicates the source text into both halves; re-transcribing
      // each side is almost always the next step, so do it automatically (same flow
      // as the per-segment Whisper button). The right half is the only new index.
      let newIndex: number | null = null
      next.tracks.forEach((t) =>
        t.segments.forEach((s) => {
          if (!before.has(s.index)) newIndex = s.index
        }),
      )
      for (const i of newIndex != null ? [index, newIndex] : [index]) {
        const text = await transcribeSegment(i)
        if (text != null) await setSegmentText(i, text)
      }
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
  const setPerformance = async (
    index: number,
    wav: Blob | null,
    params: { gain_db: number; speed: number; mode: 'character' | 'voice'; strength: number; text?: string },
  ) => {
    if (!session) return
    const s = await api.setPerformance(session.id, index, wav, params)
    setSession(s)
    notify('Performance saved — hit ↻ Regenerate on the clip to render it', 'success')
  }
  // Poll a job to completion outside the global poller (used by the in-modal
  // render flows, so the global job state stays free for the main UI).
  const waitJob = async (job_id: string): Promise<Job> => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 700))
      const j = await api.job(job_id)
      if (j.status === 'error') throw new Error(j.error || 'Render failed')
      if (j.status === 'done') return j
    }
  }
  const segInSession = (s: MultitrackSession, index: number): MultitrackSegment | null => {
    for (const t of s.tracks) {
      const seg = t.segments.find((sg) => sg.index === index)
      if (seg) return seg
    }
    return null
  }

  // In-modal render: save the performance, fire the regen job, poll it to
  // completion, and hand the refreshed segment back for output preview.
  const renderPerformance = async (
    index: number,
    wav: Blob | null,
    params: { gain_db: number; speed: number; mode: 'character' | 'voice'; strength: number; text?: string },
  ): Promise<MultitrackSegment | null> => {
    if (!session) return null
    const sid = session.id
    const s = await api.setPerformance(sid, index, wav, params)
    setSession(s)
    const { job_id } = await api.regenSegment(sid, index)
    setRegenIndex(index)
    try {
      const j = await waitJob(job_id)
      const ns = j.result?.session as MultitrackSession | undefined
      if (!ns) return null
      setSession(ns)
      return segInSession(ns, index)
    } finally {
      setRegenIndex(null)
    }
  }

  // In-modal plain TTS render of an existing segment (capture-performance off):
  // plain=true bypasses any attached performance so the channel voice is used.
  const regenSegmentAndWait = async (index: number, text?: string): Promise<MultitrackSegment | null> => {
    if (!session) return null
    const { job_id } = await api.regenSegment(session.id, index, text, true)
    setRegenIndex(index)
    try {
      const j = await waitJob(job_id)
      const ns = j.result?.session as MultitrackSession | undefined
      if (!ns) return null
      setSession(ns)
      return segInSession(ns, index)
    } finally {
      setRegenIndex(null)
    }
  }

  // Record Dialog first render: insert a fresh segment (TTS), then optionally
  // run the performance transfer on top of it. Returns the final segment.
  const insertAndRender = async (
    speakerId: string,
    text: string,
    startS: number,
    perf: {
      wav: Blob | null
      params: { gain_db: number; speed: number; mode: 'character' | 'voice'; strength: number; text?: string }
    } | null,
  ): Promise<MultitrackSegment | null> => {
    if (!session) return null
    const sid = session.id
    const { job_id } = await api.insertSegment(sid, { speaker_id: speakerId, text, start_s: startS, ripple: false })
    const j = await waitJob(job_id)
    let ns = j.result?.session as MultitrackSession | undefined
    const index = j.result?.inserted_index as number | undefined
    if (!ns || index === undefined) return null
    setSession(ns)
    if (perf) {
      const s2 = await api.setPerformance(sid, index, perf.wav, perf.params)
      setSession(s2)
      const r = await api.regenSegment(sid, index)
      setRegenIndex(index)
      try {
        const j2 = await waitJob(r.job_id)
        const ns2 = j2.result?.session as MultitrackSession | undefined
        if (ns2) {
          setSession(ns2)
          ns = ns2
        }
      } finally {
        setRegenIndex(null)
      }
    }
    return segInSession(ns, index)
  }
  const clearPerformance = async (index: number) => {
    if (!session) return
    try {
      setSession(await api.clearPerformance(session.id, index))
      notify('Performance removed — back to plain TTS regen', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const applyTransform = async (index: number, transforms: VocalTransform) => {
    if (!session) return
    try {
      setSession(await api.applySegmentTransform(session.id, index, transforms))
      notify('Vocal transforms applied to segment', 'success')
    } catch (e) {
      notify(String(e), 'error')
      throw e
    }
  }
  const isolateSegment = async (index: number, stem: 'vocals' | 'instrumental') => {
    if (!session) return
    try {
      setSession(await api.isolateSegment(session.id, index, stem))
      notify(`Isolated ${stem === 'instrumental' ? 'instrumental' : 'voice'} on segment`, 'success')
    } catch (e) {
      notify(String(e), 'error')
      throw e
    }
  }
  const transcribeClip = (wav: Blob) => api.transcribeClip(wav)
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
  const redoSession = async () => {
    if (!session) return
    try {
      setSession(await api.redo(session.id))
      notify('Redid the last action', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const jumpHistory = async (index: number) => {
    if (!session) return
    try {
      setSession(await api.historyJump(session.id, index))
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
  const duplicateSegment = async (index: number, start_s: number, ripple: boolean, speakerId?: string) => {
    if (!session) return
    try {
      setSession(await api.duplicateSegment(session.id, index, start_s, ripple, speakerId))
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

  const editSegment = async (index: number, fields: { start_s?: number; trim_start_s?: number; trim_end_s?: number; speed?: number; gain_db?: number; fade_in_s?: number; fade_out_s?: number }) => {
    if (!session) return
    try {
      setSession(await api.editSegment(session.id, index, fields))
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const moveSegment = async (index: number, speakerId: string, startS: number) => {
    if (!session) return
    try {
      const s = await api.moveSegment(session.id, index, speakerId, startS)
      setSession(s)
      const name = s.tracks.find((t) => t.speaker_id === speakerId)?.name ?? speakerId
      notify(`Clip moved to “${name}” — hit ↻ Regenerate to render it in that voice`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  const reorderTracks = async (order: string[]): Promise<MultitrackSession | null> => {
    if (!session) return null
    try {
      const s = await api.reorderTracks(session.id, order)
      setSession(s)
      return s
    } catch (e) {
      notify(String(e), 'error')
      return null
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

  const uploadChannel = async (file: File, name: string, startS = 0) => {
    if (!session) return
    try {
      setSession(await api.uploadChannel(session.id, file, name, startS))
      notify('Audio channel added', 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const uploadAudioSegment = async (pos: string, file: File, startS: number, ripple: boolean) => {
    if (!session) return
    try {
      setSession(await api.uploadAudioSegment(session.id, pos, file, startS, ripple))
      notify(`Audio sample dropped${ripple ? ' (rippled later clips)' : ''}`, 'success')
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

  // Heavy: sentence-slice every voice track. Runs as a polled job so the UI
  // shows progress and stays busy-locked until the whole batch lands.
  const bulkSlice = async () => {
    if (!session) return
    try {
      const { job_id } = await api.bulkSlice(session.id)
      setJob({ id: job_id, status: 'queued', progress: {}, result: null, error: null, meta: { multitrack: true, bulk_slice: true } })
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

  const generateScript = async (prompt: string, numSpeakers: number, speakers: SpeakerConfig[], existing: string, monologue: boolean) => {
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
        monologue,
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

  // ---- projects (browse / open / rename / delete / share) ----
  const openProject = async (sid: string) => {
    if (sid === sessionRef.current?.id) return
    try {
      const s = await api.openProject(sid)
      sessionRef.current = s
      setSession(s)
      // Rehydrate the speaker form (reference-voice selectors, toggles) + script
      // from the restored scene — otherwise it keeps the previous roster.
      setInjected(injectedFromSession(s))
      notify(`Opened “${s.title}” — restored into the editor`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  // On first load, restore the last project that was on screen (if it still
  // exists). `creatingRef` was seeded true to hold off the auto-blank scene.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const last = localStorage.getItem('ov-last-project')
    if (!last) return
    ;(async () => {
      try {
        const s = await api.openProject(last)
        sessionRef.current = s
        setSession(s)
        setInjected(injectedFromSession(s))
      } catch {
        // The project was deleted/renamed away — fall back to a fresh scene.
        localStorage.removeItem('ov-last-project')
      } finally {
        creatingRef.current = false
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const renameProject = async (sid: string, title: string) => {
    try {
      const s = await api.renameProject(sid, title)
      if (sid === sessionRef.current?.id) setSession(s)
      refreshProjects()
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const duplicateProject = async (sid: string) => {
    try {
      const s = await api.duplicateProject(sid)
      refreshProjects()
      notify(`Forked → “${s.title}”`, 'success')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const deleteProject = async (sid: string) => {
    try {
      await api.discardSession(sid)
      if (sid === sessionRef.current?.id) {
        sessionRef.current = null
        setSession(null)
      }
      refreshProjects()
      notify('Project deleted')
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const newBlankProject = () => {
    // Wipe the editor for the next job. The current project stays saved on disk
    // (re-openable from the Projects list), so no "are you sure?" is needed.
    sessionRef.current = null
    setSession(null)
    setInjected({ nonce: Date.now(), script: '', prompt: '', title: 'Untitled Scene' })
    notify('Fresh project — editor cleared')
  }
  const importProject = async (file: File) => {
    try {
      const { session: s, import_report } = await api.importProject(file)
      sessionRef.current = s
      setSession(s)
      setInjected(injectedFromSession(s))
      refreshProjects()
      notify(`Imported “${s.title}” — opened in the editor`, 'success')
      // Offer to fold any voices the project shipped but this library lacks.
      if (import_report.voices.length > 0) setVoiceImport({ sid: s.id, voices: import_report.voices })
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const importVoices = async (picks: { track: string; file: string; name: string; folder: string }[]) => {
    if (!voiceImport) return
    try {
      if (picks.length > 0) {
        const s = await api.importVoices(voiceImport.sid, picks)
        if (sessionRef.current?.id === s.id) {
          sessionRef.current = s
          setSession(s)
          setInjected(injectedFromSession(s))
        }
        refreshVoices()
        notify(`Imported ${picks.length} voice${picks.length === 1 ? '' : 's'} into your library`, 'success')
      }
    } catch (e) {
      notify(String(e), 'error')
    } finally {
      setVoiceImport(null)
    }
  }

  // ---- outputs (rename / delete) ----
  const deleteOutput = async (filename: string) => {
    try {
      await api.deleteOutput(filename)
      refreshOutputs()
    } catch (e) {
      notify(String(e), 'error')
    }
  }
  const renameOutput = async (filename: string, name: string) => {
    try {
      await api.renameOutput(filename, name)
      refreshOutputs()
    } catch (e) {
      notify(String(e), 'error')
    }
  }

  // ---- script drafts (restore into the Studio) ----
  const restoreScript = (e: HistoryEntry) => {
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
  const deleteScript = async (id: string) => {
    await api.deleteHistory(id)
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
        onToggleTrimSilence={toggleTrimSilence}
        onToggleAutoSlice={toggleAutoSlice}
        onToggleFormat={toggleFormat}
      />
      <div className={`workspace${leftOpen ? '' : ' no-left'}${rightOpen ? '' : ' no-right'}`}>
        <div className="col side-left">
          <VoiceLibrary
            tree={tree}
            flat={voices}
            folders={folders}
            count={voices.length}
            selected={selectedVoice}
            playingUrl={playingUrl}
            onPlay={(v) => togglePlay(`/api/audio/voice/${v.id}`)}
            onPick={(v) => setSelectedVoice(v.id)}
            onCast={castVoice}
            onDelete={deleteVoice}
            onMove={moveVoice}
            onRename={renameVoiceFn}
            onEdit={(v) => setEditTarget({ kind: 'voice', id: v.id, name: v.name, folder: v.folder })}
            onCreateFolder={createFolderFn}
            onRefresh={refreshVoices}
            onOpenLab={() => setLabOpen(true)}
            onPluginGenerate={(pluginId) => setSoundLab({ pluginId, placement: 'library', defaultLibrary: 'voice' })}
          />
          <SoundLibrary
            tree={soundTree}
            flat={sounds}
            folders={soundFolders}
            count={sounds.length}
            selected={selectedSound}
            playingUrl={playingUrl}
            hasSession={!!session}
            onPlay={(s) => togglePlay(`/api/audio/sound/${s.id}`)}
            onPick={(s) => setSelectedSound(s.id)}
            onAddToProject={addSoundToProject}
            onDelete={deleteSound}
            onMove={moveSound}
            onRename={renameSound}
            onEdit={(s) => setEditTarget({ kind: 'sound', id: s.id, name: s.name, folder: s.folder })}
            onCreateFolder={createSoundFolder}
            onUpload={uploadSoundFn}
            onRefresh={refreshSounds}
            onGenerate={(pluginId) => setSoundLab({ pluginId, placement: 'library', defaultLibrary: 'sound' })}
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
          onPerformGenerate={performGenerate}
          onGenerateScript={generateScript}
          onLucky={startGenerate}
          onRegenSegment={regenSegment}
          onRegenFoley={regenFoley}
          onEditSegment={editSegment}
          onReflow={reflowSession}
          onInsertSegment={insertSegment}
          onEnsureSession={ensureEmptySession}
          onImportToStudio={importClipToStudio}
          onAddSpeaker={addSpeakerToSession}
          onAddAudioTrack={addAudioTrackToSession}
          onUpdateSpeaker={updateSpeakerInSession}
          onRemoveSpeaker={removeSpeakerFromSession}
          onDeleteSegment={deleteSegment}
          onSplitSegment={splitSegment}
          onAutoSlice={autoSlice}
          onBulkSlice={bulkSlice}
          onSetInpaint={setInpaint}
          onSetPreserveNonvocal={setPreserveNonvocal}
          onPromoteChannel={promoteChannel}
          onMergeSegments={mergeSegments}
          onCollapseTrack={collapseTrack}
          onMoveSegment={moveSegment}
          onReorderTracks={reorderTracks}
          onVoiceSaved={refreshVoices}
          onUndo={undoSession}
          onRedo={redoSession}
          playCue={playCue}
          onSetPerformance={setPerformance}
          onRenderPerformance={renderPerformance}
          onRegenAndWait={regenSegmentAndWait}
          onInsertAndRender={insertAndRender}
          onClearPerformance={clearPerformance}
          onApplyTransform={applyTransform}
          onIsolateSegment={isolateSegment}
          onTranscribeClip={transcribeClip}
          onDeleteSpace={deleteSpace}
          onAddSpace={addSpace}
          onDuplicateSegment={duplicateSegment}
          onSetSegmentText={setSegmentText}
          onTranscribeSegment={transcribeSegment}
          onSetChannel={setChannel}
          onRegenChannel={regenChannel}
          onUploadChannel={uploadChannel}
          onUploadAudioSegment={uploadAudioSegment}
          onPluginGenerate={(pluginId, track) => setSoundLab({ pluginId, placement: 'track', track })}
          onFinalize={finalizeSession}
          notify={notify}
          submitting={submitting}
          trimSilence={!!info?.trim_silence}
          trackTemplate={trackTemplate}
          onTrackTemplate={saveTrackTemplate}
          castRef={castRef}
        />

        <div className="col side-right">
          <SidePanel
            projects={projects}
            outputs={outputs}
            histState={histState}
            scripts={history.filter((e) => e.type === 'script')}
            activeSessionId={session?.id ?? null}
            playingUrl={playingUrl}
            onOpenProject={openProject}
            onRenameProject={renameProject}
            onDuplicateProject={duplicateProject}
            onDeleteProject={deleteProject}
            onNewProject={newBlankProject}
            onImportProject={importProject}
            onDeleteOutput={deleteOutput}
            onRenameOutput={renameOutput}
            onUndo={undoSession}
            onRedo={redoSession}
            onJumpHistory={jumpHistory}
            onRestoreScript={restoreScript}
            onDeleteScript={deleteScript}
            onTogglePlay={togglePlay}
          />
        </div>
      </div>

      {/* Side-panel toggles: ride the panel edge when open, dock to the screen
          edge when closed. On mobile the panels become overlay drawers. */}
      <button
        className={`edge-tab left${leftOpen ? ' open' : ''}`}
        onClick={toggleLeft}
        title={leftOpen ? 'Hide voices & tags' : 'Voices & tags'}
        aria-label="Toggle voice library"
      >
        {leftOpen ? '◂' : '🎙'}
      </button>
      <button
        className={`edge-tab right${rightOpen ? ' open' : ''}`}
        onClick={toggleRight}
        title={rightOpen ? 'Hide history & outputs' : 'History & outputs'}
        aria-label="Toggle history"
      >
        {rightOpen ? '▸' : '🕘'}
      </button>
      {(leftOpen || rightOpen) && (
        <div
          className="drawer-backdrop"
          onClick={() => {
            if (leftOpen) toggleLeft()
            if (rightOpen) toggleRight()
          }}
        />
      )}

      {labOpen && (
          <VoiceLab voices={voices} folders={folders} onClose={() => setLabOpen(false)} onSaved={refreshVoices} notify={notify} />
      )}
      {(() => {
        const labPlugin = plugins.find((p) => p.id === soundLab?.pluginId) ?? null
        // Plug-ins that declare the "url-clipper" kind get the dedicated Clip
        // Grabber lab (fetch → rich editor → clean → save); everything else uses
        // the generic schema-driven Sound Lab.
        const isClipper = labPlugin?.ui?.kind === 'url-clipper'
        // The "music-generator" kind (e.g. ACE-Step) gets its own lab: a prompt +
        // lyrics + planner UI, optional input-audio guidance, reroll, and the
        // shared editor → save to the sound library.
        const isMusic = labPlugin?.ui?.kind === 'music-generator'
        const isBespoke = isClipper || isMusic
        return (
          <>
            <SoundLab
              open={!!soundLab && !isBespoke}
              plugin={isBespoke ? null : labPlugin}
              onClose={() => setSoundLab(null)}
              placement={soundLab?.placement ?? 'library'}
              sessionId={session?.id ?? null}
              folders={soundFolders}
              voiceFolders={folders}
              defaultLibrary={soundLab?.defaultLibrary}
              scriptConfigured={!!info?.script_ai?.configured}
              scriptLabel={info?.script_ai?.label ?? null}
              librarySounds={sounds}
              onGenerated={() => { refreshSounds(); refreshVoices() }}
              onPlaceInTrack={placeGeneratedInTrack}
              notify={notify}
            />
            <ClipGrabberLab
              open={!!soundLab && isClipper}
              plugin={isClipper ? labPlugin : null}
              onClose={() => setSoundLab(null)}
              sessionId={session?.id ?? null}
              folders={soundFolders}
              voiceFolders={folders}
              defaultLibrary={soundLab?.defaultLibrary ?? 'voice'}
              outputFormat={info?.output_format}
              onSaved={() => { refreshSounds(); refreshVoices() }}
              notify={notify}
            />
            <AceStepLab
              open={!!soundLab && isMusic}
              plugin={isMusic ? labPlugin : null}
              onClose={() => setSoundLab(null)}
              sessionId={session?.id ?? null}
              folders={soundFolders}
              librarySounds={sounds}
              outputFormat={info?.output_format}
              scriptConfigured={!!info?.script_ai?.configured}
              scriptLabel={info?.script_ai?.label ?? null}
              onSaved={() => { refreshSounds(); refreshVoices() }}
              notify={notify}
            />
          </>
        )
      })()}
      <SampleEditModal
        open={!!editTarget}
        target={editTarget}
        folders={editTarget?.kind === 'sound' ? soundFolders : folders}
        onClose={() => setEditTarget(null)}
        onSaved={editTarget?.kind === 'sound' ? refreshSounds : refreshVoices}
        notify={notify}
      />
      {voiceImport && (
        <ProjectImportModal voices={voiceImport.voices} onImport={importVoices} onClose={() => setVoiceImport(null)} />
      )}
      <Toasts items={toasts} />
    </div>
  )
}
