// API client + shared types for the OmniVoice Manager UI.

export interface GpuInfo {
  used_mb: number | null
  total_mb: number | null
  name: string | null
  available: boolean
}

export interface SystemInfo {
  model_id: string
  loaded: boolean
  worker_alive: boolean
  load_on_demand: boolean
  low_vram: boolean
  trim_silence?: boolean
  auto_slice?: boolean
  output_format?: string
  device: string
  dtype: string
  uptime_s: number | null
  gpu: GpuInfo
  available_models: string[]
  script_ai: { model: string | null; label?: string | null; configured: boolean; endpoint: string | null; active_provider?: string | null }
}

export interface Voice {
  id: string
  name: string
  folder: string
  filename: string
  size_kb: number
}

export interface VoiceNode {
  name: string
  folders: Record<string, VoiceNode>
  voices: Voice[]
}

/** A foley / SFX sample in the sound library (non-vocal counterpart to Voice). */
export interface Sound {
  id: string
  name: string
  folder: string
  filename: string
  size_kb: number
  duration_s?: number
}

export interface SoundNode {
  name: string
  folders: Record<string, SoundNode>
  sounds: Sound[]
}

/** Core-owned analysis schema, filled by an analyzer provider (Essentia). */
export interface SampleAnalysis {
  bpm: number | null
  key: string | null
  loudness_lufs: number | null
  duration_s: number | null
  danceability: number | null
  instruments: string[]
  genre: string[]
  mood: string[]
  voice_instrumental: string | null
  extra: Record<string, unknown>
}

/** A sample's full metadata record: machine analysis + user-edited manual bag. */
export interface SampleMeta {
  analysis: SampleAnalysis | null
  analyzer: string | null
  analyzed_at: number | null
  manual: Record<string, unknown>
  path: string
  name: string
  updated_at: number | null
  analysis_available: boolean
  analyzing?: boolean
}

/** One declarative UI contribution a plug-in injects into a host "slot"
 * (e.g. a left-bar panel action, or an item in the track double-click menu). */
export interface PluginContribution {
  slot: string
  label: string
  icon?: string
  opens?: string // key of a ui block to open (e.g. "lab")
}

/** A field in a plug-in's generation schema, rendered generically by Sound Lab. */
export interface PluginLabField {
  key: string
  type: 'textarea' | 'number' | 'text' | 'toggle' | 'select' | 'seed'
  label: string
  primary?: boolean
  advanced?: boolean
  unit?: string
  min?: number
  max?: number
  step?: number
  rows?: number
  default?: unknown
  options?: string[]
  placeholder?: string
}

export interface PluginLabCategory {
  id: string
  duration?: number
  placeholder?: string
}

/** A plug-in's generation modal schema (the "lab"). */
export interface PluginLab {
  title?: string
  filename_from?: string
  categories?: PluginLabCategory[]
  fields: PluginLabField[]
  reprompt?: boolean
  /** Which libraries a generated take may be saved into. Order sets the
   * default; the Lab shows a target picker when more than one is allowed.
   * Omitted → ["sound"] (the original foley behaviour). */
  save_to?: ('voice' | 'sound')[]
}

export interface PluginUI {
  kind?: string
  contributions?: PluginContribution[]
  lab?: PluginLab
}

/** A discovered external plug-in (manifest view). */
export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  source?: string
  license?: string
  isolation: string
  gpu: boolean
  vram_mb?: number | null
  supports_low_vram: boolean
  supports_cpu_offload: boolean
  capabilities: string[]
  needs?: Record<string, unknown>
  ui?: PluginUI
  installed: boolean
  running?: boolean
  /** Whether the plug-in's gated HF model is downloaded locally. `null` when the
   * plug-in declares no model; `false` drives the gated-model help note. */
  model_present?: boolean | null
}

export interface PluginGenerateBody {
  fields: Record<string, unknown>
  reprompt?: boolean
  provider_id?: string | null
  save?: boolean
  save_path?: string | null
  session_id?: string | null
  library?: 'voice' | 'sound'
  /** Optional input-audio guidance handle the host resolves to a local path for
   * the sidecar: "sound:<id>" (a library sound) or "temp:<name>" (an upload
   * staged via uploadPluginRef). Used by music generators (e.g. ACE-Step). */
  reference_audio?: string | null
}

export type SpeakerMode = 'clone' | 'design' | 'auto'

export interface SpeakerConfig {
  mode: SpeakerMode
  voice?: string | null
  ref_text?: string | null
  instruct?: string | null
  language?: string | null
  isolate: boolean
  normalize: boolean
  dereverb?: boolean
  dereverb_method?: 'roformer' | 'deepfilternet'
}

