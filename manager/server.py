"""FastAPI server for the OmniVoice Manager.

Serves the React SPA (from web/dist) and a JSON API used by both the UI and
external automation (e.g. a ComfyUI connector). The API exposes the full smart
script pipeline, not just raw TTS.
"""

from __future__ import annotations

import argparse
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import history, scripts_ai, service, voices
from .audio_utils import (
    apply_gain_db,
    duration_seconds,
    load_audio,
    normalize_rms,
    peak_normalize,
    save_wav,
    trim_silence,
)
from .config import (
    DATA_DIR,
    OUTPUT_DIR,
    WEB_DIST_DIR,
    active_provider,
    get_active_provider_id,
    list_available_models,
    list_providers_public,
    reload_env,
    set_active_provider,
    settings,
)
from .jobs import JobManager
from .model_manager import ModelManager, query_gpu_memory
from .schemas import (
    GenerateRequest,
    LoadModelRequest,
    ProcessVoiceRequest,
    ScriptAndSpeakRequest,
    ScriptRequest,
)

TMP_DIR = DATA_DIR / "tmp"
TMP_DIR.mkdir(parents=True, exist_ok=True)

model_manager = ModelManager(settings)
job_manager = JobManager()

app = FastAPI(title="OmniVoice Manager", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------
@app.get("/api/system/info")
def system_info():
    info = model_manager.info()
    info["available_models"] = list_available_models()
    ap = active_provider()
    info["script_ai"] = {
        "model": ap["model"] if ap else None,
        "label": ap["label"] if ap else None,
        "configured": ap is not None,
        "endpoint": ap["endpoint"] if ap else None,
        "active_provider": ap["id"] if ap else None,
    }
    return info


# ---------------------------------------------------------------------------
# Script AI providers
# ---------------------------------------------------------------------------
@app.get("/api/script/providers")
def script_providers():
    return {"providers": list_providers_public(), "active": get_active_provider_id()}


@app.post("/api/script/providers/select")
def script_select_provider(payload: dict):
    pid = (payload or {}).get("id")
    if not set_active_provider(pid):
        raise HTTPException(404, f"Unknown provider: {pid}")
    return {"providers": list_providers_public(), "active": get_active_provider_id()}


@app.post("/api/script/reload")
def script_reload():
    reload_env()
    return {"providers": list_providers_public(), "active": get_active_provider_id()}


@app.get("/api/system/models")
def system_models():
    return {"models": list_available_models(), "current": model_manager.info()["model_id"]}


@app.post("/api/system/load")
def system_load(req: LoadModelRequest):
    if req.load_on_demand is not None:
        settings.load_on_demand = req.load_on_demand
    if req.model_id and req.model_id != model_manager.info()["model_id"]:
        model_manager.switch_model(req.model_id)
    if not settings.load_on_demand:
        model_manager.warmup()
    return model_manager.info()


@app.post("/api/system/unload")
def system_unload():
    model_manager.unload()
    return model_manager.info()


@app.post("/api/system/lod")
def system_lod(payload: dict):
    enabled = bool(payload.get("enabled", False))
    settings.load_on_demand = enabled
    if enabled:
        model_manager.unload()
    return model_manager.info()


@app.post("/api/system/low-vram")
def system_low_vram(payload: dict):
    settings.low_vram = bool(payload.get("enabled", False))
    return model_manager.info()


# ---------------------------------------------------------------------------
# Voices
# ---------------------------------------------------------------------------
@app.get("/api/voices")
def get_voices():
    return {"tree": voices.voice_tree(), "flat": voices.list_voices()}


@app.delete("/api/voices/{voice_id:path}")
def del_voice(voice_id: str):
    try:
        voices.delete_voice(voice_id)
    except FileNotFoundError:
        raise HTTPException(404, "Voice not found")
    return {"ok": True}


@app.post("/api/voices/upload")
async def upload_voice(file: UploadFile = File(...)):
    suffix = Path(file.filename or "upload.wav").suffix or ".wav"
    upload_id = f"{uuid.uuid4().hex}{suffix}"
    dest = TMP_DIR / upload_id
    dest.write_bytes(await file.read())
    try:
        audio = load_audio(dest)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read audio: {e}")
    return {
        "upload_id": upload_id,
        "duration_s": duration_seconds(audio),
        "audio_url": f"/api/audio/temp/{upload_id}",
    }


def _load_process_source(source: str, is_upload: bool) -> np.ndarray:
    if is_upload:
        path = TMP_DIR / source
        if not path.exists():
            raise HTTPException(404, "Upload not found")
        return load_audio(path)
    try:
        return voices.load_voice_audio(source)
    except FileNotFoundError:
        raise HTTPException(404, "Voice not found")


def _process_audio(
    audio: np.ndarray,
    isolate: bool,
    trim: bool,
    normalize: bool,
    gain_db: float,
    dereverb: bool = False,
    dereverb_method: str = "roformer",
    progress_cb=None,
) -> np.ndarray:
    if isolate:
        res = model_manager.isolate({"waveform": audio, "sample_rate": 24000}, progress_cb=progress_cb)
        audio = np.asarray(res["waveform"], dtype=np.float32)
    if dereverb:
        res = model_manager.dereverb(
            {"waveform": audio, "sample_rate": 24000, "method": dereverb_method}, progress_cb=progress_cb
        )
        audio = np.asarray(res["waveform"], dtype=np.float32)
    if trim:
        audio = trim_silence(audio)
    if normalize:
        audio = normalize_rms(audio)
    if gain_db:
        audio = apply_gain_db(audio, gain_db)
    return peak_normalize(audio, 0.98)


@app.post("/api/voices/preview")
def preview_voice(req: ProcessVoiceRequest):
    audio = _load_process_source(req.source, req.is_upload)
    processed = _process_audio(
        audio, req.isolate, req.trim, req.normalize, req.gain_db, req.dereverb, req.dereverb_method
    )
    name = f"_preview_{uuid.uuid4().hex}.wav"
    save_wav(TMP_DIR / name, processed)
    return {"audio_url": f"/api/audio/temp/{name}", "duration_s": duration_seconds(processed)}


@app.post("/api/voices/process")
def process_voice(req: ProcessVoiceRequest):
    audio = _load_process_source(req.source, req.is_upload)
    processed = _process_audio(
        audio, req.isolate, req.trim, req.normalize, req.gain_db, req.dereverb, req.dereverb_method
    )
    descriptor = voices.save_voice(req.save_as, processed)
    return descriptor


# ---------------------------------------------------------------------------
# Smart script
# ---------------------------------------------------------------------------
@app.post("/api/script")
def make_script(req: ScriptRequest):
    try:
        result = scripts_ai.generate_script(
            prompt=req.prompt,
            num_speakers=req.num_speakers,
            speakers=req.speakers,
            existing_script=req.existing_script,
            previous=req.previous,
            temperature=req.temperature,
            provider_id=req.provider_id,
        )
    except scripts_ai.ScriptAIError as e:
        raise HTTPException(400, str(e))
    history.add_entry(
        {
            "type": "script",
            "title": result["title"],
            "prompt": req.prompt,
            "script": result["script"],
            "num_speakers": req.num_speakers,
            "model": result["model"],
        }
    )
    return result


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------
@app.post("/api/generate")
def generate(req: GenerateRequest):
    title = req.title or "Untitled Scene"
    try:
        job_fn = service.make_generation_job(model_manager, req, title)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    job_id = job_manager.submit(job_fn, meta={"title": title})
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.post("/api/generate/script-and-speak")
def script_and_speak(req: ScriptAndSpeakRequest):
    """One-shot: smart-script -> multi-speaker audio. Blocks until done.

    Intended for external automation (ComfyUI). Returns the script, title and a
    URL to the generated audio.
    """
    speaker_hints = []
    for i in range(1, req.num_speakers + 1):
        cfg = req.speakers.get(str(i))
        if cfg:
            speaker_hints.append(
                {"name": cfg.voice, "instruct": cfg.instruct, "voice": cfg.voice}
            )
    try:
        script_result = scripts_ai.generate_script(
            prompt=req.prompt,
            num_speakers=req.num_speakers,
            speakers=speaker_hints or None,
            temperature=req.temperature,
            provider_id=req.provider_id,
        )
    except scripts_ai.ScriptAIError as e:
        raise HTTPException(400, str(e))

    gen_req = GenerateRequest(
        script=script_result["script"],
        multi_speaker=req.num_speakers > 1,
        num_speakers=req.num_speakers,
        speakers=req.speakers,
        params=req.params,
        title=script_result["title"],
        save=req.save,
    )
    try:
        payload = service.build_generation_payload(gen_req)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))

    result = model_manager.generate(payload)
    audio = np.asarray(result["waveform"], dtype=np.float32)
    sr = int(result["sample_rate"])
    out = {
        "title": script_result["title"],
        "script": script_result["script"],
        "duration_s": duration_seconds(audio, sr),
    }
    if req.save:
        saved = service.save_output(audio, sr, script_result["title"], req.num_speakers)
        out.update(saved)
        history.add_entry(
            {
                "type": "generation",
                "title": script_result["title"],
                "script": script_result["script"],
                "num_speakers": req.num_speakers,
                "filename": saved["filename"],
                "audio_url": saved["audio_url"],
                "prompt": req.prompt,
            }
        )
    return out


