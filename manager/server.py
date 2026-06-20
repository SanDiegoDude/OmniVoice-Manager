"""FastAPI server for the OmniVoice Manager.

Serves the React SPA (from web/dist) and a JSON API used by both the UI and
external automation (e.g. a ComfyUI connector). The API exposes the full smart
script pipeline, not just raw TTS.
"""

from __future__ import annotations

import argparse
import re
import time
import json
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import history, prefs, scripts_ai, sentence_slicer, service, sessions, voices
from .audio_utils import (
    VIDEO_EXTS,
    apply_gain_db,
    duration_seconds,
    load_audio,
    load_media_audio,
    media_type_for,
    normalize_rms,
    peak_normalize,
    save_wav,
    trim_silence,
    trim_silence_edges,
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
from .jobs import DuplicateJobError, JobManager
from .model_manager import ModelManager, query_gpu_memory
from .schemas import (
    AddSpaceRequest,
    DeleteSegmentRequest,
    DeleteSpaceRequest,
    DuplicateSegmentRequest,
    EditSegmentRequest,
    EmptySessionRequest,
    GenerateRequest,
    InpaintRequest,
    MergeSegmentsRequest,
    MoveSegmentRequest,
    ImportClipRequest,
    InsertSegmentRequest,
    LoadModelRequest,
    TrackOrderRequest,
    PromoteChannelRequest,
    ProcessVoiceRequest,
    ReflowRequest,
    RegenSegmentRequest,
    ScriptAndSpeakRequest,
    ScriptRequest,
    SegmentIsolateRequest,
    SegmentTransformRequest,
    SetChannelRequest,
    SetSegmentTextRequest,
    SpeakerConfig,
    SplitSegmentRequest,
    TranscribeSegmentRequest,
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

# Single-step undo: snapshot a session's state right before any mutating request
# touches it. Done in one place (the middleware) so every editor action — even
# multi-call ones like promote — collapses to exactly one undo step. New-session
# and non-mutating routes are skipped.
_UNDO_SKIP_SUFFIX = ("/undo", "/finalize", "/transcribe")


@app.middleware("http")
async def _undo_checkpoint(request, call_next):
    try:
        if request.method in ("POST", "DELETE"):
            parts = request.url.path.strip("/").split("/")
            if (
                len(parts) >= 4
                and parts[0] == "api"
                and parts[1] == "multitrack"
                and parts[2] not in ("generate", "empty")
                and not any(request.url.path.endswith(s) for s in _UNDO_SKIP_SUFFIX)
            ):
                sessions.checkpoint(parts[2])
    except Exception:
        pass  # never let snapshotting break the actual request
    return await call_next(request)


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
    prefs.update({"system": {"load_on_demand": enabled}})
    if enabled:
        model_manager.unload()
    return model_manager.info()


@app.post("/api/system/low-vram")
def system_low_vram(payload: dict):
    enabled = bool(payload.get("enabled", False))
    settings.low_vram = enabled
    prefs.update({"system": {"low_vram": enabled}})
    return model_manager.info()


@app.post("/api/system/trim-silence")
def system_trim_silence(payload: dict):
    """Toggle auto-trim of near-silence on generations + recordings (persisted)."""
    enabled = bool(payload.get("enabled", False))
    settings.trim_silence = enabled
    prefs.update({"system": {"trim_silence": enabled}})
    return model_manager.info()


@app.post("/api/system/auto-slice")
def system_auto_slice(payload: dict):
    """Toggle auto-slice-by-sentence on scene generation (persisted). When on, a
    follow-on phase splits every generated voice segment into one clip per
    sentence after all TTS is done (so Whisper loads once, not per clip)."""
    enabled = bool(payload.get("enabled", False))
    settings.auto_slice = enabled
    prefs.update({"system": {"auto_slice": enabled}})
    return model_manager.info()


@app.post("/api/system/output-format")
def system_output_format(payload: dict):
    """Switch finished-render encoding between compact MP3 and lossless FLAC."""
    fmt = str(payload.get("format", "") or "").lower()
    if fmt not in ("mp3", "flac", "wav"):
        raise HTTPException(400, "format must be one of: mp3, flac, wav")
    settings.output_format = fmt
    prefs.update({"output": {"format": fmt}})
    return model_manager.info()


# ---------------------------------------------------------------------------
# Preferences (persistent, namespaced settings store)
# ---------------------------------------------------------------------------
@app.get("/api/prefs")
def get_prefs():
    return prefs.load()


@app.patch("/api/prefs")
def patch_prefs(payload: dict):
    """Deep-merge a partial prefs document and persist it. Returns the full doc."""
    if not isinstance(payload, dict):
        raise HTTPException(400, "prefs patch must be an object")
    return prefs.update(payload)


# ---------------------------------------------------------------------------
# Voices
# ---------------------------------------------------------------------------
@app.get("/api/voices")
def get_voices():
    return {"tree": voices.voice_tree(), "flat": voices.list_voices(), "folders": voices.list_folders()}


@app.post("/api/voices/folder")
def create_voice_folder(payload: dict):
    """Create a new (possibly nested) folder in the voice library."""
    try:
        return voices.create_folder(str(payload.get("path", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/voices/move")
def move_voice_endpoint(payload: dict):
    """Move a voice into another library folder (root = "")."""
    try:
        return voices.move_voice(str(payload.get("id", "")), str(payload.get("folder", "")))
    except FileNotFoundError:
        raise HTTPException(404, "Voice not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/voices/rename")
def rename_voice_endpoint(payload: dict):
    """Rename a voice (base name) within its current folder."""
    try:
        return voices.rename_voice(str(payload.get("id", "")), str(payload.get("name", "")))
    except FileNotFoundError:
        raise HTTPException(404, "Voice not found")
    except ValueError as e:
        raise HTTPException(400, str(e))


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
    # Video upload: the browser player can't decode a raw container, so persist
    # the extracted audio as a WAV and serve that instead of the original file.
    if suffix.lower() in VIDEO_EXTS:
        upload_id = f"{uuid.uuid4().hex}.wav"
        save_wav(TMP_DIR / upload_id, audio)
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


def _manual_trim(audio: np.ndarray, trim_start: float, trim_end: float, sr: int = 24000) -> np.ndarray:
    """Clip the audio to the [trim_start, trim_end] window (seconds)."""
    n = len(audio)
    s = max(0, int(round(trim_start * sr)))
    e = int(round(trim_end * sr)) if trim_end and trim_end > 0 else n
    e = min(n, e)
    if e > s and (s > 0 or e < n):
        return audio[s:e]
    return audio


def _process_audio(
    audio: np.ndarray,
    isolate: bool,
    trim: bool,
    normalize: bool,
    gain_db: float,
    dereverb: bool = False,
    dereverb_method: str = "roformer",
    trim_start: float = 0.0,
    trim_end: float = 0.0,
    progress_cb=None,
) -> np.ndarray:
    audio = _manual_trim(audio, trim_start, trim_end)
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
        audio, req.isolate, req.trim, req.normalize, req.gain_db, req.dereverb, req.dereverb_method,
        req.trim_start, req.trim_end,
    )
    name = f"_preview_{uuid.uuid4().hex}.wav"
    save_wav(TMP_DIR / name, processed)
    return {"audio_url": f"/api/audio/temp/{name}", "duration_s": duration_seconds(processed)}


@app.post("/api/voices/process")
def process_voice(req: ProcessVoiceRequest):
    audio = _load_process_source(req.source, req.is_upload)
    processed = _process_audio(
        audio, req.isolate, req.trim, req.normalize, req.gain_db, req.dereverb, req.dereverb_method,
        req.trim_start, req.trim_end,
    )

    # Overwrite-in-place: save back to the selected library voice. Strip the
    # extension so save_voice writes <stem>.wav, and remove the original if it
    # was a non-wav file so we truly replace it instead of leaving a duplicate.
    if req.overwrite and not req.is_upload:
        original = req.source
        stem = original[: -len(Path(original).suffix)] if Path(original).suffix else original
        descriptor = voices.save_voice(stem, processed)
        if not original.lower().endswith(".wav") and str(descriptor["id"]) != original:
            try:
                voices.delete_voice(original)
            except Exception:  # noqa: BLE001
                pass
        return descriptor

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
            monologue=req.monologue,
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
    try:
        job_id = job_manager.submit(job_fn, meta={"title": title}, dedup_group="generate")
    except DuplicateJobError:
        raise HTTPException(409, "A generation was just started — ignoring the duplicate click.")
    return {"job_id": job_id}


@app.post("/api/generate-perform")
async def generate_perform(file: UploadFile = File(...), payload: str = Form(...)):
    """One-shot performance-guided generation (Voice Clone tab): render the text
    in the configured voice, riding the uploaded take's timing and delivery."""
    from .audio_utils import time_stretch

    data = json.loads(payload)
    perf_cfg = data.pop("perform", None) or {}
    req = GenerateRequest(**data)
    title = req.title or "Untitled Take"

    raw = await file.read()
    tmp = TMP_DIR / f"vperf_{uuid.uuid4().hex}.bin"
    tmp.write_bytes(raw)
    try:
        wav = load_audio(tmp, sr=24000)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read take audio: {e}")
    finally:
        tmp.unlink(missing_ok=True)

    gain = float(perf_cfg.get("gain_db", 0.0) or 0.0)
    if abs(gain) > 1e-3:
        wav = np.clip(wav * (10.0 ** (gain / 20.0)), -1.0, 1.0).astype(np.float32)
    from .voice_transforms import apply_transforms, auto_pitch_shift, has_effect

    tf = dict(perf_cfg.get("transforms") or {})
    if perf_cfg.get("auto_pitch"):
        from . import voices as _voices

        voice_id = next(
            (s.voice for s in req.speakers.values() if s.mode == "clone" and s.voice), None
        )
        if voice_id:
            try:
                shift = auto_pitch_shift(wav, 24000, str(_voices.resolve_voice_path(voice_id)))
                if abs(shift) > 1e-3:
                    tf["pitch"] = float(tf.get("pitch", 0.0)) + shift
            except (FileNotFoundError, ValueError):
                pass
    if tf and has_effect(tf):
        wav = apply_transforms(wav, 24000, tf)
    speed = float(perf_cfg.get("speed", 1.0) or 1.0)
    if abs(speed - 1.0) > 1e-3:
        wav = time_stretch(wav, speed)
    perform = {
        "waveform": wav,
        "sample_rate": 24000,
        "mode": str(perf_cfg.get("mode", "character")),
        "strength": int(perf_cfg.get("strength", 3)),
        "seed": perf_cfg.get("seed"),
    }
    try:
        job_fn = service.make_generation_job(model_manager, req, title, perform=perform)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    try:
        job_id = job_manager.submit(job_fn, meta={"title": title}, dedup_group="generate")
    except DuplicateJobError:
        raise HTTPException(409, "A generation was just started — ignoring the duplicate click.")
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.post("/api/multitrack/generate")
def multitrack_generate(req: GenerateRequest):
    """Generate a scene as individual, regenerable segments (multitrack editor)."""
    title = req.title or "Untitled Scene"
    try:
        job_fn = service.make_multitrack_job(model_manager, req, title)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    try:
        job_id = job_manager.submit(job_fn, meta={"title": title, "multitrack": True}, dedup_group="generate")
    except DuplicateJobError:
        raise HTTPException(409, "A generation was just started — ignoring the duplicate click.")
    return {"job_id": job_id}


@app.post("/api/multitrack/empty")
def multitrack_empty(req: EmptySessionRequest):
    """Create a blank timeline to compose by hand."""
    speakers_cfg = {k: v.model_dump() for k, v in req.speakers.items()}
    return sessions.create_empty(
        title=req.title or "Untitled Scene",
        speakers_cfg=speakers_cfg,
        params=req.params.model_dump(),
        gap_ms=req.params.gap_ms,
    )


@app.get("/api/multitrack/{sid}")
def multitrack_get(sid: str):
    session = sessions.get(sid)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


@app.delete("/api/multitrack/{sid}")
def multitrack_discard(sid: str):
    sessions.discard(sid)
    return {"ok": True}


@app.post("/api/multitrack/{sid}/undo")
def multitrack_undo(sid: str):
    """Restore the single last checkpoint (one step back)."""
    try:
        return sessions.undo(sid)
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/speaker")
def multitrack_add_speaker(sid: str, cfg: SpeakerConfig):
    try:
        return sessions.add_speaker(sid, cfg.model_dump())
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/speaker/{pos}")
def multitrack_update_speaker(sid: str, pos: str, cfg: SpeakerConfig):
    try:
        return sessions.update_speaker(sid, pos, cfg.model_dump())
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.delete("/api/multitrack/{sid}/speaker/{pos}")
def multitrack_remove_speaker(sid: str, pos: str):
    try:
        return sessions.remove_speaker(sid, pos)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/delete")
def multitrack_delete_segment(sid: str, index: int, req: Optional[DeleteSegmentRequest] = None):
    try:
        return sessions.delete_segment(sid, index, ripple=bool(req and req.ripple))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/split")
def multitrack_split_segment(sid: str, index: int, req: SplitSegmentRequest):
    try:
        return sessions.split_segment(sid, index, req.at_s)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/delete-space")
def multitrack_delete_space(sid: str, req: DeleteSpaceRequest):
    try:
        return sessions.delete_space(sid, req.start_s, req.amount)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/add-space")
def multitrack_add_space(sid: str, req: AddSpaceRequest):
    try:
        return sessions.add_space(sid, req.start_s, req.amount)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/duplicate")
def multitrack_duplicate_segment(sid: str, index: int, req: DuplicateSegmentRequest):
    try:
        return sessions.duplicate_segment(sid, index, req.start_s, req.ripple, req.speaker_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/transcribe")
def multitrack_transcribe_segment(sid: str, index: int, req: TranscribeSegmentRequest | None = None):
    """Whisper-transcribe a segment's audio (optionally an unsaved trim draft)."""
    overrides = None
    if req is not None:
        overrides = {
            "trim_start_s": req.trim_start_s,
            "trim_end_s": req.trim_end_s,
            "speed": req.speed,
        }
        overrides = {k: v for k, v in overrides.items() if v is not None} or None
    try:
        audio, sr, _name, _start = sessions.render_segment(sid, index, overrides)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    res = model_manager.transcribe({"waveform": audio, "sample_rate": sr})
    return {"text": (res.get("text") or "").strip()}


@app.post("/api/multitrack/{sid}/segment/{index}/auto-slice")
def multitrack_auto_slice(sid: str, index: int):
    """Auto-split a segment into one clip per sentence using Whisper timestamps."""
    try:
        sliced = sentence_slicer.slice_segment(model_manager, sid, index)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    if not sliced:
        raise HTTPException(400, "Couldn't detect multiple sentences in this segment.")
    session = sessions.get(sid)
    if session is None:
        raise HTTPException(404, "Session not found")
    return session


@app.post("/api/multitrack/{sid}/bulk-slice")
def multitrack_bulk_slice(sid: str):
    """Sentence-slice EVERY voice track in a scene as one heavy background job
    (uploaded audio channels are left alone). Returns a job id to poll."""
    if sessions.get(sid) is None:
        raise HTTPException(404, "Session not found")
    job_fn = service.make_bulk_slice_job(model_manager, sid)
    try:
        job_id = job_manager.submit(
            job_fn, meta={"multitrack": True, "bulk_slice": True}, dedup_group="bulk-slice"
        )
    except DuplicateJobError:
        raise HTTPException(409, "A bulk slice was just started — ignoring the duplicate click.")
    return {"job_id": job_id}


def _prep_clone_audio(audio: np.ndarray, sr: int, target_s: float = 15.0, max_s: float = 16.5) -> np.ndarray:
    """Bound a clone source to a clean ~15s window, cutting on word boundaries so
    we never end mid-word (which makes the model hallucinate). Short clips pass
    through untouched (the worker still isolates/normalizes them on cold build)."""
    total = len(audio) / float(max(sr, 1))
    if total <= max_s:
        return np.asarray(audio, dtype=np.float32)
    res = model_manager.transcribe({"waveform": audio, "sample_rate": sr, "chunks": True})
    words = [w for w in (res.get("chunks") or []) if w.get("start") is not None and w.get("end") is not None]
    if not words:
        n = max(1, int(min(total, target_s) * sr))
        return np.asarray(audio[:n], dtype=np.float32)
    s0 = max(0.0, float(words[0]["start"]))
    end = float(words[0]["end"])
    for w in words:
        we = float(w["end"])
        if we - s0 <= max_s:
            end = we
        else:
            break
    clip = audio[int(s0 * sr) : int(end * sr)]
    return np.asarray(clip if clip.size else audio, dtype=np.float32)


@app.post("/api/multitrack/{sid}/segment/{index}/inpaint")
def multitrack_inpaint(sid: str, index: int, req: InpaintRequest):
    """Lock/unlock a segment's own audio as a per-segment ADR clone (Vocal Inpaint).

    On lock we isolate the clip once: the clean vocal becomes the clone source
    (so regen skips re-isolating) and the residual is kept as a non-vocal bed for
    the optional "Preserve non-vocal" mix. If isolation is unavailable we fall
    back to the raw source (clone cold-builds its own isolation; no bed)."""
    try:
        if not req.enabled:
            return sessions.set_inpaint(sid, index, False)
        audio, sr = sessions.clone_source(sid, index)
        bed = None
        pre_cleaned = False
        voice = audio
        try:
            iso = model_manager.isolate({"waveform": audio, "sample_rate": sr})
            vocals = np.asarray(iso["waveform"], dtype=np.float32)
            n = min(len(vocals), len(audio))
            if n > 0:
                bed = (np.asarray(audio, dtype=np.float32)[:n] - vocals[:n]).astype(np.float32)
                voice = vocals
                pre_cleaned = True
        except Exception:
            pass  # isolation unavailable — fall back to raw source, no bed
        prepped = _prep_clone_audio(voice, sr)
        return sessions.set_inpaint(sid, index, True, prepped, sr, bed=bed, pre_cleaned=pre_cleaned)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/inpaint-preserve")
def multitrack_inpaint_preserve(sid: str, index: int, req: InpaintRequest):
    """Toggle re-adding the captured non-vocal bed when an inpainted clip regens."""
    try:
        return sessions.set_preserve_nonvocal(sid, index, req.enabled)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/transform")
def multitrack_segment_transform(sid: str, index: int, req: SegmentTransformRequest):
    """Bake creative vocal transforms onto an existing segment's audio (pitch,
    formant, growl, robot, telephone…). Reversible: a no-op transform restores
    the clip's original audio. Covered by the standard single-step undo."""
    try:
        return sessions.apply_segment_transform(sid, index, req.transforms)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/isolate")
def multitrack_segment_isolate(sid: str, index: int, req: SegmentIsolateRequest):
    """Replace a segment's audio with an isolated stem — just the voice, or just
    the instrumental/background — using the RoFormer separator (the same model
    that cleans references; it emits both stems, we keep the one you pick).
    Destructive but covered by the standard single-step undo."""
    stem = "instrumental" if str(req.stem).lower().startswith("inst") else "vocals"
    try:
        audio, sr = sessions.segment_full_audio(sid, index)
        if audio.size == 0:
            raise HTTPException(400, "Segment has no audio to isolate.")
        iso = model_manager.isolate({"waveform": audio, "sample_rate": sr, "stem": stem})
        wav = np.asarray(iso["waveform"], dtype=np.float32)
        return sessions.apply_segment_isolate(sid, index, wav, sr, stem)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/performance")
async def multitrack_set_performance(
    sid: str,
    index: int,
    file: UploadFile | None = File(None),
    gain_db: float = Form(0.0),
    speed: float = Form(1.0),
    mode: str = Form("character"),
    strength: int = Form(3),
    text: str = Form(""),
    transforms: str = Form(""),
    auto_pitch: bool = Form(False),
    clean_isolate: bool = Form(False),
    clean_dereverb: bool = Form(False),
):
    """Attach a recorded vocal performance to a segment (V2V mode). With a file
    the take is (re)stored; without one, only the params update."""
    tf = None
    if transforms.strip():
        try:
            tf = json.loads(transforms)
        except json.JSONDecodeError:
            raise HTTPException(400, "Invalid transforms payload")
    wav = None
    in_sr = None
    if file is not None:
        import librosa

        data = await file.read()
        tmp = TMP_DIR / f"perform_{uuid.uuid4().hex}.bin"
        tmp.write_bytes(data)
        try:
            wav, in_sr = librosa.load(str(tmp), sr=None, mono=True)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"Could not read audio: {e}")
        finally:
            tmp.unlink(missing_ok=True)
        if len(wav) < 2400:  # < 0.1 s — junk recording
            raise HTTPException(400, "Recording is too short.")
    try:
        return sessions.set_performance(
            sid, index, wav, int(in_sr) if in_sr else None,
            gain_db=gain_db, speed=speed, mode=mode, strength=strength,
            text=text or None, transforms=tf, auto_pitch=auto_pitch,
            clean_isolate=clean_isolate, clean_dereverb=clean_dereverb,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/multitrack/{sid}/segment/{index}/performance")
def multitrack_clear_performance(sid: str, index: int):
    """Detach a segment's vocal performance (back to plain TTS regen)."""
    try:
        return sessions.clear_performance(sid, index)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/process-clip")
async def process_clip(
    file: UploadFile = File(...),
    isolate: bool = Form(False),
    dereverb: bool = Form(False),
    dereverb_method: str = Form("roformer"),
    trim: bool = Form(False),
):
    """Clean an arbitrary clip (vocal isolation / dereverb / silence trim) and
    return the processed WAV — used by the performance modal's input-cleanup
    toggles and the global auto-trim setting for recorded takes."""
    import librosa

    data = await file.read()
    tmp = TMP_DIR / f"pclip_{uuid.uuid4().hex}.bin"
    tmp.write_bytes(data)
    try:
        wav, in_sr = librosa.load(str(tmp), sr=None, mono=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read audio: {e}")
    finally:
        tmp.unlink(missing_ok=True)
    sr = int(in_sr)
    if isolate:
        wav = np.asarray(model_manager.isolate({"waveform": wav, "sample_rate": sr})["waveform"], dtype=np.float32)
    if dereverb:
        res = model_manager.dereverb(
            {"waveform": wav, "sample_rate": sr, "method": dereverb_method}
        )
        wav = np.asarray(res["waveform"], dtype=np.float32)
    if trim:
        # Dead-air kill on the take itself (head/tail), so the seed + whisper +
        # stored take all start tight without the user hand-trimming.
        wav = trim_silence_edges(np.asarray(wav, dtype=np.float32), sr)
    out = TMP_DIR / f"pclip_{uuid.uuid4().hex}.wav"
    save_wav(out, np.asarray(wav, dtype=np.float32), sr)
    return FileResponse(str(out), media_type="audio/wav", filename="processed.wav")


@app.post("/api/perform/transform-clip")
async def perform_transform_clip(
    file: UploadFile = File(...),
    transforms: str = Form(""),
    auto_pitch: bool = Form(False),
    voice: str = Form(""),
    persist: bool = Form(False),
    title: str = Form("transformed"),
):
    """Apply the vocal transforms (+ optional auto pitch-match to a target voice)
    to a clip and bake the result onto the audio.

    Two modes:
      - default: stream the reshaped WAV back (the take "Apply" — bake the modulated
        audio straight onto the main take player).
      - persist=true: save the reshaped audio into the outputs directory like a normal
        render and return its descriptor, so the modulated *output* is a first-class
        output file — importable to ADR Studio, usable as a redub, and savable."""
    import librosa

    from .voice_transforms import apply_transforms, auto_pitch_shift, has_effect

    tf: dict = {}
    if transforms.strip():
        try:
            tf = json.loads(transforms) or {}
        except json.JSONDecodeError:
            raise HTTPException(400, "Invalid transforms payload")

    data = await file.read()
    tmp = TMP_DIR / f"xform_{uuid.uuid4().hex}.bin"
    tmp.write_bytes(data)
    try:
        wav, in_sr = librosa.load(str(tmp), sr=24000, mono=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read audio: {e}")
    finally:
        tmp.unlink(missing_ok=True)

    if auto_pitch and voice.strip():
        from . import voices as voices_mod

        try:
            shift = auto_pitch_shift(np.asarray(wav, dtype=np.float32), 24000, str(voices_mod.resolve_voice_path(voice)))
            if abs(shift) > 1e-3:
                tf["pitch"] = float(tf.get("pitch", 0.0)) + shift
        except (FileNotFoundError, ValueError):
            pass

    if has_effect(tf):
        wav = apply_transforms(np.asarray(wav, dtype=np.float32), 24000, tf)

    if persist:
        return service.save_output(np.asarray(wav, dtype=np.float32), 24000, title or "transformed", 1)

    out = TMP_DIR / f"xform_{uuid.uuid4().hex}.wav"
    save_wav(out, np.asarray(wav, dtype=np.float32), 24000)
    return FileResponse(str(out), media_type="audio/wav", filename="transformed.wav")


@app.post("/api/perform/stamp-output")
async def perform_stamp_output(
    file: UploadFile = File(...),
    trim_start: float = Form(0.0),
    trim_end: float = Form(0.0),
    speed: float = Form(1.0),
    title: str = Form("clone"),
):
    """Bake a trim window and/or pitch-preserving speed change into an output and
    persist it as a real output file — the Voice Clone tab's "Stamp trim" for the
    render, mirroring the take side. The stamped file is the new ground truth
    (importable / redub / save)."""
    import librosa

    from .audio_utils import time_stretch

    data = await file.read()
    tmp = TMP_DIR / f"stamp_{uuid.uuid4().hex}.bin"
    tmp.write_bytes(data)
    try:
        wav, _ = librosa.load(str(tmp), sr=24000, mono=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read audio: {e}")
    finally:
        tmp.unlink(missing_ok=True)

    wav = np.asarray(wav, dtype=np.float32)
    dur = len(wav) / 24000.0
    s = max(0.0, float(trim_start))
    e = float(trim_end) if trim_end and trim_end > s else dur
    e = min(e, dur)
    if e - s > 0.02 and (s > 0.02 or e < dur - 0.02):
        wav = wav[int(s * 24000) : int(e * 24000)]

    if abs(float(speed) - 1.0) > 1e-3:
        wav = time_stretch(wav, float(speed))

    return service.save_output(np.asarray(wav, dtype=np.float32), 24000, title or "clone", 1)


@app.post("/api/transcribe-clip")
async def transcribe_clip(file: UploadFile = File(...)):
    """Whisper-transcribe an arbitrary uploaded clip (e.g. a take being edited
    in the performance modal, before it's saved)."""
    import librosa

    data = await file.read()
    tmp = TMP_DIR / f"tclip_{uuid.uuid4().hex}.bin"
    tmp.write_bytes(data)
    try:
        wav, in_sr = librosa.load(str(tmp), sr=None, mono=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read audio: {e}")
    finally:
        tmp.unlink(missing_ok=True)
    res = model_manager.transcribe({"waveform": wav, "sample_rate": int(in_sr)})
    return {"text": (res.get("text") or "").strip()}


@app.post("/api/perform/pitch-match")
async def perform_pitch_match(file: UploadFile = File(...), voice: str = Form("")):
    """Suggest a semitone pitch shift that moves the uploaded take's median f0
    onto the target library voice's — the "auto pitch-match to target" helper for
    the vocal-transform box. The UI applies the result to the pitch slider."""
    import librosa

    from . import voices as voices_mod
    from .voice_transforms import estimate_f0_median, suggest_pitch_semitones

    if not voice.strip():
        raise HTTPException(400, "A target voice is required to pitch-match.")
    try:
        target = voices_mod.load_voice_audio(voice)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, "Target voice not found in the library.")

    data = await file.read()
    tmp = TMP_DIR / f"pmatch_{uuid.uuid4().hex}.bin"
    tmp.write_bytes(data)
    try:
        take, take_sr = librosa.load(str(tmp), sr=None, mono=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read take audio: {e}")
    finally:
        tmp.unlink(missing_ok=True)

    out = suggest_pitch_semitones(
        np.asarray(take, dtype=np.float32), int(take_sr), target, 24000
    )
    if out["take_hz"] <= 0 or out["target_hz"] <= 0:
        raise HTTPException(
            422, "Couldn't detect a clear pitch on the take and/or target voice."
        )
    return out


@app.post("/api/multitrack/{sid}/speaker/{pos}/promote")
def multitrack_promote(sid: str, pos: str, req: PromoteChannelRequest | None = None):
    """Promote an uploaded AUDIO channel into a new generative clone speaker:
    re-casts its clips onto a fresh speaker slot, transcribes the dialogue, and
    removes the old external channel."""
    try:
        info = sessions.channel_info(sid, pos)
        if info["kind"] != "audio":
            raise HTTPException(400, "Only uploaded audio channels can be promoted")
        if info["clone_index"] is None:
            raise HTTPException(400, "This channel has no audio to promote")
        audio, sr = sessions.clone_source(sid, info["clone_index"])
        prepped = _prep_clone_audio(audio, sr)
        # Transcribe each clip so the promoted speaker's dialogue lands in the script.
        transcripts: dict[int, str] = {}
        for idx in info["indices"]:
            try:
                a, s = sessions.clone_source(sid, idx)
                res = model_manager.transcribe({"waveform": a, "sample_rate": s})
                t = (res.get("text") or "").strip()
                if t:
                    transcripts[idx] = t
            except Exception:
                pass  # best-effort per clip
        label = (req.name if req and req.name else "") or info["name"]
        return sessions.promote_channel(sid, pos, prepped, sr, label, transcripts)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/text")
def multitrack_set_segment_text(sid: str, index: int, req: SetSegmentTextRequest):
    """Align a segment's displayed dialogue to its audio (no regeneration flag)."""
    try:
        return sessions.set_segment_text(sid, index, req.text)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.get("/api/multitrack/{sid}/segment/{index}/clip")
def multitrack_segment_clip(sid: str, index: int, dl: int = 0):
    """Render a segment exactly as it sits in the mix (trim+speed+level). Used for
    accurate solo preview and shareable per-slice download."""
    from .audio_utils import encode_audio

    try:
        audio, sr, name, start_s = sessions.render_segment(sid, index)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    safe = service.slugify(f"{name}-{start_s:.1f}s", default=f"seg{index}")
    if dl:
        fmt = settings.output_format
        path = TMP_DIR / f"clip_{sid}_{index}.{fmt}"
        out = encode_audio(path, audio, sr, fmt=fmt, bitrate=settings.output_bitrate)
        return FileResponse(str(out), media_type=media_type_for(out), filename=f"{safe}{out.suffix}")
    path = TMP_DIR / f"clip_{sid}_{index}.wav"
    save_wav(path, audio, sr)
    return FileResponse(str(path), media_type="audio/wav", filename=f"{safe}.wav")


@app.get("/api/multitrack/{sid}/download")
def multitrack_download(sid: str):
    """Download the full stitched mix in the UI's configured export format
    (FLAC/MP3), so shares aren't giant WAVs."""
    from .audio_utils import encode_audio

    try:
        audio, sr, title = sessions.render_mix(sid)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    safe = service.slugify(title, default="scene")
    fmt = settings.output_format
    path = TMP_DIR / f"mix_{sid}.{fmt}"
    out = encode_audio(path, audio, sr, fmt=fmt, bitrate=settings.output_bitrate)
    return FileResponse(str(out), media_type=media_type_for(out), filename=f"{safe}{out.suffix}")


@app.post("/api/multitrack/{sid}/segment/{index}/regenerate")
def multitrack_regen(sid: str, index: int, req: Optional[RegenSegmentRequest] = None):
    try:
        job_fn = service.make_regen_job(
            model_manager, sid, index, text=req.text if req else None, plain=bool(req and req.plain)
        )
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    job_id = job_manager.submit(job_fn, meta={"multitrack": True, "regen": index})
    return {"job_id": job_id}


@app.post("/api/multitrack/{sid}/segment/{index}/edit")
def multitrack_edit(sid: str, index: int, req: EditSegmentRequest):
    try:
        return sessions.set_segment(
            sid, index,
            start_s=req.start_s, trim_start_s=req.trim_start_s,
            trim_end_s=req.trim_end_s, speed=req.speed, gain_db=req.gain_db,
            fade_in_s=req.fade_in_s, fade_out_s=req.fade_out_s,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/segment/{index}/move")
def multitrack_move_segment(sid: str, index: int, req: MoveSegmentRequest):
    """Move a clip to another track (the audio stays — regenerate to re-voice)."""
    try:
        return sessions.move_segment(sid, index, req.speaker_id, req.start_s)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/track-order")
def multitrack_track_order(sid: str, req: TrackOrderRequest):
    """Reorder tracks (organizational only — the additive mix is unchanged)."""
    try:
        return sessions.reorder_tracks(sid, req.order)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/multitrack/{sid}/segment/{index}/peaks")
def multitrack_segment_peaks(sid: str, index: int, n: int = 2000):
    """Amplitude bins over a segment's full raw audio (for in-clip waveforms)."""
    try:
        return sessions.segment_peaks(sid, index, n)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/speaker/{pos}/channel")
def multitrack_set_channel(sid: str, pos: str, req: SetChannelRequest):
    """Set a channel's custom name, output gain and/or mute state."""
    try:
        return sessions.set_channel(sid, pos, name=req.name, gain_db=req.gain_db, muted=req.muted)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/speaker/{pos}/collapse")
def multitrack_collapse_track(sid: str, pos: str):
    """Flatten an entire track into one continuous segment."""
    try:
        return sessions.collapse_track(sid, pos)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/merge")
def multitrack_merge_segments(sid: str, req: MergeSegmentsRequest):
    """Flatten 2+ selected segments on one track into a single clip."""
    try:
        return sessions.merge_segments(sid, req.indices)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/speaker/{pos}/regenerate")
def multitrack_channel_regen(sid: str, pos: str):
    """Regenerate every spoken segment on a channel (re-cast a voice)."""
    try:
        job_fn = service.make_channel_regen_job(model_manager, sid, pos)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    job_id = job_manager.submit(job_fn, meta={"multitrack": True, "channel_regen": pos})
    return {"job_id": job_id}


@app.post("/api/multitrack/{sid}/upload-channel")
async def multitrack_upload_channel(
    sid: str, file: UploadFile = File(...), name: str = Form(""), start_s: float = Form(0.0)
):
    """Add an uploaded audio/video file as a new layered channel (soundtrack / SFX)."""
    data = await file.read()
    tmp = TMP_DIR / f"upload_{uuid.uuid4().hex}_{file.filename or 'audio'}"
    tmp.write_bytes(data)
    try:
        audio, in_sr = load_media_audio(tmp, sr=None, mono=True)
    except Exception as e:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"Could not read audio: {e}")
    tmp.unlink(missing_ok=True)
    label = (name or "").strip() or Path(file.filename or "Audio").stem
    try:
        return sessions.add_audio_channel(sid, label, audio, int(in_sr), start_s=float(start_s))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/channel/{pos}/upload-segment")
async def multitrack_upload_audio_segment(
    sid: str,
    pos: str,
    file: UploadFile = File(...),
    start_s: float = Form(0.0),
    ripple: bool = Form(False),
):
    """Drop an uploaded audio/video file as a new clip on an EXISTING audio
    channel (quick foley/SFX), optionally rippling later clips."""
    data = await file.read()
    tmp = TMP_DIR / f"upload_{uuid.uuid4().hex}_{file.filename or 'audio'}"
    tmp.write_bytes(data)
    try:
        audio, in_sr = load_media_audio(tmp, sr=None, mono=True)
    except Exception as e:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"Could not read audio: {e}")
    tmp.unlink(missing_ok=True)
    label = Path(file.filename or "Audio").stem
    try:
        return sessions.add_audio_segment(
            sid, pos, audio, int(in_sr), name=label, start_s=float(start_s), ripple=bool(ripple)
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/multitrack/{sid}/reflow")
def multitrack_reflow(sid: str, req: ReflowRequest):
    try:
        return sessions.reflow(sid, gap_ms=req.gap_ms, speed=req.speed)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/insert")
def multitrack_insert(sid: str, req: InsertSegmentRequest):
    if not req.text.strip():
        raise HTTPException(400, "Empty dialogue")
    try:
        job_fn = service.make_insert_job(model_manager, sid, req.speaker_id, req.text.strip(), req.start_s, req.ripple)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    job_id = job_manager.submit(job_fn, meta={"multitrack": True, "insert": True})
    return {"job_id": job_id}


@app.post("/api/multitrack/{sid}/import-clip")
def multitrack_import_clip(sid: str, req: ImportClipRequest):
    """Drop an existing output file onto a track as a segment (no model run) —
    e.g. 'Import to ADR Studio' from the Voice Clone tab."""
    src = (OUTPUT_DIR / req.filename).resolve()
    if OUTPUT_DIR.resolve() not in src.parents or not src.exists():
        raise HTTPException(404, "Output file not found")
    try:
        return sessions.import_clip(sid, req.speaker_id, req.text or "", req.start_s, src)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))


@app.post("/api/multitrack/{sid}/finalize")
def multitrack_finalize(sid: str):
    try:
        return service.finalize_session(sid)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


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
    return FileResponse(path, media_type=media_type_for(path))


@app.get("/api/audio/session/{sid}/{name}")
def audio_session(sid: str, name: str):
    try:
        path = sessions.resolve_file(sid, name)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, "Not found")
    return FileResponse(path, media_type=media_type_for(path))


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


def _ensure_ssl_cert() -> tuple[str, str]:
    """Create (once) and reuse a self-signed cert so the UI can be served over
    HTTPS. Browsers only expose microphone capture (getUserMedia) on secure
    origins — plain http:// over the LAN hides the whole API.

    Generated in pure Python (cryptography) — no external openssl binary, which
    is often missing or misconfigured on Windows."""
    import datetime
    import ipaddress
    import socket

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    d = DATA_DIR / "ssl"
    d.mkdir(parents=True, exist_ok=True)
    crt, key = d / "server.crt", d / "server.key"
    if not (crt.exists() and key.exists()):
        host = socket.gethostname()
        ips = {"127.0.0.1"}
        try:
            ips.update(socket.gethostbyname_ex(host)[2])
        except OSError:
            pass
        san = x509.SubjectAlternativeName(
            [x509.DNSName(host), x509.DNSName("localhost")]
            + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in sorted(ips)]
        )
        key_obj = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key_obj.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now)
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(san, critical=False)
            .sign(key_obj, hashes.SHA256())
        )
        key.write_bytes(
            key_obj.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption(),
            )
        )
        crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        print(f"Generated self-signed TLS cert: {crt}", flush=True)
    return str(crt), str(key)


def main() -> int:
    parser = argparse.ArgumentParser(prog="omnivoice-manager")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument(
        "--ssl",
        action="store_true",
        help="Serve over HTTPS with a self-signed cert (required for mic recording "
        "when the UI is opened from another machine — browsers only allow "
        "getUserMedia on secure origins).",
    )
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
    # Persisted prefs form the baseline; CLI flags override (and --lod can only
    # force LOD *on* for this launch, never off — flags are enable-only).
    _pref = prefs.load()
    _sys = _pref.get("system", {}) if isinstance(_pref.get("system"), dict) else {}
    _out = _pref.get("output", {}) if isinstance(_pref.get("output"), dict) else {}
    settings.load_on_demand = bool(args.lod) or bool(_sys.get("load_on_demand", False))
    settings.low_vram = bool(_sys.get("low_vram", False))
    settings.trim_silence = bool(_sys.get("trim_silence", False))
    settings.auto_slice = bool(_sys.get("auto_slice", False))
    _fmt = str(_out.get("format") or settings.output_format).lower()
    if _fmt in ("mp3", "flac", "wav", "m4a", "ogg"):
        settings.output_format = _fmt
    settings.output_bitrate = str(_out.get("bitrate") or settings.output_bitrate)
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

    ssl_kw = {}
    if args.ssl:
        crt, key = _ensure_ssl_cert()
        ssl_kw = {"ssl_certfile": crt, "ssl_keyfile": key}
    scheme = "https" if args.ssl else "http"
    print(f"OmniVoice Manager on {scheme}://{settings.host}:{settings.port}  (LOD={settings.load_on_demand})", flush=True)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info", **ssl_kw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