export interface GenParams {
  num_step: number
  guidance_scale: number
  speed: number
  duration?: number | null
  denoise: boolean
  t_shift: number
  preprocess_prompt: boolean
  postprocess_output: boolean
  gap_ms: number
  match_loudness?: boolean
  target_lufs?: number
  peak_ceiling_db?: number
}

export interface Job {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: { stage?: string; line?: number; total?: number; text?: string; message?: string; speaker?: string }
  result:
    | {
        title?: string
        audio_url?: string
        filename?: string
        duration_s?: number
        session?: MultitrackSession
        session_id?: string
        regenerated_index?: number
        inserted_index?: number
        channel_regen?: string
        bulk_sliced?: number
        // Plug-in (Stable Audio 3) generation results.
        plugin?: string
        category?: string
        prompt?: string
        raw_prompt?: string
        reprompted?: boolean
        sample_rate?: number
        sound?: Sound
        temp?: string
      }
    | null
  error: string | null
  meta: { title?: string; multitrack?: boolean; regen?: number; channel_regen?: string; bulk_slice?: boolean }
}

/** Render-time vocal transforms applied to the take before the V2V transfer.
 * pitch/formant in semitones; the rest are 0..1 weights (+ optional rates). */
export interface VocalTransform {
  pitch: number
  formant: number
  sub: number
  drive: number
  ringmod: number
  ringmod_hz: number
  vibrato: number
  vibrato_hz: number
  /** Tremolo — amplitude LFO (throb/helicopter). Depth 0..1, rate Hz. */
  tremolo: number
  tremolo_hz: number
  /** Gate / chop — rhythmic on-off stutter. Depth 0..1, rate Hz. */
  gate: number
  gate_hz: number
  /** Chorus — short modulated delay (shimmer/whoosh). 0..1, rate Hz. */
  chorus: number
  chorus_hz: number
  /** Muffle / distance — low-pass (behind a door / far away). 0..1. */
  muffle: number
  /** Echo / delay (slap-back → alley-wall bounce). Wet 0..1. */
  echo: number
  /** Echo delay time in ms. */
  echo_ms: number
  /** Echo feedback — repeats / decay length. 0..0.92. */
  echo_feedback: number
  /** Reverb (room/hall/cave space). Wet 0..1. */
  reverb: number
  /** Reverb size — decay length. 0..1. */
  reverb_size: number
  /** "Bad telephone call" lo-fi: band-limit + sample-rate/bit crush. 0..1. */
  telephone: number
  /** Crackle / line-noise riding on top of the telephone effect. 0..1. */
  tel_crackle: number
}

export const DEFAULT_TRANSFORM: VocalTransform = {
  pitch: 0,
  formant: 0,
  sub: 0,
  drive: 0,
  ringmod: 0,
  ringmod_hz: 80,
  vibrato: 0,
  vibrato_hz: 5,
  tremolo: 0,
  tremolo_hz: 6,
  gate: 0,
  gate_hz: 8,
  chorus: 0,
  chorus_hz: 1.5,
  muffle: 0,
  echo: 0,
  echo_ms: 180,
  echo_feedback: 0.35,
  reverb: 0,
  reverb_size: 0.5,
  telephone: 0,
  tel_crackle: 0,
}

/** Everything that defines a take's render — shared by the ADR Studio
 * performance modal and the Voice Clone tab so the two stay in lockstep. */
export interface PerfParams {
  gain_db: number
  speed: number
  mode: 'character' | 'voice'
  strength: number
  text?: string
  transforms?: VocalTransform | null
  /** Transparent take→target f0 match applied at render (no UI knob). */
  auto_pitch?: boolean
  /** Input-cleanup toggles, persisted so re-editing restores the same state. */
  clean_isolate?: boolean
  clean_dereverb?: boolean
}

export interface PerformInfo {
  mode: 'character' | 'voice'
  strength: number
  gain_db: number
  speed: number
  transforms?: VocalTransform | null
  auto_pitch?: boolean
  /** Input-cleanup toggles used when the take was captured, so re-editing the
   * performance restores the same checkbox state. */
  clean_isolate?: boolean
  clean_dereverb?: boolean
  dirty: boolean
  url: string
}

export interface MultitrackSegment {
  index: number
  speaker_id: string
  text: string
  start_s: number
  duration_s: number
  raw_duration_s: number
  trim_start_s: number
  trim_end_s: number
  speed: number
  gain_db: number
  fade_in_s: number
  fade_out_s: number
  /** Audio-content revision (file mtime) — stable cache key for waveform peaks. */
  rev: number
  inpaint?: boolean
  has_bed?: boolean
  preserve_nonvocal?: boolean
  /** Baked-in per-segment vocal transforms (null = clip is original). */
  fx?: Partial<VocalTransform> | null
  perform?: PerformInfo | null
  /** Audio provenance: "foley" (plug-in generated) vs "upload" (static file);
   * null/undefined for generated-voice clips. Drives the timeline colour. */
  kind?: string | null
  /** Open metadata bag — first-party + plug-in segment data (e.g. a foley clip's
   * origin plug-in, prompt and generation fields for re-rolling). */
  meta?: SegmentMeta | null
  url: string
  clip_url: string
}

