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
      }
    | null
  error: string | null
  meta: { title?: string; multitrack?: boolean; regen?: number; channel_regen?: string }
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
  inpaint?: boolean
  has_bed?: boolean
  preserve_nonvocal?: boolean
  url: string
  clip_url: string
}

export interface MultitrackTrack {
  speaker_id: string
  name: string
  voice_name?: string
  custom_name?: string | null
  gain_db?: number
  kind?: string
  mode: string
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

export const api = {
  systemInfo: () => jfetch<SystemInfo>('/api/system/info'),
  loadModel: (model_id?: string, load_on_demand?: boolean) =>
    jfetch<SystemInfo>('/api/system/load', { method: 'POST', body: JSON.stringify({ model_id, load_on_demand }) }),
  unloadModel: () => jfetch<SystemInfo>('/api/system/unload', { method: 'POST' }),
  setLod: (enabled: boolean) =>
    jfetch<SystemInfo>('/api/system/lod', { method: 'POST', body: JSON.stringify({ enabled }) }),
  setLowVram: (enabled: boolean) =>
    jfetch<SystemInfo>('/api/system/low-vram', { method: 'POST', body: JSON.stringify({ enabled }) }),

  voices: () => jfetch<{ tree: VoiceNode; flat: Voice[] }>('/api/voices'),
  deleteVoice: (id: string) => jfetch<{ ok: boolean }>(`/api/voices/${id}`, { method: 'DELETE' }),
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
  job: (id: string) => jfetch<Job>(`/api/jobs/${id}`),

  multitrackGenerate: (body: GenerateBody) =>
    jfetch<{ job_id: string }>('/api/multitrack/generate', { method: 'POST', body: JSON.stringify(body) }),
  multitrackGet: (sid: string) => jfetch<MultitrackSession>(`/api/multitrack/${sid}`),
  regenSegment: (sid: string, index: number, text?: string) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/segment/${index}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ text: text ?? null }),
    }),
  editSegment: (
    sid: string,
    index: number,
    fields: { start_s?: number; trim_start_s?: number; trim_end_s?: number; speed?: number },
  ) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/edit`, {
      method: 'POST',
      body: JSON.stringify(fields),
    }),
  reflowSession: (sid: string, fields: { gap_ms?: number; speed?: number }) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/reflow`, { method: 'POST', body: JSON.stringify(fields) }),
  insertSegment: (sid: string, body: { speaker_id: string; text: string; start_s: number; ripple: boolean }) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/insert`, { method: 'POST', body: JSON.stringify(body) }),
  multitrackEmpty: (body: { title?: string; speakers: Record<string, SpeakerConfig>; params: GenParams }) =>
    jfetch<MultitrackSession>('/api/multitrack/empty', { method: 'POST', body: JSON.stringify(body) }),
  discardSession: (sid: string) => jfetch<{ ok: boolean }>(`/api/multitrack/${sid}`, { method: 'DELETE' }),
  addSpeaker: (sid: string, cfg: SpeakerConfig) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker`, { method: 'POST', body: JSON.stringify(cfg) }),
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
  duplicateSegment: (sid: string, index: number, start_s: number, ripple: boolean) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/duplicate`, { method: 'POST', body: JSON.stringify({ start_s, ripple }) }),
  transcribeSegment: (sid: string, index: number, draft?: { trim_start_s?: number; trim_end_s?: number; speed?: number }) =>
    jfetch<{ text: string }>(`/api/multitrack/${sid}/segment/${index}/transcribe`, { method: 'POST', body: JSON.stringify(draft || {}) }),
  setSegmentText: (sid: string, index: number, text: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/text`, { method: 'POST', body: JSON.stringify({ text }) }),
  autoSlice: (sid: string, index: number) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/auto-slice`, { method: 'POST' }),
  setInpaint: (sid: string, index: number, enabled: boolean) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/inpaint`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  setPreserveNonvocal: (sid: string, index: number, enabled: boolean) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/segment/${index}/inpaint-preserve`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  promoteChannel: (sid: string, pos: string, name: string) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker/${pos}/promote`, { method: 'POST', body: JSON.stringify({ name }) }),
  undo: (sid: string) => jfetch<MultitrackSession>(`/api/multitrack/${sid}/undo`, { method: 'POST' }),
  setChannel: (sid: string, pos: string, fields: { name?: string | null; gain_db?: number }) =>
    jfetch<MultitrackSession>(`/api/multitrack/${sid}/speaker/${pos}/channel`, { method: 'POST', body: JSON.stringify(fields) }),
  regenChannel: (sid: string, pos: string) =>
    jfetch<{ job_id: string }>(`/api/multitrack/${sid}/speaker/${pos}/regenerate`, { method: 'POST' }),
  async uploadChannel(sid: string, file: File, name: string): Promise<MultitrackSession> {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('name', name)
    const res = await fetch(`/api/multitrack/${sid}/upload-channel`, { method: 'POST', body: fd })
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
  trim_start?: number
  trim_end?: number
  overwrite?: boolean
  save_as: string
}

export interface ScriptBody {
  prompt: string
  num_speakers: number
  speakers?: { name?: string; instruct?: string; voice?: string }[]
  existing_script?: string
  previous?: { prompt?: string; script?: string }
  provider_id?: string
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