@app.get("/api/outputs")
def get_outputs():
    return {"outputs": service.list_outputs()}


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------
@app.get("/api/history")
def get_history(kind: Optional[str] = None):
    return {"entries": history.list_entries(kind=kind)}


@app.get("/api/history/{entry_id}")
def get_history_entry(entry_id: str):
    entry = history.get_entry(entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    return entry


@app.delete("/api/history/{entry_id}")
def del_history_entry(entry_id: str):
    if not history.delete_entry(entry_id):
        raise HTTPException(404, "Entry not found")
    return {"ok": True}


@app.post("/api/history/clear")
def clear_history(payload: dict | None = None):
    kind = (payload or {}).get("kind")
    history.clear(kind=kind)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Audio serving
# ---------------------------------------------------------------------------
@app.get("/api/audio/output/{filename}")
def audio_output(filename: str):
    path = (OUTPUT_DIR / filename).resolve()
    if OUTPUT_DIR.resolve() not in path.parents or not path.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/audio/temp/{filename}")
def audio_temp(filename: str):
    path = (TMP_DIR / filename).resolve()
    if TMP_DIR.resolve() not in path.parents or not path.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/audio/voice/{voice_id:path}")
def audio_voice(voice_id: str):
    try:
        path = voices.resolve_voice_path(voice_id)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, "Not found")
    return FileResponse(path)