/** Per-segment metadata. `plugin`/`category`/`prompt`/`fields` describe a foley
 * clip's origin so it can be re-rolled; plug-ins may stash arbitrary extra keys. */
export interface SegmentMeta {
  plugin?: string
  category?: string
  prompt?: string
  fields?: Record<string, unknown>
  reprompt?: boolean
  provider_id?: string | null
  [k: string]: unknown
}

/** Non-generative segment edits, including dialogue/provenance/metadata. */
export interface SegmentEdit {
  start_s?: number
  trim_start_s?: number
  trim_end_s?: number
  speed?: number
  gain_db?: number
  fade_in_s?: number
  fade_out_s?: number
  text?: string
  kind?: string
  meta?: SegmentMeta
}

export interface MultitrackTrack {
  speaker_id: string
  name: string
  voice_name?: string
  /** Library voice id (relative path) for clone-mode tracks — used to auto
   * pitch-match a take to this voice. Null for auto/design/audio channels. */
  voice?: string | null
  custom_name?: string | null
  gain_db?: number
  muted?: boolean
  kind?: string
  mode: string
  /** Full clone/design config (null for audio channels) — lets re-opening a
   * project rehydrate the speaker form's reference-voice selector + toggles. */
  config?: SpeakerConfig | null
  segments: MultitrackSegment[]
}

export interface MultitrackSession {
  id: string
  title: string
  created?: string
  sample_rate: number
  gap_ms: number
  total_duration_s: number
  mix_url: string
  tracks: MultitrackTrack[]
  segment_count: number
  can_undo?: boolean
  can_redo?: boolean
}

/** A saved project (multitrack session) as shown in the Projects pillar. */
export interface Project {
  id: string
  title: string
  created?: string
  updated?: number
  timestamp?: number
  total_duration_s: number
  segment_count: number
  track_count: number
  /** Generative (voice) tracks only — excludes uploaded audio channels. */
  voice_count?: number
  speaker_names: string[]
  mix_url: string
  last_opened?: number
}

/** One labeled, navigable step in a project's action history. */
export interface HistoryStep {
  id: string
  label: string
  ts?: number
  index: number
}

export interface HistoryState {
  steps: HistoryStep[]
  cursor: number
  can_undo: boolean
  can_redo: boolean
}

/** A bundled voice the importer can offer to add to the library. */
export interface ImportableVoice {
  track: string
  file: string
  name: string
  folder: string
  preview_url: string
}

export interface ImportReport {
  voices: ImportableVoice[]
}

export interface ImportResult {
  session: MultitrackSession
  import_report: ImportReport
}

/** Asset inventory for a project (the ⓘ details popover). */
export interface ProjectAssets {
  id: string
  voices: { track: string; name: string; voice: string | null; in_library: boolean; bundled: boolean }[]
  uploads: { track: string; name: string; duration_s: number; bundled: boolean }[]
  plugins: { plugin: string; keys: string[] | null }[]
}

export interface HistoryEntry {
  id: string
  type: 'script' | 'generation'
  title: string
  created: string
  prompt?: string
  script?: string
  multi_speaker?: boolean
  num_speakers?: number
  speakers?: Record<string, SpeakerConfig>
  params?: GenParams
  model?: string
  filename?: string
  audio_url?: string
}

export interface OutputFile {
  filename: string
  audio_url: string
  size_kb: number
  modified: string
}

export interface Provider {
  id: string
  label: string
  model: string
  endpoint: string // openai | gemini | custom
  has_key: boolean
}

export interface ProvidersResponse {
  providers: Provider[]
  active: string | null
}

async function jfetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail || JSON.stringify(body)
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

/** Download a server file (honoring its Content-Disposition filename) without
 * tripping the app's beforeunload "leave site?" guard. Fetches to a blob and
 * clicks an anchor at the blob URL instead of navigating. Used by the library
 * row download buttons (which hit the format-aware /download endpoints). */
