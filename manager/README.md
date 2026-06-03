# OmniVoice Manager

A non-gradio Manager/UI + API on top of [OmniVoice](../README.md), inspired by a
VibeVoice setup but rebuilt as a modern, dynamic web app with a clean API.

## Features

- **Modern web UI** (React + Vite + TypeScript) — no gradio. Served by FastAPI on
  a single port; live progress, neat menus, dark theme.
- **Single & multi-speaker** generation. OmniVoice synthesizes one utterance per
  call, so multi-speaker "podcast" scripts (`Speaker 1:` / `Speaker 2:` …) are
  generated line-by-line per assigned voice and stitched into one track.
- **Three voice modes per speaker:** Voice **Clone** (reference audio),
  Voice **Design** (attribute chips → `instruct`), or **Auto**.
- **Voice Lab** — isolate vocals (Mel-Band-Roformer, ported from VibeVoice),
  trim silence, and boost/level loudness, then save clean references to your
  library.
- **Smart Script (AI)** — turn a freeform idea into a speaker-tagged dialogue +
  title via an OpenAI-compatible API (Gemini by default, from `.env`).
- **Persistent history** of prompts, scripts and generations (JSON on disk).
- **LOD (Load-On-Demand) mode** — the model runs in a child process that is
  killed after each job to free all VRAM (mirrors VibeVoice `--lod`).
- **API mode** for external automation (e.g. a ComfyUI connector) that exposes
  the *full smart-script pipeline*, not just raw TTS.

## Setup

The environment is managed with `uv`. From the repo root:

```bash
uv sync                 # install OmniVoice + manager deps
cp ../VibeVoice/.env .  # (already done) provides the Gemini SCRIPT_AI_* key
```

The web UI build needs Node:

```bash
cd web && npm install && npm run build
```

## Run

```bash
./run_manager.sh                 # builds the UI if needed, serves on :8200
# or
uv run omnivoice-manager --port 8200
```

Then open <http://localhost:8200>.

### Useful flags

| Flag | Meaning |
|------|---------|
| `--lod` | Load model on demand; free VRAM after each job |
| `--eager` | Load the model at startup (persistent mode) |
| `--no-asr` | Skip Whisper ASR (reference-text auto-transcription) |
| `--device cuda:0` | Select device |
| `--model k2-fsa/OmniVoice` | Model id or local path |

### UI dev mode (hot reload)

```bash
uv run omnivoice-manager --port 8200      # backend
cd web && npm run dev                      # Vite on :5173, proxies /api
```

## Configuration (`.env`)

The script-writer reads the same keys as VibeVoice:

```
SCRIPT_AI_URL=...        # OpenAI-compatible base url (Gemini shim by default)
SCRIPT_AI_MODEL=...      # e.g. gemini-2.5-flash
SCRIPT_AI_API_KEY=...    # provider key
# Fallbacks: OPENAI_API_KEY / OPENAI_MODEL
```

Optional: `OMNIVOICE_MODELS="id|label,id2|label2"` to add dropdown models,
`OMNIVOICE_MELBAND_CKPT=/path` to point at an existing isolation checkpoint.

## API (for ComfyUI / automation)

Base url: `http://<host>:8200`. All endpoints are JSON.

### Smart script → audio in one shot (recommended for ComfyUI)

`POST /api/generate/script-and-speak` — blocks until the audio is ready.

```jsonc
{
  "prompt": "Two pirates argue about whether a hotdog is a sandwich, 4 lines.",
  "num_speakers": 2,
  "speakers": {
    "1": {"mode": "design", "instruct": "male, low pitch, british accent"},
    "2": {"mode": "clone",  "voice": "personal/jonesy.wav"}
  },
  "params": {"num_step": 32, "guidance_scale": 2.0, "speed": 1.0, "gap_ms": 250},
  "save": true
}
```

Response:

```jsonc
{
  "title": "The Great Hotdog Debate",
  "script": "Speaker 1: ...\nSpeaker 2: ...",
  "duration_s": 12.4,
  "filename": "20260602-...wav",
  "audio_url": "/api/audio/output/20260602-...wav"
}
```

### Other endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/system/info` | model/GPU/script-AI status |
| POST | `/api/system/load` / `/unload` / `/lod` | model lifecycle |
| GET | `/api/voices` | voice library tree + flat list |
| POST | `/api/voices/upload` | upload a reference sample (multipart) |
| POST | `/api/voices/preview` | process & preview (isolate/trim/normalize/gain) |
| POST | `/api/voices/process` | process & save a clean voice |
| DELETE | `/api/voices/{id}` | delete a voice |
| POST | `/api/script` | smart-script only (returns title + script) |
| POST | `/api/generate` | start a generation job → `{job_id}` |
| GET | `/api/jobs/{id}` | poll job status/progress/result |
| GET | `/api/outputs` | list generated audio |
| GET/DELETE | `/api/history[/{id}]` | history CRUD |
| GET | `/api/audio/{output\|voice\|temp}/...` | serve audio |

Interactive docs at `/docs`.

## Layout

```
manager/
  server.py          FastAPI app + routes + SPA serving
  model_manager.py   worker lifecycle (persistent / LOD), GPU info
  worker.py          child process: OmniVoice TTS + isolation (all CUDA work)
  generation.py      script parsing (Speaker N: → lines)
  service.py         payload building + output saving
  voices.py          voice library scanning/saving
  audio_utils.py     load / isolate-glue / RMS boost / trim / save
  scripts_ai.py      smart-script via OpenAI-compatible API (Gemini)
  history.py         persistent JSON history
  jobs.py            background job manager (progress polling)
  vocal_isolation/   ported Mel-Band-Roformer isolator
web/                 React + Vite + TS frontend (build → web/dist)
custom_voices/       your reference voice library
output/              generated audio
data/history/        persisted history
```
