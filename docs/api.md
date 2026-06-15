# 🔌 HTTP API

Every UI capability is also an HTTP endpoint, so you can drive the Manager from your own tools — a ComfyUI connector, a batch script, CI, anything that speaks HTTP — and not just basic synthesis. All endpoints are **JSON over HTTP** on the same host/port the UI is served from (default `http://localhost:8200`).

**Interactive, always-current reference:** open `/docs` (Swagger UI) on a running server for the live OpenAPI schema of every route, including request/response bodies. The tables below are a curated map of the routes you'll reach for most.

## System & providers

| Method & Path | Purpose |
| --- | --- |
| `GET /api/system/info` | Model, GPU, AI-provider, LOD / Low-VRAM / output-format / trim-silence status |
| `POST /api/system/lod` · `POST /api/system/low-vram` | Toggle VRAM modes (persisted) |
| `POST /api/system/output-format` · `POST /api/system/trim-silence` | Persist output format (mp3 / flac) and auto-trim silence |
| `POST /api/system/load` · `/unload` | Model lifecycle |
| `GET /api/script/providers` · `POST /api/script/reload` | List / hot-reload AI providers (OpenAI-compatible + Vertex) |

## Scripts, synthesis & jobs

| Method & Path | Purpose |
| --- | --- |
| `POST /api/script` | Generate or refine a `Speaker N:` script from a prompt |
| `POST /api/generate` | Synthesize from a script (queued; returns a job id) |
| `POST /api/generate-perform` | One-shot performance transfer: upload a take + params, render in a target voice |
| `POST /api/generate/script-and-speak` | Smart Script **and** synthesis in one call |
| `POST /api/process-clip` · `POST /api/transcribe-clip` | Isolate/de-reverb or Whisper any uploaded clip |
| `GET /api/jobs/{job_id}` | Poll job status / result |

## Voices, outputs & history

| Method & Path | Purpose |
| --- | --- |
| `GET /api/voices` · `POST /api/voices/upload` · `POST /api/voices/process` | Voice library + Voice Lab |
| `DELETE /api/voices/{id}` | Delete a voice |
| `GET /api/outputs` · `GET /api/history` | Browse results and history |
| `GET·DELETE /api/history/{id}` | Restore / delete a history entry |
| `GET /api/audio/{output\|voice\|temp}/...` | Serve audio files |

## Multitrack timeline

| Method & Path | Purpose |
| --- | --- |
| `POST /api/multitrack/generate` · `POST /api/multitrack/empty` | Generate a scene as clips, or start a blank timeline |
| `POST /api/multitrack/{sid}/speaker` · `POST·DELETE …/speaker/{pos}` | Add / update / remove a speaker track |
| `POST …/segment/{i}/regenerate` · `…/edit` · `…/text` | Regenerate, move/trim/speed/gain, or align a clip's text |
| `POST …/segment/{i}/split` · `…/duplicate` · `…/delete` · `…/auto-slice` · `…/inpaint` · `…/inpaint-preserve` | Clip operations + Pin Current Voice to Segment (and non-vocal bed) |
| `POST …/segment/{i}/transform` | Bake a vocal transform (pitch / formant / telephone / …) onto a clip (reversible) |
| `POST …/delete-space` · `…/add-space` · `…/reflow` · `…/insert` | Timeline structure + global speed/gap |
| `POST …/upload-channel` · `…/speaker/{pos}/promote` · `…/speaker/{pos}/regenerate` | Audio channels, promote-to-voice, re-cast a channel (honors per-clip performances) |
| `POST·DELETE …/segment/{i}/performance` | Attach / detach a vocal performance (multipart take + mode/strength/gain/speed) |
| `POST …/merge` · `…/speaker/{pos}/collapse` | Merge selected clips, collapse a track to one clip |
| `POST …/segment/{i}/transcribe` · `…/{sid}/undo` · `…/{sid}/finalize` | Whisper a clip, single-step undo, commit to history |

## Async vs. sync

Generation is **asynchronous**: submit to `/api/generate` (or `/api/multitrack/generate`), then poll `/api/jobs/{job_id}` until `status` is `done`. Most timeline edits are **synchronous** and return the updated session in the response.

## Smart Script → audio in one shot (ComfyUI-friendly)

`POST /api/generate/script-and-speak` runs the *full smart-script pipeline* — write the dialogue from a prompt, then synthesize it — and blocks until the audio is ready:

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
