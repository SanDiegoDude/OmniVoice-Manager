# OmniVoice Manager

A modern, browser-based studio and JSON API for [OmniVoice](https://github.com/k2-fsa/OmniVoice) zero-shot text-to-speech — built to make multi-speaker, production-quality voice generation fast and pleasant, without Gradio.

<img width="2547" height="1255" alt="image" src="https://github.com/user-attachments/assets/f55f579f-5c9f-4dfd-b56c-5a3b2745330d" />

**Hear it** — a short multi-speaker demo produced entirely with the Manager:

https://github.com/user-attachments/assets/69f211b9-c8ae-49dd-a050-cddcd7ee8bdf

OmniVoice generates a single utterance per call. The Manager wraps it with everything needed to turn that primitive into finished audio: multi-speaker dialogue stitching, reference-audio cleanup, perceptual loudness matching, an AI scriptwriter, a rich audio editor, and a clean API for automation.

---

## Highlights

### A real studio UI (React + Vite + TypeScript)
A fast single-page app served directly by the backend — no Gradio, no page reloads, no awkward component churn. Live job progress, persistent history, and a voice library are all first-class.

### Multi-speaker dialogue, beyond the base model
OmniVoice synthesizes one voice at a time. The Manager parses `Speaker N:` scripts, assigns a distinct voice (cloned, designed, or auto) to each speaker, generates line by line, and stitches everything into one continuous track — with no hard cap on speaker count. Add or remove speakers dynamically (N+).

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
  worker.py         child process: TTS, isolation, de-reverb, loudness, stitching
  scripts_ai.py     Smart Script writer (multi-provider, robust parsing)
  vocal_isolation/  Mel-Band-RoFormer port + DeepFilterNet integration
  audio_utils.py    LUFS matching, true-peak limiting, normalization
omnivoice/  Upstream OmniVoice model + inference package
```

All GPU work runs in a dedicated child process. This isolates the CUDA context, makes LOD-style VRAM reclamation reliable (the process is terminated to release memory), and keeps the API responsive.

---

## Requirements

- An NVIDIA GPU with CUDA (CPU works but is slow)
- Python 3.10+
- Node.js 18+ (only to build the web UI)
- [`uv`](https://github.com/astral-sh/uv) for Python dependency management

---

## Installation

```bash
git clone <your-repo-url> OmniVoice
cd OmniVoice

# Python environment + dependencies
uv sync --python 3.10

# Optional: DeepFilterNet de-reverb backend
uv sync --extra dereverb

# Build the web UI
cd web && npm install && npm run build && cd ..
```

Model weights for OmniVoice, the vocal isolation checkpoint, and (when used) Whisper are downloaded automatically on first use into `./models` and the Hugging Face cache.

---

## Configuration

Copy the template and add your keys:

```bash
cp .env_sample .env
```

Declare one AI provider per line:

```
AI_PROVIDER_<ID> = Label | model | base_url (blank = official OpenAI) | api_key
```

Comment a line out to hide that provider. After editing `.env`, click **Refresh** next to the provider picker in the UI to reload — no restart needed. The Smart Script writer is optional; everything else works without an AI key.

---

## Running

```bash
./run_manager.sh
```

The script builds the UI on first run and serves the app at `http://localhost:8200`.

Run the backend directly for more control:

```bash
.venv/bin/omnivoice-manager --port 8200 [options]
```

| Flag | Description |
| --- | --- |
| `--port` / `--host` | Bind address (default `8200` / `0.0.0.0`) |
| `--model` | Model id (default `k2-fsa/OmniVoice`) |
| `--device` | e.g. `cuda:0` |
| `--lod` | Load the model on demand and free VRAM after each job |
| `--eager` | Load the model at startup |
| `--preload-asr` | Preload Whisper (otherwise it loads only when transcribing a reference) |

LOD and Low VRAM mode can also be toggled live from the top bar in the UI.

---

## Using the UI

- **Studio** — write or AI-generate a script, configure speakers (clone / design / auto), set generation and loudness options, and generate. Watch per-stage progress and edit the result in the player.
- **Voice Lab** — upload or pick a reference, preview isolation / de-reverb / normalization, and save the cleaned voice to your library.
- **History & Outputs** — replay, download, or fully restore any past generation.

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
| `POST /api/generate/script-and-speak` | Smart Script **and** synthesis in one call |
| `GET /api/jobs/{job_id}` | Poll job status / result |
| `GET /api/voices` · `POST /api/voices/upload` · `POST /api/voices/process` | Voice library + Voice Lab |
| `GET /api/outputs` · `GET /api/history` | Browse results and history |

Generation is asynchronous: submit to `/api/generate`, then poll `/api/jobs/{job_id}` until `status` is `done`.

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
