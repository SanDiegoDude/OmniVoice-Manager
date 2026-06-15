# 🎭 Performance Transfer (V2V)

The Manager's killer feature: **act a line yourself and re-render it in a cloned voice** — timing, pauses, emphasis, interruptions, and emotion preserved. Text-to-speech gives you a *reading*; performance transfer gives you a *performance*.

## How it works (the short version)

OmniVoice is a masked-diffusion token model: it generates audio by iteratively unmasking an 8-layer grid of audio tokens. The Manager exploits that directly — your recorded take is tokenized into the same grid, selected tokens are **pinned** as the model generates with the target voice's clone prompt, and the unmasking schedule decides how much of your performance survives versus how much the target voice "takes over." No fine-tuning, no separate conversion model: it's the TTS model itself, steered.

Two pinning strategies become the two modes you see in the UI:

| Mode | What you get | Under the hood |
| --- | --- | --- |
| **🎭 Character swap** | The target voice reads your line with **its own mannerisms and delivery** — your timing and structure survive, but your character sounds like your character | Pin-then-release ("anneal"): your tokens anchor early diffusion steps, then release so the character finishes the performance |
| **🎤 Voice swap** | **Your exact delivery and cadence** in the target's timbre — you, wearing their voice | Sparse persistent pins ("stride"): a lattice of your tokens stays locked the whole way through |

## Strength

One 1–5 slider per mode, calibrated by ear:

- **Character swap** — 1 barely teases away from your read … **4 strong character takeover (default — the sweet spot for most voices)** … 5 maximum character (most creative, most hallucination risk). A few sources genuinely land best at 1; trust your ears.
- **Voice swap** — 1 exact source performance, full pin … 3 balanced … 5 loosest (timbre interpolates freely, most artifacting risk). Mid-slider settings can even create *new* voices between you and the target.

## The dialogue modal

Open it from a clip's menu (**🎙 Record vocal performance…**) or by double-clicking an empty track spot (**🎙 Record dialog…** — inserts a new clip on first render). One modal, two personalities via the **🎭 Capture performance** toggle:

- **Capture ON** — your take is the performance source. Take player with DAW-style trim handles (green start / red end, shift+scroll zoom), take speed, mode and strength.
- **Capture OFF** — the recording is just dictation: Auto-Whisper fills the dialogue, **⚡ Render** does a plain TTS read in the track's voice. The attached performance (if any) is bypassed, never touched.

Workflow niceties:

- **Record / re-record / upload**, with **Isolate vocals** and **Dereverb** cleanup (default on for fresh takes; their state is preserved when you re-open a saved performance) and client-side level normalization — quiet mics are handled.
- **3-2-1 count-in** (optional beep countdown) and **Auto-Whisper** are both sticky preferences, synced between this modal and the Voice Clone tab — so a fluffed take no longer auto-transcribes against your wishes.
- **Cancel** (or **Esc**) drops a take mid-record; **Space** stops recording just like clicking stop (without also triggering the player). The dialogue box holds its position while recording so the line you're reading doesn't jump.
- **⚡ Render in-modal** — hear the result immediately, with the output's trim/gain applying back to the clip on Save. Renders auto-play.
- **💾 Save** stores the take + settings on the clip (gold box). If you've already rendered, the clip is done — it only re-arms (pulses) when settings change *after* the last render.

## Vocal transforms — reshape the take before the clone

A collapsible **🎚 Vocal transforms** box (in both the performance modal and the Voice Clone tab) reshapes your take *before* it's tokenized, so the model clones a performance already in the target's range instead of fighting a big register gap. Everything is baked at render time and persisted on the clip, so Redub and channel regenerate reproduce it.

