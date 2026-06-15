# 🎤 Voice Clone — single-voice takes

The Voice Clone tab is for producing **one polished take in one voice** — narration, a character line, a voicemail greeting — without the timeline. Two ways to drive it:

## Text → speech

Classic mode. Pick a voice (clone / design / auto), write or AI-generate the text, set generation parameters, **Generate**. The result lands in the player (waveform, trim, dB, download) and history.

- **Clone** — reference audio from your voice library defines the voice. References are cleaned on the fly (see Voice Lab below) and active-speech-leveled, so a quietly mastered reference still produces a healthy render.
- **Design** — describe the voice in text.
- **Auto** — let the model choose.

## Performance-guided (V2V one-shot)

The inline **vocal performance capture** panel turns the tab into a transfer booth:

1. **Record** (or upload) your read of the line — Auto-Whisper transcribes it into the text box, and Isolate/Dereverb cleanup runs by default. An optional **3-2-1 count-in**, the **auto-whisper** toggle, **Cancel**/**Esc** to discard, and **Space** to stop are all here too (settings sync with the performance modal).
2. Pick **Character swap** or **Voice swap** and a strength (see [Performance Transfer](performance-transfer.md) for what they mean).
3. **Generate** — the take is uploaded with the request and the clone renders *your performance* in the target voice, one shot, no session needed.

Clear the capture panel and the Generate button falls back to plain text-to-speech.

## The AI scriptwriter

Available in both tabs: generate or refine text from a prompt using any OpenAI-compatible provider (OpenAI, Gemini, local LLMs, …) declared in `.env`. Providers hot-reload from the UI without a server restart. The writer is tuned for OmniVoice's bracketed non-verbal cues (`[laughter]`, `[whisper]`, …) — the **tag library** injects any cue at your cursor.

## Voice Lab — build the library

Reference quality makes or breaks a clone. The Voice Lab takes any clip and, in one pass:

- **Isolate** vocals from music / noise / room tone (Mel-Band-RoFormer).
- **De-reverb** echoey sources (RoFormer model, or DeepFilterNet as a lighter optional backend).
- **Normalize** loudness.
- **Trim** manually on the waveform, preview, then save to the library (with an overwrite warning if the name exists).

Isolation and normalization are on by default; de-reverb is opt-in per voice. Voices saved here are available everywhere — Voice Clone, ADR Studio channels, and promotions from uploaded audio.

## Tips for good clones

- 5–15 seconds of clean, dry, single-speaker audio beats minutes of noisy audio.
- If the reference has music or echo, let Isolate + De-reverb do their job — generating from a dirty reference bakes the dirt into the voice.
- Quiet references are auto-leveled, but clipping can't be undone — prefer un-clipped sources.
- For a voice that won't take well in V2V at high strength, chain passes with [Redub](performance-transfer.md#redub--chain-processing-passes).
