import type { MultitrackSession, SpeakerConfig } from './api'
import type { Injected } from './components/Studio'

/** Rebuild the Studio's speaker form + script from a loaded multitrack session,
 * so re-opening (or importing) a project rehydrates the reference-voice selector
 * and per-speaker toggles instead of leaving the previous scene's roster behind.
 * Projects are multitrack scenes, so this always restores into multi-speaker. */
export function injectedFromSession(s: MultitrackSession): Injected {
  const gen = s.tracks.filter((t) => t.kind !== 'audio')
  const speakers: Record<string, SpeakerConfig> = {}
  gen.forEach((t, i) => {
    const c = t.config
    speakers[String(i + 1)] = {
      mode: ((c?.mode ?? t.mode) as SpeakerConfig['mode']) || 'clone',
      voice: c?.voice ?? t.voice ?? null,
      ref_text: c?.ref_text ?? null,
      instruct: c?.instruct ?? null,
      language: c?.language ?? null,
      isolate: c?.isolate ?? true,
      normalize: c?.normalize ?? true,
      dereverb: c?.dereverb ?? false,
      dereverb_method: c?.dereverb_method,
    }
  })
  const script = s.tracks
    .flatMap((t) => t.segments)
    .slice()
    .sort((a, b) => a.start_s - b.start_s || a.index - b.index)
    .filter((seg) => seg.text && seg.text.trim())
    .map((seg) => `Speaker ${seg.speaker_id}: ${seg.text.trim()}`)
    .join('\n')
  return {
    nonce: Date.now(),
    script,
    title: s.title,
    multi_speaker: true,
    num_speakers: Math.max(1, gen.length),
    speakers,
  }
}