- **Pitch** and **Formant** (semitones, independent) ride the WORLD vocoder, so timing and prosody survive. Formant up = smaller/younger, down = bigger/darker — the difference between a believable child voice and a chipmunk.
- **🎯 Auto pitch-match to target** estimates your take's median f0 vs. the cast voice's and sets the pitch slider to bridge them — the fastest way to map a deep voice onto a high target.
- Creative colours behind weight sliders: **Sub-octave** (Vader/monster body), **Drive** (growl/grit), **Ring mod** (robot/demon), **Vibrato**, and **☎️ Telephone** (band-limited lo-fi + crackle for that "bad phone call / old voicemail" feel).
- **Presets** (Vader, Monster, Demon, Child, Chipmunk, Robot, Telephone) are one-click slider combos — a starting point to tweak by ear. (The same transform engine is also exposed per-segment on the ADR timeline — see [ADR Studio](adr-studio.md#the-clip-toolkit).)
- **🎧 Apply** bakes the transforms (plus auto pitch-match) straight onto the **main player** — no second mini-player to juggle. The take you hear is exactly what the model is handed; **↺ Reset** restores the pristine take. The same minimized box (**🎧 Apply to output**) sits under the rendered output, so the modulated output becomes a first-class output: **Redub**, **Save voice**, **Import to ADR Studio**, and download all act on what you hear. Apply works from the original each time (it never stacks), and any fresh take/render clears it.

> Take loudness is auto-leveled by the transfer (the take's dB control is for monitoring); the **output** gain is the real loudness lever and is applied to the clip on Save.

## Redub — chain processing passes

Some voices won't take cleanly at high strength in one pass. The fix: **run a gentle voice round first, then a character round on top**. That's what **⟳ Redub** is for — it promotes the current render to the active take so the next render processes *it*.

- Each redub adds a chip to the **dub trail**: `🎬 Original → Redub 1 → Redub 2 → …`. Click any chip to walk back to an earlier source and try a different path.
- Redubs carry an **×** to prune dead ends; an accidental delete has a one-step **↩ Undo**.
- On Save, **only the active take is kept** — it becomes the clip's ground-truth performance. The trail is scratch space and dies with the modal.
- The original is pinned into memory when the modal opens, so walking back is always faithful. Cleanup toggles lock while a redub is active (they re-process the original source).
- Redub bakes the output's dialed-in **dB + trim** into the new take, so the level you set survives the round-trip instead of snapping back to the raw render.
- The **Voice Clone tab** now has Redub too (**⟳ Redub (use as take)** next to the render): it promotes the finished render to the capture panel as the new take for another pass.

## Rerolling: the render button when minimized

The Script / Text-to-speak card can be collapsed to get it out of the way. In the **Voice Clone tab** the **🎙 Render** button stays pinned to the collapsed header so you can reroll the same line over and over while you play with voices. On the **ADR Studio** side it's hidden by default (a stray re-render there can wipe scene work) — flip the small **show when minimized** checkbox next to *Generate audio* if you want it pinned there too.

## Save voice to library

Both the performance modal and the Voice Clone tab carry **📚 Save voice…** — export the **rendered output** (the character performing) or your **raw take** straight into the voice library with the usual Lab cleanup (isolate / normalize / trim / dereverb). Made a fun voice? It's one click from being castable on any speaker. Use `/` in the name for folders (e.g. `Cast/Alice`).

## Inspecting & demoing results

With both a take and a render loaded:

- **▶ A/B** — your take, then the render, back-to-back (both trimmed, level- and speed-matched).
- **▶ Split L/R** — both *simultaneously*, take hard-left and render hard-right. The fastest way to hear how tightly the output rides your delivery.

The **Voice Clone tab** carries the same **A/B**, **Split L/R**, and their **⬇ downloads** under the output player (whenever a take is loaded), plus an **Output speed** slider and **✂ Stamp trim/speed** that bakes the trim window + (pitch-preserving) speed into the ground-truth output — so the stamped result is what Redub / Save / Import / download all use.
- **⬇** next to each — export the comparison as a WAV (the split export is true stereo). Great for sharing.
- Both the take and the render have individual **Download** buttons too.

## Performance + the rest of the studio

- A clip's saved performance **rides through channel regenerate-all**: re-cast the voice and every performance clip re-renders as a V2V against the new voice, while plain clips do a normal read.
- **Word-level inpainting**: combine performance clips with [Pin Current Voice to Segment](adr-studio.md#pin-current-voice-to-segment--per-segment-adr) to surgically replace single words inside a take.
- The **Voice Clone tab** has an inline capture panel for one-shot performance-guided renders without a timeline — see [Voice Clone](voice-clone.md).
- Renders are seeded deterministically per run, so re-rolls are controlled rather than chaotic.

## Mic access (HTTPS)

Browsers only expose the microphone on secure origins. Either open the app via `localhost` (an SSH tunnel works: `ssh -L 8200:localhost:8200 <server>`), or start the server with `--ssl` to serve self-signed HTTPS. The modal detects an insecure origin and explains; file upload always works.
