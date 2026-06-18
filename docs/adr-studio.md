# 🎬 ADR Studio — the multitrack timeline editor

ADR Studio is the default tab and the heart of the Manager. Instead of one baked render, every scene lives as **individual, regenerable clips on a real timeline** — a mini-DAW for dialogue. A single bad take never costs you the rest of the performance.

## Scenes, tracks, and clips

- The app opens with one voice and one empty track. Add speakers from the roster at the top (no hard cap) — each becomes a track. Write a `Speaker N:` script (or AI-generate one) and **Generate** to populate the timeline one clip per line, or build a scene entirely by hand.
- **Generative tracks** synthesize with their channel's voice (clone / design / auto). **Audio tracks** hold uploaded files (music, SFX, location recordings) with independent gain — non-generative, but promotable (below).
- **Additive mixing**: overlapping clips are summed, not concatenated. Speakers can talk over each other, argue in unison, and react — real, messy, human conversation.

## Regeneration & the ripple rules

- **Per-clip regenerate** re-rolls one line in place. If the new take is longer or shorter, downstream clips ripple by the delta so your scene's spacing survives — but *only* when the clip controls its endpoint (it ends alone, or is the longest of its overlap stack). A short clip layered under a longer one leaves the timeline untouched.
- **Channel regenerate-all** re-renders every clip on a track with the same smart ripple, clip by clip in timeline order — the tool for re-casting a voice. Clips with a saved vocal performance re-render **as performances** against the new voice; plain clips do a normal read.
- **Single-step undo** covers any edit or regeneration.

## The clip toolkit

Right on the clip (or in its ⋯ menu when zoomed out):

- **Move** (drag), **trim** (waveform panel), **pitch-preserving speed**, **per-clip dB** (a floating readout follows your cursor while you drag gain, so the value stays visible even on long off-screen clips).
- **Split at playhead**, **duplicate** (with or without ripple), **delete** (with or without ripple), **download** an individual clip.
- **Inline dialogue editing** — double-click a clip's text, edit, and regenerate with the new line.
- **Auto-slice by sentence** — split a monologue into one clip per sentence using Whisper word timestamps.
- **Manual slice** — hold **Ctrl** (or ⌘) and click a clip to drop a razor; drag to fine-tune the exact split point and release to cut into two clips. Both halves are auto-whispered, and the slice is covered by single-step undo.
- **🎚 Vocal transforms** — open the per-segment transform modal to reshape an existing clip's audio: pitch / formant, creative colours (sub-octave, drive, ring-mod, vibrato), presets, and a **☎️ Telephone** lo-fi "bad phone call" effect (band-limit + crackle). Preview before committing; the bake is reversible (re-open and remove to restore the original).
- **🎛 Isolate ▸ Voice / Instrumentals** — split a clip into stems with the RoFormer separator: keep just the voice, or just the instrumental/background. Most useful on uploaded audio channels (pull the vocal off a song, or the music out from under a recording). Destructive but undo-covered — a wrong stem is one Undo away, then isolate the other from the original mix.
- **Whisper align** — re-sync a clip's displayed text to its actual audio without regenerating.
- **Merge** — shift-click clips on the same track, then merge into one continuous clip (gaps become silence, text concatenates).
- **Collapse track** — flatten an entire lane into a single movable, trimmable, re-sliceable clip.
- **Mute track** — silence a whole lane in the mix without touching its clips.

## Pin Current Voice to Segment — per-segment ADR

Lock a clip's **own audio** as a temporary, timeline-local voice clone, then rewrite the line in that exact voice. Perfect for fixing one word of an otherwise great take, or putting new words in an uploaded recording's mouth. (This was formerly labelled "Vocal Inpaint.")

- **Preserve non-vocal** (optional): at lock time the clip's background (music / room / noise) is isolated and kept as a bed; every regenerated take gets it mixed back underneath, trimmed to follow the new vocal's length.

## Record Dialog & vocal performances

Double-click an empty spot on a generative track → **🎙 Record dialog…** to speak a brand-new line straight into the timeline:

- Record (or upload) — **Auto-Whisper** transcribes the take into the dialogue box the moment you stop.
- **⚡ Render** inserts the clip at that spot and speaks the text in the track's voice. Don't like the flat read? Flip on **🎭 Capture performance** and your recording's timing, emphasis, and emotion drive the render. See [Performance Transfer](performance-transfer.md) for the full system — modes, strength, Redub chains, and A/B inspection.
- Existing clips get the same modal from the clip's inline **🎙 mic** button (next to regenerate) or the merged **Record/Upload vocal performance…** menu entry. A clip with a saved performance is gold-boxed; if its settings changed since the last render it pulses until you regenerate.

**Booth comforts** (shared with the Voice Clone tab, settings remembered):

- **3-2-1 count-in** — optional beep countdown before recording starts.
- **Auto-whisper** — its on/off state now persists, so a fluffed take doesn't get auto-transcribed against your wishes.
- **Cancel** button (and **Esc**) discards a take mid-record; **Space** stops recording (without triggering the player), just like clicking stop.
- The dialogue box stays put under the record button while recording, so the line you're reading no longer jumps as the player hides.

> Mic capture requires a secure origin. Run the server with `--ssl` (self-signed HTTPS) or open via `localhost` — the modal explains and falls back to file upload otherwise.

## Timeline structure tools

- **Insert empty time** / **delete time** — double-click an empty spot to add a clip, add playtime, or **close a gap** (ripple-delete the space between two clips). Drag-select a span to delete it across all tracks; selection edges snap magnetically to nearby clip boundaries.
- **Global reflow** — scene-wide speed and inter-line gap adjustments.
- **Uploaded audio channels** — add one or **many files at once** via **+ Audio channel** (audio *and* video — audio is extracted from `.mp4`/`.mov`/… automatically). Each file lands at the playhead in its own track. Any channel can be **⭐ promoted** into a full clone voice channel: the audio is auto-transcribed, a matching speaker is added, and you can start generating dialogue in that voice.

## Transport & navigation

- **Spacebar** play/pause · jump to start/end · previous/next clip boundary.
- **Shift+scroll** zoom (cursor-anchored) · **`+` / `-` keys** zoom on the timeline centre · **middle-click drag** pan · follow-playhead · vertical resize for taller rows and bigger waveforms.
- After any render — single clip, insert, channel, or full scene — the result **auto-plays** so you instantly hear what you got.

> **Heads-up before a full regenerate:** re-running scene-wide **Generate audio** rebuilds the whole timeline and drops uploaded channels. If you've hand-edited the scene or added uploads, the Manager asks for confirmation first so a stray click can't wipe your work.

## Finalize

**Finalize** stitches the timeline into one track with **perceptual LUFS loudness matching** (ITU-R BS.1770 / EBU R128) across all clips and a single **true-peak limiter** on the master — then saves it to history in your chosen output format (**MP3 192k** or **lossless FLAC**, set by the top-bar toggle). Every generation in history stores its full state and restores with one click.