# ---------------------------------------------------------------------------
# Static SPA
# ---------------------------------------------------------------------------
def _mount_spa() -> None:
    if WEB_DIST_DIR.exists() and (WEB_DIST_DIR / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(WEB_DIST_DIR), html=True), name="spa")
    else:
        @app.get("/")
        def _no_ui():
            return JSONResponse(
                {
                    "message": "OmniVoice Manager API is running. Build the web UI "
                    "(cd web && npm install && npm run build) to serve the SPA.",
                    "docs": "/docs",
                }
            )


_mount_spa()


def main() -> int:
    parser = argparse.ArgumentParser(prog="omnivoice-manager")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--model", default=settings.model_id)
    parser.add_argument("--device", default=settings.device)
    parser.add_argument("--lod", action="store_true", help="Load model on demand (free VRAM after each job).")
    parser.add_argument("--eager", action="store_true", help="Load the model at startup.")
    parser.add_argument(
        "--preload-asr",
        action="store_true",
        help="Preload Whisper ASR at startup (otherwise it loads on demand only when "
        "transcribing a reference without a transcript).",
    )
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    settings.host = args.host
    settings.port = args.port
    settings.model_id = args.model
    settings.device = args.device
    settings.load_on_demand = args.lod
    settings.eager_load = args.eager
    settings.load_asr = args.preload_asr
    settings.debug = args.debug
    model_manager._current_model = args.model

    if settings.eager_load and not settings.load_on_demand:
        print("Eager-loading model ...", flush=True)
        try:
            model_manager.warmup()
        except Exception as e:  # noqa: BLE001
            print(f"Warmup failed: {e}", flush=True)

    import uvicorn

    print(f"OmniVoice Manager on http://{settings.host}:{settings.port}  (LOD={settings.load_on_demand})", flush=True)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
