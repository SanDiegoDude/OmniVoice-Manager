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
  title via any OpenAI-compatible API **or Google Vertex AI**; declare multiple
  providers in `.env` and hot-swap them in the UI.
- **Persistent history** of prompts, scripts and generations (JSON on disk).
- **LOD (Load-On-Demand) mode** — the model runs in a child process that is
  killed after each job to free all VRAM (mirrors VibeVoice `--lod`).
- **API mode** for external automation (e.g. a ComfyUI connector) that exposes
  the *full smart-script pipeline*, not just raw TTS.

## Setup

The environment is managed with `uv`. From the repo root:

```bash
uv sync                 # install OmniVoice + manager deps
cp .env_sample .env     # optional: configure AI script-writer providers
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
| `--preload-asr` | Preload Whisper (otherwise it loads on first transcription) |
| `--device auto` | Select device (`auto` picks CUDA > MPS > CPU; or pin `cuda:0` / `mps` / `cpu`) |
| `--model k2-fsa/OmniVoice` | Model id or local path |
| `--ssl` | Serve self-signed HTTPS (required for mic capture from other machines) |

The `run_manager.sh` / `run_manager.bat` launchers also accept `--rebuild`
(force a fresh web UI build) and `--forceup` (kill a stale server on the port);
all other flags pass straight through to the server.

### UI dev mode (hot reload)

```bash
uv run omnivoice-manager --port 8200      # backend
cd web && npm run dev                      # Vite on :5173, proxies /api
```

## Configuration (`.env`)

The AI script-writer is **optional** — every other feature works without it.
Declare one provider per line; comment a line out to hide it. After editing
`.env`, click **Refresh** next to the provider picker in the UI (no restart):

```
AI_PROVIDER_<ID> = Label | model | base_url (blank = official OpenAI) | api_key
```

```ini
AI_PROVIDER_OPENAI = OpenAI        | gpt-4o-mini       |                                   | sk-...
AI_PROVIDER_GEMINI = Gemini (OAI)  | gemini-2.5-flash  | https://generativelanguage.googleapis.com/v1beta/openai/ | AI...
AI_PROVIDER_LOCAL  = Local LLM     | llama-3.1-8b      | http://localhost:1234/v1          | not-needed
```

**Google Vertex AI** (for Vertex-only Gemini access) uses a `vertex://` base URL
and Google Cloud credentials instead of an inline key:

```ini
AI_PROVIDER_VERTEX = Gemini · Vertex | gemini-2.5-flash | vertex://my-gcp-project-id/global |
```

Authenticate with Application Default Credentials — install the
[gcloud CLI](https://cloud.google.com/sdk/docs/install) and run
`gcloud auth application-default login` once (the account needs the **Vertex AI
User** role) — or pass a service-account JSON path in the fourth field. The
Manager also auto-registers a Vertex provider from the standard
`GENAI_BACKEND=vertex` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`
environment variables. See the [root README](../README.md#google-vertex-ai-gemini)
for the full walkthrough.

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
| DELETE/POST | `/api/outputs/{file}[/rename]` | delete / rename an output file |
| GET | `/api/projects` | list re-openable projects (multitrack sessions) |
| POST | `/api/multitrack/{sid}/{open,rename,undo,redo}` | re-open / rename / multi-step undo / redo |
| GET | `/api/multitrack/{sid}/{history,export,export-stems,assets}` | action-history steps, self-contained `.omvp` bundle, FLAC stems, asset inventory |
| POST | `/api/multitrack/{sid}/plugin-data` | 3rd-party plug-in persistence hook (stored with the scene, travels in the bundle) |
| POST | `/api/projects/import` | import an `.omvp` bundle → `{session, import_report}` (missing voices it can add to the library) |
| POST | `/api/projects/{sid}/import-voices` | add a bundle's missing voices to the library and relink the project |
| GET/DELETE | `/api/history[/{id}]` | smart-script draft history CRUD |
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
  scripts_ai.py      smart-script via OpenAI-compatible APIs + Google Vertex AI
  sessions.py        multitrack projects: per-clip media pool, additive mix, edits
  actionhist.py      multi-step undo/redo (content-addressed snapshot ring)
  history.py         persistent JSON history (smart-script drafts)
  jobs.py            background job manager (progress polling)
  vocal_isolation/   ported Mel-Band-Roformer isolator
web/                 React + Vite + TS frontend (build → web/dist)
custom_voices/       your reference voice library
output/              generated audio
data/history/        persisted history
```
