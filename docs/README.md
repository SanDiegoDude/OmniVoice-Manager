# OmniVoice Manager — Documentation

Feature guides for the OmniVoice Manager studio. Start with the [main README](../README.md) for installation and a capability overview, then dive into the area you're working in:

| Guide | What it covers |
| --- | --- |
| [ADR Studio](adr-studio.md) | The multitrack timeline editor — tracks, clips, regeneration and ripple rules, Pin Current Voice to Segment, manual slice, per-segment vocal transforms, Record Dialog, merge/collapse/mute, editing tools, transport and shortcuts |
| [Performance Transfer](performance-transfer.md) | Voice-to-voice (V2V): act a line yourself and paint a cloned voice over your performance. Character vs. Voice modes, strength, Redub chains, A/B inspection and exports |
| [Voice Clone](voice-clone.md) | The single-voice tab — high-quality one-shot clones from text or a guided performance, the Voice Lab, reference cleanup, and the AI scriptwriter |

## The 60-second tour

OmniVoice generates one utterance per call. The Manager turns that primitive into a studio:

1. **🎬 ADR Studio** (default tab) — write or AI-generate a script, cast voices, and generate a scene as *individual, regenerable clips on a real timeline*. Fix one bad line without re-rolling the other 99%. Layer, trim, time-stretch, inpaint, and finalize to a loudness-matched master.
2. **🎤 Voice Clone** — produce a single polished take. Type text, or record the line yourself and have the cloned voice deliver it with *your* timing and emphasis.
3. **Performance Transfer** lives everywhere a clip does — double-click a track to record dialogue straight into a new segment, or attach a performance to any existing clip and re-render it in place.

## Quick glossary

| Term | Meaning |
| --- | --- |
| **Segment / clip** | One generated utterance on the timeline; independently regenerable |
| **Channel / track** | A speaker lane (generative voice) or an uploaded-audio lane |
| **Take** | Your recorded/uploaded performance audio inside the dialogue modal |
| **Capture performance** | Modal toggle: ON = your take drives a V2V transfer; OFF = the recording is just dictation for plain TTS |
| **Character swap** | V2V mode: the target voice's own mannerisms take over your read (timing preserved) |
| **Voice swap** | V2V mode: pure timbre swap — your exact delivery and cadence in the target voice |
| **Redub** | Promote a render to the new take for another processing pass; the chips trail lets you walk back |
| **Pin Current Voice to Segment** | Lock a clip's own audio as a temporary clone and rewrite the line in that exact voice (formerly "Vocal Inpaint") |
| **Ripple** | Timeline edits that push/pull downstream clips to preserve spacing |
| **Finalize** | Bake the timeline into a single LUFS-matched, true-peak-limited MP3 in history |
