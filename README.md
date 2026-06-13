# OmniVoice Manager

A modern, browser-based studio and JSON API for [OmniVoice](https://github.com/k2-fsa/OmniVoice) zero-shot text-to-speech — built to make multi-speaker, production-quality voice generation fast and pleasant, without Gradio.

<img width="2547" height="1255" alt="image" src="https://github.com/user-attachments/assets/f55f579f-5c9f-4dfd-b56c-5a3b2745330d" />

**Hear it** — a short multi-speaker demo produced entirely with the Manager:

https://github.com/user-attachments/assets/69f211b9-c8ae-49dd-a050-cddcd7ee8bdf

OmniVoice generates a single utterance per call. The Manager wraps it with everything needed to turn that primitive into finished audio: a full **multitrack timeline editor (ADR Studio)**, **vocal performance transfer** (act a line yourself, hear it in a cloned voice — timing, emphasis, and emotion preserved), multi-speaker dialogue stitching, reference-audio cleanup, perceptual loudness matching, an AI scriptwriter, a rich audio editor, and a clean API for automation.

**📚 Full feature documentation lives in [`docs/`](docs/README.md):** [ADR Studio](docs/adr-studio.md) · [Performance Transfer](docs/performance-transfer.md) · [Voice Clone](docs/voice-clone.md)

---

## Highlights

### A real studio UI (React + Vite + TypeScript)
A fast single-page app served directly by the backend — no Gradio, no page reloads, no awkward component churn. Live job progress, persistent history, and a voice library are all first-class.

### Performance Transfer — direct the voice with your own (V2V)
Text gives you a *reading*; a performance gives you a *performance*. Record (or upload) yourself acting a line and the Manager re-renders it in the target voice by seeding OmniVoice's masked-diffusion token grid with your take — no fine-tuning, no separate conversion model.

- **🎭 Character swap** — the target voice reads your line with *its own* mannerisms and delivery (your timing survives). **🎤 Voice swap** — your exact delivery and cadence in their timbre. Each with a 1–5 strength dial.
- **Record Dialog** — double-click any track and speak a brand-new line straight into the timeline; Auto-Whisper transcribes it, one button renders it.
- **⟳ Redub chains** — layer passes (e.g. a gentle voice round, then a character round) with a walk-back **dub trail** of every intermediate take.
- **A/B & Split L/R inspection** — hear your take against the render back-to-back or simultaneously in stereo (take left, render right), and export either comparison as a WAV.
- In-modal rendering with auto-play, DAW-style trim handles, take cleanup (isolate / de-reverb / auto-leveling), and per-clip persistence — saved performances even ride through channel-wide re-casts.

→ [Full guide](docs/performance-transfer.md)

### Multi-speaker dialogue, beyond the base model
OmniVoice synthesizes one voice at a time. The Manager parses `Speaker N:` scripts, assigns a distinct voice (cloned, designed, or auto) to each speaker, generates line by line, and stitches everything into one continuous track — with no hard cap on speaker count. Add or remove speakers dynamically (N+).

### Multitrack timeline editor — a mini-DAW for dialogue
This is the heart of the Manager. Instead of one baked render, every scene is kept as **individual, regenerable clips on a real timeline**, so a single bad take never costs you the whole 99%-good performance.

- **Per-segment & per-channel regenerate** — re-roll one line (or re-cast an entire speaker's voice and regenerate all their lines) without touching anything else. Regeneration auto-aligns each new clip's endpoint and ripples downstream — for both single and regenerate-all — unless the clip is layered under a longer one, which it leaves untouched.
- **True additive mixing** — overlapping clips are summed, not concatenated, so speakers can talk over each other, argue in unison, and react — real, messy, human conversation.
- **Move / trim / speed / gain per clip** — drag clips anywhere, trim with a waveform, pitch-preserving time-stretch (no "bathroom" echo), and per-clip dB. Plus split, duplicate (ripple or not), delete, and insert/delete empty time.
- **Compose from scratch** — the moment you pick Multi-speaker you get a blank timeline. Build a whole scene by hand one clip at a time, or generate from a script and refine.
- **Auto-slice by sentence & Whisper align** — split a monologue into one clip per sentence using word-level timestamps, or align a clip's displayed text to its actual audio — no regenerate.
- **Vocal Inpaint (per-segment ADR)** — lock a clip's own audio as a temporary, timeline-local voice clone, then rewrite the line in that exact voice. Per-segment automated dialogue replacement. Optional **Preserve non-vocal** keeps the clip's original background (music / room / noise) isolated at lock time and mixes it back under each regenerated take, trimmed to follow the new voice's length.
- **Uploaded audio channels** — drop in a soundtrack / SFX / recording as its own non-generative layer with independent gain, then **⭐ promote** it into a full clone voice channel (auto-transcribed, with a matching speaker added) when you want to put words in its mouth.
- **Merge, collapse, mute** — shift-click clips on a track and merge them into one (gaps become silence); flatten an entire lane into a single re-sliceable clip; or mute a lane in the mix without touching it.
- **Tag library** — hot-clickable OmniVoice non-verbal cues (`[laughter]`, `[whisper]`, …) injected at the cursor in any dialogue field.
- **Zoom, pan, follow-playhead, spacebar transport, single-step undo**, magnetic selection edges, and a vertical resize to grow the rows + waveform — it feels like an editor, not a form.
- **Finalize** stitches the timeline to a single, loudness-matched, true-peak-limited track and saves it to history.

→ [Full guide](docs/adr-studio.md)

### Professional loudness matching
Multi-voice mixes usually suffer from one speaker booming while another whispers. The Manager applies **perceptual LUFS loudness matching** (ITU-R BS.1770 / EBU R128, K-weighted) across every segment so all speakers sit at the same perceived volume, then runs a single **true-peak limiter** on the final mix to prevent clipping. This is the same approach broadcast engineers use — not a crude per-clip gain bump.

### Voice Lab: clean references in one click
Reference quality makes or breaks a clone. The Voice Lab can, on the fly:
- **Isolate** vocals from music/noise/room tone with a Mel-Band-RoFormer separator.
- **De-reverb** echoey clips — choose between a RoFormer de-reverb model (stronger) or DeepFilterNet (lighter, optional).
- **Normalize** loudness.

Isolation and normalization are on by default; de-reverb is opt-in per speaker.

### Smart Script writer with hot-swappable AI providers
Generate or refine `Speaker N:` scripts from a prompt using any OpenAI-compatible endpoint. Declare multiple providers (OpenAI, Gemini, a local LLM, …) in `.env`, switch between them in the UI, and **reload them live** without restarting the server. The scriptwriter is tuned for OmniVoice's bracketed non-verbal cues and ships with a resilient parser that salvages valid output even when a model returns truncated or malformed JSON.

### A polished audio player
The result player renders a waveform and supports **trim**, **output gain (dB)**, **reset**, **autoplay**, and **download of the processed file** reflecting your edits — all in the browser via the Web Audio API.

### Lightweight, shareable outputs
Finalized scenes are encoded to **MP3 (192k)** instead of 150 MB WAVs — small enough to drop into a message or social post without degrading the audio you actually hear.

### VRAM controls for any GPU
- **LOD (Load-On-Demand):** load the TTS model per job in an isolated worker process and free it afterwards, so the GPU sits idle between jobs.
- **Low VRAM Mode:** within a job, load models sequentially and free each secondary model (isolation / de-reverb) before the TTS model loads — capping peak VRAM at `max(one secondary model, TTS)` instead of the sum. Slower, but runs the full pipeline on small consumer cards.

### History that actually restores
Every generation stores its full state — prompt, script, single/multi-speaker mode, each speaker's configuration, and all generation parameters — so one click rebuilds the exact setup. Backwards compatible with older entries.

### API-first
Every UI capability is also an HTTP endpoint, including the Smart Script system — so you can drive generation from your own tools (e.g. a ComfyUI connector) and not just basic synthesis.

---

## Architecture

```
web/        React + Vite + TypeScript single-page app (built to web/dist)
manager/    FastAPI backend
  server.py         HTTP API + static UI hosting
  model_manager.py  GPU worker lifecycle (spawn / warm / unload)
  worker.py         child process: TTS, isolation, de-reverb, Whisper, loudness, stitching
  sessions.py       multitrack timeline: per-clip audio, additive mixing, edits, undo
  service.py        worker payload building, finalize, history
  scripts_ai.py     Smart Script writer (multi-provider, robust parsing)
  vocal_isolation/  Mel-Band-RoFormer port + DeepFilterNet integration
  audio_utils.py    LUFS matching, true-peak limiting, normalization, time-stretch
omnivoice/  Upstream OmniVoice model + inference package
```

All GPU work runs in a dedicated child process. This isolates the CUDA context, makes LOD-style VRAM reclamation reliable (the process is terminated to release memory), and keeps the API responsive.

---

## Requirements

Linux, Windows, and macOS (Apple Silicon) are supported.

> ⚠️ **macOS performance:** the Mac build is fully functional but **much slower
> than an NVIDIA GPU** — PyTorch's MPS backend only accelerates part of the
> pipeline (the audio tokenizer falls back to CPU, among others), so renders
> that take seconds on CUDA can take a minute or more on an M-series Mac.
> Treat it as a portable/dev experience, not a production one. Exploring
> [MLX](https://github.com/ml-explore/mlx)-based speedups is on the roadmap.

Bring your own tooling — the installer never installs or modifies system-level
tools (Node, Python, ffmpeg), so it can't break your existing environments.
Have these on your PATH before you start:

- An NVIDIA GPU with CUDA, or an Apple Silicon Mac with MPS (CPU works but is slow)
- **Node.js 18+** with npm — used only for a one-time build of the web UI, never
  installed for you. Get it from [nodejs.org](https://nodejs.org) or a package
  manager (`winget install OpenJS.NodeJS.LTS` / `brew install node` /
  `apt install nodejs npm`). After `web/dist` is built, Node isn't needed to run.
- **[`uv`](https://docs.astral.sh/uv/getting-started/installation/)** for Python
  dependency management. You do **not** need Python pre-installed — `uv sync`
  downloads a managed Python 3.10 into its own cache, without touching any
  Python already on your system.
- **`ffmpeg`** for MP3/M4A/OGG output encoding (without it, outputs fall back to
  WAV). [ffmpeg.org/download](https://ffmpeg.org/download.html), or
  `winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`.

---

## Installation

The same commands work on Linux, Windows, and macOS:

```bash
git clone https://github.com/SanDiegoDude/OmniVoice-Manager
cd OmniVoice-Manager

# Python environment + dependencies.
# Keep "--python 3.10" as written, regardless of which Python (if any) you have
# installed — uv fetches its own 3.10 if needed and leaves your system Python
# alone. The version is pinned to the known-good, tested configuration.
uv sync --python 3.10

# Optional: DeepFilterNet de-reverb backend
uv sync --extra dereverb

# Build the web UI
cd web && npm install && npm run build && cd ..
```

(`uv sync` automatically pulls the CUDA build of PyTorch on Linux and Windows, and the standard PyPI build — with Metal/MPS support — on macOS.)

Model weights for OmniVoice, the vocal isolation checkpoint, and (when used) Whisper are downloaded automatically on first use into `./models` and the Hugging Face cache.

---

## Configuration (optional — AI script writer only)

**This whole step is optional, and no API keys are required to use the Manager.**
The `.env` file only powers the AI Smart Script writer; without it you simply
write (or paste) your own scripts and every other feature — voice cloning,
multitrack editing, performance transfer, the works — runs exactly the same.

To enable AI dialogue generation, copy the template and add your keys:

```bash
cp .env_sample .env       # Linux / macOS
copy .env_sample .env     # Windows
```

Declare one AI provider per line:

```
AI_PROVIDER_<ID> = Label | model | base_url (blank = official OpenAI) | api_key
```

Comment a line out to hide that provider. After editing `.env`, click **Refresh** next to the provider picker in the UI to reload — no restart needed.

---

## Running

```bash
./run_manager.sh      # Linux / macOS
run_manager.bat       # Windows
```

The script serves the app at `http://localhost:8200`. It builds the web UI on
first run and **automatically rebuilds whenever the frontend source is newer
than the last build** — so after a `git pull` you always get the current UI
without thinking about it. Two launcher-only flags help when things get stuck
(they are consumed by the script and not passed to the server):

| Launcher flag | Description |
| --- | --- |
| `--rebuild` | Force a fresh web UI build even if one already exists (e.g. after a dependency change the timestamp check wouldn't catch) |
| `--forceup` | Kill whatever is already listening on the port before starting — clears an orphaned/stale server (handy on Windows, where closing the window can leave the Python process running) |

All other flags pass straight through, e.g. `run_manager.bat --forceup --ssl`.

Run the backend directly for more control:

```bash
.venv/bin/omnivoice-manager --port 8200 [options]       # Linux / macOS
.venv\Scripts\omnivoice-manager --port 8200 [options]   # Windows
```

| Flag | Description |
| --- | --- |
| `--port` / `--host` | Bind address (default `8200` / `0.0.0.0`) |
| `--model` | Model id (default `k2-fsa/OmniVoice`) |
| `--device` | `auto` (default; picks CUDA > MPS > CPU) or pin e.g. `cuda:0` / `mps` / `cpu` |
| `--lod` | Load the model on demand and free VRAM after each job |
| `--eager` | Load the model at startup |
| `--preload-asr` | Preload Whisper (otherwise it loads only when transcribing a reference) |
| `--ssl` | Serve self-signed HTTPS — required for mic recording from other machines (browsers only expose `getUserMedia` on secure origins) |

LOD and Low VRAM mode can also be toggled live from the top bar in the UI.

---

## Using the UI

- **🎬 ADR Studio** (default tab) — write or AI-generate a script, configure speakers (clone / design / auto), set generation and loudness options, and generate straight into the timeline: regenerate / move / trim / speed / gain individual clips, split / duplicate / delete, insert or remove empty time, layer overlapping dialogue, auto-slice, Vocal Inpaint, record dialogue or vocal performances straight into clips, add uploaded audio channels and promote them to voices, then **Finalize** to commit and save. Single-step **Undo** covers any edit. **Sync dialogue from Editor** pulls the timeline's current lines back into the script box (in timeline order) without re-running Whisper.
- **🎤 Voice Clone** — single-voice takes from text or a recorded performance (inline capture panel), with the same AI scriptwriter.
- **Voice Lab** — upload or pick a reference, manually trim it, preview isolation / de-reverb / normalization, and save (or overwrite) the cleaned voice in your library.
- **Tag library** — a hot-clickable list of OmniVoice's supported bracket cues that inject at your cursor.
- **History & Outputs** — replay, download, or fully restore any past generation.
- **Mobile-friendly** — the voice library and history collapse to edge tabs on desktop and slide-over drawers on phones; swipe-back navigation is disabled so a stray edge gesture can't nuke a session.

---

## API

All endpoints are JSON over HTTP. Selected routes:

| Method & Path | Purpose |
| --- | --- |
| `GET /api/system/info` | Model, GPU, AI-provider, LOD / Low-VRAM status |
| `POST /api/system/lod` · `POST /api/system/low-vram` | Toggle VRAM modes |
| `GET /api/script/providers` · `POST /api/script/reload` | List / hot-reload AI providers |
| `POST /api/script` | Generate or refine a `Speaker N:` script from a prompt |
| `POST /api/generate` | Synthesize from a script (queued; returns a job id) |
| `POST /api/generate-perform` | One-shot performance transfer: upload a take + params, render in a target voice |
| `POST /api/generate/script-and-speak` | Smart Script **and** synthesis in one call |
| `POST /api/process-clip` · `POST /api/transcribe-clip` | Isolate/de-reverb or Whisper any uploaded clip |
| `GET /api/jobs/{job_id}` | Poll job status / result |
| `GET /api/voices` · `POST /api/voices/upload` · `POST /api/voices/process` | Voice library + Voice Lab |
| `GET /api/outputs` · `GET /api/history` | Browse results and history |

### Multitrack timeline

| Method & Path | Purpose |
| --- | --- |
| `POST /api/multitrack/generate` · `POST /api/multitrack/empty` | Generate a scene as clips, or start a blank timeline |
| `POST /api/multitrack/{sid}/speaker` · `POST·DELETE …/speaker/{pos}` | Add / update / remove a speaker track |
| `POST …/segment/{i}/regenerate` · `…/edit` · `…/text` | Regenerate, move/trim/speed/gain, or align a clip's text |
| `POST …/segment/{i}/split` · `…/duplicate` · `…/delete` · `…/auto-slice` · `…/inpaint` · `…/inpaint-preserve` | Clip operations + Vocal Inpaint (and non-vocal bed) |
| `POST …/delete-space` · `…/add-space` · `…/reflow` · `…/insert` | Timeline structure + global speed/gap |
| `POST …/upload-channel` · `…/speaker/{pos}/promote` · `…/speaker/{pos}/regenerate` | Audio channels, promote-to-voice, re-cast a channel (honors per-clip performances) |
| `POST·DELETE …/segment/{i}/performance` | Attach / detach a vocal performance (multipart take + mode/strength/gain/speed) |
| `POST …/merge` · `…/speaker/{pos}/collapse` | Merge selected clips, collapse a track to one clip |
| `POST …/segment/{i}/transcribe` · `…/{sid}/undo` · `…/{sid}/finalize` | Whisper a clip, single-step undo, commit to history |

Generation is asynchronous: submit to `/api/generate` (or `/api/multitrack/generate`), then poll `/api/jobs/{job_id}` until `status` is `done`. Most timeline edits are synchronous and return the updated session.

---

## Acknowledgements

The OmniVoice Manager stands on excellent open-source work. See [`NOTICE`](NOTICE) for the full list, including:

- **[OmniVoice](https://github.com/k2-fsa/OmniVoice)** (k2-fsa / Xiaomi Corp) — the underlying TTS model and inference package.
- **Mel-Band-RoFormer** — [lucidrains](https://github.com/lucidrains/BS-RoFormer) (architecture), [Kimberley Jensen](https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model) (vocal model), and [kijai](https://github.com/kijai/ComfyUI-MelBandRoFormer) (ComfyUI port) for vocal isolation and de-reverb.
- **[DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)** — optional neural denoise / de-reverb.
- **[pyloudnorm](https://github.com/csteinmetz1/pyloudnorm)** — loudness measurement.
- **[Whisper](https://github.com/openai/whisper)** — reference transcription.

---

## License

Licensed under the [Apache License 2.0](LICENSE). The bundled `omnivoice/` package is redistributed under its original Apache-2.0 license from the upstream project; see [`NOTICE`](NOTICE) for attribution of all third-party components.