export async function downloadFile(url: string, fallbackName = 'audio') {
  const res = await fetch(url)
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Download failed')
  const cd = res.headers.get('Content-Disposition') || ''
  const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd)
  const name = m ? decodeURIComponent(m[1]) : fallbackName
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export const api = {
  systemInfo: () => jfetch<SystemInfo>('/api/system/info'),
  loadModel: (model_id?: string, load_on_demand?: boolean) =>
    jfetch<SystemInfo>('/api/system/load', { method: 'POST', body: JSON.stringify({ model_id, load_on_demand }) }),
  unloadModel: () => jfetch<SystemInfo>('/api/system/unload', { method: 'POST' }),
  setLod: (enabled: boolean) =>
    jfetch<SystemInfo>('/api/system/lod', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setLowVram: (enabled: boolean) =>
    jfetch<SystemInfo>('/api/system/low-vram', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setTrimSilence: (enabled: boolean) =>
    jfetch<SystemInfo>('/api/system/trim-silence', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setAutoSlice: (enabled: boolean) =>
    jfetch<SystemInfo>('/api/system/auto-slice', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setOutputFormat: (format: string) =>
    jfetch<SystemInfo>('/api/system/output-format', { method: 'POST', body: JSON.stringify({ format }) }),
  getPrefs: () => jfetch<Record<string, unknown>>('/api/prefs'),
  patchPrefs: (patch: Record<string, unknown>) =>
    jfetch<Record<string, unknown>>('/api/prefs', { method: 'PATCH', body: JSON.stringify(patch) }),

  voices: () => jfetch<{ tree: VoiceNode; flat: Voice[]; folders: string[] }>('/api/voices'),
  deleteVoice: (id: string) => jfetch<{ ok: boolean }>(`/api/voices/${id}`, { method: 'DELETE' }),
  createVoiceFolder: (path: string) =>
    jfetch<{ folder: string }>('/api/voices/folder', { method: 'POST', body: JSON.stringify({ path }) }),
  moveVoice: (id: string, folder: string) =>
    jfetch<{ id: string; name: string; folder: string; filename: string }>('/api/voices/move', {
      method: 'POST',
      body: JSON.stringify({ id, folder }),
    }),
  renameVoice: (id: string, name: string) =>
    jfetch<{ id: string; name: string; folder: string; filename: string }>('/api/voices/rename', {
      method: 'POST',
      body: JSON.stringify({ id, name }),
    }),
  async uploadVoice(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/voices/upload', { method: 'POST', body: fd })
    if (!res.ok) throw new Error('Upload failed')
    return res.json() as Promise<{ upload_id: string; duration_s: number; audio_url: string }>
  },
  previewVoice: (body: ProcessVoiceBody) =>
    jfetch<{ audio_url: string; duration_s: number }>('/api/voices/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  processVoice: (body: ProcessVoiceBody) =>
    jfetch<{ id: string; name: string; duration_s: number }>('/api/voices/process', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Save a staged/generated temp preview into the voice library (deferred save —
  // the voice-side twin of importTempSound).
  importTempVoice: (temp: string, path: string) =>
    jfetch<Voice>('/api/voices/import-temp', { method: 'POST', body: JSON.stringify({ temp, path }) }),

  /** Transcode a WAV blob to the configured export format (mp3/flac) server-side
   * and return the encoded bytes + suggested filename (honors output_format). */
  async encodeAudio(blob: Blob, name: string) {
    const fd = new FormData()
    fd.append('file', blob, `${name}.wav`)
    fd.append('name', name)
    const res = await fetch('/api/audio/encode', { method: 'POST', body: fd })
    if (!res.ok) throw new Error('Encode failed')
    const cd = res.headers.get('Content-Disposition') || ''
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd)
    return { blob: await res.blob(), filename: m ? decodeURIComponent(m[1]) : `${name}.wav` }
  },

  // ---- Sound library (foley / SFX) ----
  sounds: () => jfetch<{ tree: SoundNode; flat: Sound[]; folders: string[] }>('/api/sounds'),
  deleteSound: (id: string) => jfetch<{ ok: boolean }>(`/api/sounds/${id}`, { method: 'DELETE' }),
  createSoundFolder: (folder: string) =>
    jfetch<{ folder: string }>('/api/sounds/folder', { method: 'POST', body: JSON.stringify({ folder }) }),
  moveSound: (id: string, folder: string) =>
    jfetch<Sound>('/api/sounds/move', { method: 'POST', body: JSON.stringify({ id, folder }) }),
  renameSound: (id: string, name: string) =>
    jfetch<Sound>('/api/sounds/rename', { method: 'POST', body: JSON.stringify({ id, name }) }),
  transformSound: (body: SoundTransformBody) =>
    jfetch<Sound & { duration_s?: number }>('/api/sounds/transform', { method: 'POST', body: JSON.stringify(body) }),
  previewSound: (body: SoundTransformBody) =>
    jfetch<{ audio_url: string; duration_s: number }>('/api/sounds/preview', { method: 'POST', body: JSON.stringify(body) }),
  async uploadSound(file: File, folder = '') {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('folder', folder)
    const res = await fetch('/api/sounds/upload', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Upload failed')
    return res.json() as Promise<Sound>
  },
  /** Save a generated temp preview into the library (deferred save). */
  importTempSound: (temp: string, path: string) =>
    jfetch<Sound>('/api/sounds/import-temp', { method: 'POST', body: JSON.stringify({ temp, path }) }),

  // ---- Library metadata + analysis (Essentia service plug-in) ----
  soundMeta: (id: string) => jfetch<SampleMeta>(`/api/sounds/${id}/meta`),
  setSoundMeta: (id: string, manual: Record<string, unknown>) =>
    jfetch<SampleMeta>(`/api/sounds/${id}/meta`, { method: 'POST', body: JSON.stringify({ manual }) }),
  analyzeSound: (id: string) => jfetch<SampleMeta>(`/api/sounds/${id}/analyze`, { method: 'POST' }),
  scanSounds: () => jfetch<{ queued: number }>('/api/sounds/scan', { method: 'POST', body: '{}' }),
  voiceMeta: (id: string) => jfetch<SampleMeta>(`/api/voices/${id}/meta`),
  setVoiceMeta: (id: string, manual: Record<string, unknown>) =>
    jfetch<SampleMeta>(`/api/voices/${id}/meta`, { method: 'POST', body: JSON.stringify({ manual }) }),

  // ---- Plug-ins (external, isolated) ----
  plugins: () => jfetch<{ plugins: Plugin[] }>('/api/plugins'),
  pluginInfo: (id: string) => jfetch<Plugin>(`/api/plugins/${id}`),
  pluginUnload: (id: string) => jfetch<{ ok: boolean }>(`/api/plugins/${id}/unload`, { method: 'POST' }),
  pluginHealth: (id: string) => jfetch<Record<string, unknown>>(`/api/plugins/${id}/health`, { method: 'POST' }),
  /** Run an arbitrary plug-in command as a background job (advanced plug-ins),
   * e.g. ACE-Step's `write_lyrics` SongCraft helper. Returns {job_id}; poll via
   * `job(id)` and read the command's return value off `job.result`. */
  pluginInvoke: (id: string, cmd: string, payload: Record<string, unknown> = {}) =>
    jfetch<{ job_id: string }>(`/api/plugins/${id}/invoke`, {
      method: 'POST',
      body: JSON.stringify({ cmd, payload }),
    }),
  /** Generic audio-generator job for any plug-in (schema-driven `fields`). */
  pluginGenerate: (id: string, body: PluginGenerateBody) =>
    jfetch<{ job_id: string }>(`/api/plugins/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Stage an uploaded audio file as a transient *reference* for a plug-in
   * generate (input-audio guidance). Returns an opaque handle to pass as
   * `reference_audio`, plus a temp URL for previewing the clip. Does NOT add the
   * file to any library. */
  async uploadPluginRef(file: File) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/plugins/ref-upload', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Upload failed')
    return res.json() as Promise<{ handle: string; audio_url: string; name: string }>
  },

  script: (body: ScriptBody) =>
    jfetch<{ title: string; script: string; model: string; num_speakers: number }>('/api/script', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  scriptProviders: () => jfetch<ProvidersResponse>('/api/script/providers'),
  selectProvider: (id: string) =>
    jfetch<ProvidersResponse>('/api/script/providers/select', { method: 'POST', body: JSON.stringify({ id }) }),
  reloadProviders: () => jfetch<ProvidersResponse>('/api/script/reload', { method: 'POST' }),

  generate: (body: GenerateBody) =>
    jfetch<{ job_id: string }>('/api/generate', { method: 'POST', body: JSON.stringify(body) }),
  async generatePerform(
    body: GenerateBody,
    take: Blob,
    perf: { mode: 'character' | 'voice'; strength: number; gain_db: number; speed: number; transforms?: VocalTransform | null; auto_pitch?: boolean },
  ): Promise<{ job_id: string }> {
    const fd = new FormData()
    fd.append('file', take, 'take.wav')
    fd.append('payload', JSON.stringify({ ...body, perform: perf }))
    const res = await fetch('/api/generate-perform', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Generation failed')
    return res.json()
  },
  job: (id: string) => jfetch<Job>(`/api/jobs/${id}`),

  multitrackGenerate: (body: GenerateBody) =>
    jfetch<{ job_id: string }>('/api/multitrack/generate', { method: 'POST', body: JSON.stringify(body) }),
  multitrackGet: (sid: string) => jfetch<MultitrackSession>(`/api/multitrack/${sid}`),
  regenSegment: (sid: string, index: number, text?: string, plain?: boolean) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/segment/${index}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ text: text ?? null, plain: plain ?? false }),
    }),
  /** Re-roll a foley clip in place via its origin plug-in (current prompt + length). */
  regenFoley: (sid: string, index: number) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/segment/${index}/regenerate-foley`, {
      method: 'POST',
    }),
  editSegment: (
    sid: string,
    index: number,
    fields: SegmentEdit,
  ) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/edit`, {
      method: 'POST',
      body: JSON.stringify(fields),
    }),
  moveSegment: (sid: string, index: number, speaker_id: string, start_s?: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/move`, {
      method: 'POST',
      body: JSON.stringify({ speaker_id, start_s }),
    }),
  reorderTracks: (sid: string, order: string[]) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/track-order`, {
      method: 'POST',
      body: JSON.stringify({ order }),
    }),
  segmentPeaks: (sid: string, index: number, n = 800) =>
    jfetch<{ index: number; peaks: number[]; raw_duration_s: number }>(
      `/api/multitrack/${sid}/segment/${index}/peaks?n=${n}`,
    ),
  reflowSession: (sid: string, fields: { gap_ms?: number; speed?: number }) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/reflow`, { method: 'POST', body: JSON.stringify(fields) }),
  insertSegment: (sid: string, body: { speaker_id: string; text: string; start_s: number; ripple: boolean }) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/insert`, { method: 'POST', body: JSON.stringify(body) }),
  multitrackEmpty: (body: { title?: string; speakers: Record<string, SpeakerConfig>; params: GenParams }) =>
    jfetch<MultitrackSession>('/api/multitrack/empty', { method: 'POST', body: JSON.stringify(body) }),
  importClip: (sid: string, body: { filename: string; speaker_id: string; text?: string; start_s?: number }) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/import-clip`, { method: 'POST', body: JSON.stringify(body) }),
  discardSession: (sid: string) => jfetch<{ ok: boolean }>(`/api/multitrack/${sid}`, { method: 'DELETE' }),
  addSpeaker: (sid: string, cfg: SpeakerConfig) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker`, { method: 'POST', body: JSON.stringify(cfg) }),
  addAudioTrack: (sid: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/audio-track`, { method: 'POST' }),
  updateSpeaker: (sid: string, pos: string, cfg: SpeakerConfig) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker/${pos}`, { method: 'POST', body: JSON.stringify(cfg) }),
  removeSpeaker: (sid: string, pos: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker/${pos}`, { method: 'DELETE' }),
  deleteSegment: (sid: string, index: number, ripple: boolean) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/delete`, { method: 'POST', body: JSON.stringify({ ripple }) }),
  splitSegment: (sid: string, index: number, at_s: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/split`, { method: 'POST', body: JSON.stringify({ at_s }) }),
  deleteSpace: (sid: string, start_s: number, amount: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/delete-space`, { method: 'POST', body: JSON.stringify({ start_s, amount }) }),
  addSpace: (sid: string, start_s: number, amount: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/add-space`, { method: 'POST', body: JSON.stringify({ start_s, amount }) }),
  duplicateSegment: (sid: string, index: number, start_s: number, ripple: boolean, speaker_id?: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/duplicate`, { method: 'POST', body: JSON.stringify({ start_s, ripple, speaker_id }) }),
  transcribeSegment: (sid: string, index: number, draft?: { trim_start_s?: number; trim_end_s?: number; speed?: number }) =>
    jfetch<{ text: string }>(`/api/multitrack/${sid}/segment/${index}/transcribe`, { method: 'POST', body: JSON.stringify(draft || {}) }),
  setSegmentText: (sid: string, index: number, text: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/text`, { method: 'POST', body: JSON.stringify({ text }) }),
  autoSlice: (sid: string, index: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/auto-slice`, { method: 'POST' }),
  bulkSlice: (sid: string) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/bulk-slice`, { method: 'POST' }),
  setInpaint: (sid: string, index: number, enabled: boolean) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/inpaint`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  setPreserveNonvocal: (sid: string, index: number, enabled: boolean) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/inpaint-preserve`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  promoteChannel: (sid: string, pos: string, name: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker/${pos}/promote`, { method: 'POST', body: JSON.stringify({ name }) }),
  undo: (sid: string) => jfetch<MultitrackSession>(`/api/multitrack/${sid}/undo`, { method: 'POST' }),
  redo: (sid: string) => jfetch<MultitrackSession>(`/api/multitrack/${sid}/redo`, { method: 'POST' }),
  historyState: (sid: string) => jfetch<HistoryState>(`/api/multitrack/${sid}/history`),
  historyJump: (sid: string, index: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/history/jump`, { method: 'POST', body: JSON.stringify({ index }) }),
  setChannel: (sid: string, pos: string, fields: { name?: string | null; gain_db?: number; muted?: boolean }) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker/${pos}/channel`, { method: 'POST', body: JSON.stringify(fields) }),
  mergeSegments: (sid: string, indices: number[]) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/merge`, { method: 'POST', body: JSON.stringify({ indices }) }),
  collapseTrack: (sid: string, pos: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker/${pos}/collapse`, { method: 'POST' }),
  regenChannel: (sid: string, pos: string) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/speaker/${pos}/regenerate`, { method: 'POST' }),
  async setPerformance(
    sid: string,
    index: number,
    wav: Blob | null,
    params: PerfParams,
  ): Promise<MultitrackSession> {
    const fd = new FormData()
    if (wav) fd.append('file', wav, 'performance.wav')
    fd.append('gain_db', String(params.gain_db))
    fd.append('speed', String(params.speed))
    fd.append('mode', params.mode)
    fd.append('strength', String(params.strength))
    if (params.text) fd.append('text', params.text)
    if (params.transforms) fd.append('transforms', JSON.stringify(params.transforms))
    fd.append('auto_pitch', String(!!params.auto_pitch))
    fd.append('clean_isolate', String(!!params.clean_isolate))
    fd.append('clean_dereverb', String(!!params.clean_dereverb))
    const res = await fetch(`/api/multitrack/${sid}/segment/${index}/performance`, { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Save failed')
    return res.json()
  },
  async transformClip(
    clip: Blob,
    transforms: VocalTransform | null,
    opts?: { autoPitch?: boolean; voice?: string | null },
  ): Promise<Blob> {
    const fd = new FormData()
    fd.append('file', clip, 'clip.wav')
    if (transforms) fd.append('transforms', JSON.stringify(transforms))
    fd.append('auto_pitch', String(!!opts?.autoPitch))
    if (opts?.voice) fd.append('voice', opts.voice)
    const res = await fetch('/api/perform/transform-clip', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Transform failed')
    return res.blob()
  },
  /** Bake creative vocal transforms onto an existing multitrack segment's audio
   * (reversible — a no-op transform restores the clip's original). Returns the
   * refreshed session. Covered by single-step undo server-side. */
  async applySegmentTransform(
    sid: string,
    index: number,
    transforms: VocalTransform,
  ): Promise<MultitrackSession> {
    const res = await fetch(`/api/multitrack/${sid}/segment/${index}/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transforms }),
    })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Transform failed')
    return res.json()
  },
  async isolateSegment(
    sid: string,
    index: number,
    stem: 'vocals' | 'instrumental',
  ): Promise<MultitrackSession> {
    const res = await fetch(`/api/multitrack/${sid}/segment/${index}/isolate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stem }),
    })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Isolation failed')
    return res.json()
  },
  async transformOutputFile(
    clip: Blob,
    transforms: VocalTransform | null,
    title = 'transformed',
  ): Promise<{ filename: string; audio_url: string; duration_s: number }> {
    const fd = new FormData()
    fd.append('file', clip, 'clip.wav')
    if (transforms) fd.append('transforms', JSON.stringify(transforms))
    fd.append('persist', 'true')
    fd.append('title', title)
    const res = await fetch('/api/perform/transform-clip', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Transform failed')
    return res.json()
  },
  async stampOutput(
    clip: Blob,
    opts: { trimStart?: number; trimEnd?: number; speed?: number; title?: string },
  ): Promise<{ filename: string; audio_url: string; duration_s: number }> {
    const fd = new FormData()
    fd.append('file', clip, 'clip.wav')
    fd.append('trim_start', String(opts.trimStart ?? 0))
    fd.append('trim_end', String(opts.trimEnd ?? 0))
    fd.append('speed', String(opts.speed ?? 1))
    fd.append('title', opts.title ?? 'clone')
    const res = await fetch('/api/perform/stamp-output', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Stamp failed')
    return res.json()
  },
  async pitchMatch(take: Blob, voice: string): Promise<{ semitones: number; take_hz: number; target_hz: number }> {
    const fd = new FormData()
    fd.append('file', take, 'take.wav')
    fd.append('voice', voice)
    const res = await fetch('/api/perform/pitch-match', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Pitch-match failed')
    return res.json()
  },
  clearPerformance: (sid: string, index: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/performance`, { method: 'DELETE' }),
  async processClip(
    wav: Blob,
    opts: { isolate: boolean; dereverb: boolean; dereverb_method?: string; trim?: boolean },
  ): Promise<Blob> {
    const fd = new FormData()
    fd.append('file', wav, 'clip.wav')
    fd.append('isolate', String(opts.isolate))
    fd.append('dereverb', String(opts.dereverb))
    fd.append('dereverb_method', opts.dereverb_method || 'roformer')
    fd.append('trim', String(!!opts.trim))
    const res = await fetch('/api/process-clip', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Processing failed')
    return res.blob()
  },
  async transcribeClip(wav: Blob): Promise<string> {
    const fd = new FormData()
    fd.append('file', wav, 'clip.wav')
    const res = await fetch('/api/transcribe-clip', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Transcription failed')
    return ((await res.json()).text || '').trim()
  },
  async uploadChannel(sid: string, file: File, name: string, startS = 0): Promise<MultitrackSession> {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('name', name)
    fd.append('start_s', String(startS))
    const res = await fetch(`/api/multitrack/${sid}/upload-channel`, { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Upload failed')
    return res.json()
  },
  async uploadAudioSegment(sid: string, pos: string, file: File, startS = 0, ripple = false): Promise<MultitrackSession> {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('start_s', String(startS))
    fd.append('ripple', String(ripple))
    const res = await fetch(`/api/multitrack/${sid}/channel/${pos}/upload-segment`, { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Upload failed')
    return res.json()
  },
  finalizeSession: (sid: string) =>
    jfetch<{ title?: string; filename: string; audio_url: string; duration_s: number }>(
      `/api/multitrack/${sid}/finalize`,
      { method: 'POST' },
    ),

  history: (kind?: string) =>
    jfetch<{ entries: HistoryEntry[] }>(`/api/history${kind ? `?kind=${kind}` : ''}`),
  deleteHistory: (id: string) => jfetch<{ ok: boolean }>(`/api/history/${id}`, { method: 'DELETE' }),
  clearHistory: (kind?: string) =>
    jfetch<{ ok: boolean }>('/api/history/clear', { method: 'POST', body: JSON.stringify({ kind }) }),

  outputs: () => jfetch<{ outputs: OutputFile[] }>('/api/outputs'),
  deleteOutput: (filename: string) =>
    jfetch<{ ok: boolean }>(`/api/outputs/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
  renameOutput: (filename: string, name: string) =>
    jfetch<OutputFile>(`/api/outputs/${encodeURIComponent(filename)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  // ---- Projects (browseable, restorable sessions) ----
  projects: () => jfetch<{ projects: Project[] }>('/api/projects'),
  openProject: (sid: string) => jfetch<MultitrackSession>(`/api/multitrack/${sid}/open`, { method: 'POST' }),
  /** Fork a project into an independent "Copy of …" (in-app, no export/import). */
  duplicateProject: (sid: string) => jfetch<MultitrackSession>(`/api/multitrack/${sid}/duplicate`, { method: 'POST' }),
  renameProject: (sid: string, title: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/rename`, { method: 'POST', body: JSON.stringify({ title }) }),
  /** Download URLs for the project bundle + DAW stems (anchor href / window.open). */
  bundleUrl: (sid: string) => `/api/multitrack/${sid}/export`,
  stemsUrl: (sid: string) => `/api/multitrack/${sid}/export-stems`,
  async importProject(file: File): Promise<ImportResult> {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/projects/import', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || 'Import failed')
    return res.json()
  },
  /** Import selected bundled voices into the library and relink the project. */
  importVoices: (sid: string, imports: { track: string; file: string; name: string; folder: string }[]) =>
    jfetch<MultitrackSession>(`/api/projects/${sid}/import-voices`, {
      method: 'POST',
      body: JSON.stringify({ imports }),
    }),
  /** Asset inventory (voices / uploads / plug-in data) for the details popover. */
  projectAssets: (sid: string) => jfetch<ProjectAssets>(`/api/multitrack/${sid}/assets`),
  /** Hook for 3rd-party plug-ins to persist state with a scene. */
  setPluginData: (sid: string, plugin: string, data: unknown, merge = true) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/plugin-data`, {
      method: 'POST',
      body: JSON.stringify({ plugin, data, merge }),
    }),
}

export interface ProcessVoiceBody {
  source: string
  is_upload: boolean
  isolate: boolean
  normalize: boolean
  trim: boolean
  dereverb?: boolean
  dereverb_method?: 'roformer' | 'deepfilternet'
  gain_db: number
  speed?: number
  trim_start?: number
  trim_end?: number
  overwrite?: boolean
  save_as: string
  transforms?: VocalTransform
}

export interface SoundTransformBody {
  id: string
  transforms: VocalTransform
  isolate?: boolean
  trim?: boolean
  normalize?: boolean
  dereverb?: boolean
  dereverb_method?: 'roformer' | 'deepfilternet'
  gain_db?: number
  speed?: number
  trim_start?: number
  trim_end?: number
  overwrite?: boolean
  save_as?: string
}

export interface ScriptBody {
  prompt: string
  num_speakers: number
  speakers?: { name?: string; instruct?: string; voice?: string }[]
  existing_script?: string
  previous?: { prompt?: string; script?: string }
  provider_id?: string
  /** Voice Clone tab only: write an unlabelled monologue. ADR Studio omits this
   * (or sends false) so scripts are always "Speaker N:" labelled. */
  monologue?: boolean
}

export interface GenerateBody {
  text?: string | null
  script?: string | null
  multi_speaker: boolean
  num_speakers: number
  speakers: Record<string, SpeakerConfig>
  params: GenParams
  title?: string
  prompt?: string
  save: boolean
}
