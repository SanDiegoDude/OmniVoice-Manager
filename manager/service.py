"""Service helpers: build worker payloads, save outputs, slugging."""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Callable, Dict, List

import numpy as np

from . import actionhist, history, ref_cache, sentence_slicer, sessions, voices
from .audio_utils import duration_seconds, encode_audio, load_audio
from .config import OUTPUT_DIR, settings
from .generation import parse_script
from .schemas import GenerateRequest, GenParams, SpeakerConfig


def slugify(text: str, default: str = "scene") -> str:
    text = (text or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:40] or default


def _speaker_to_worker(cfg: SpeakerConfig) -> Dict[str, Any]:
    spk: Dict[str, Any] = {
        "mode": cfg.mode,
        "ref_text": cfg.ref_text,
        "instruct": cfg.instruct,
        "language": cfg.language,
        "isolate": cfg.isolate,
        "normalize": cfg.normalize,
        "dereverb": cfg.dereverb,
        "dereverb_method": cfg.dereverb_method,
        "sample_rate": 24000,
    }
    if cfg.mode == "clone":
        if not cfg.voice:
            raise ValueError("Clone speaker requires a voice selection.")
        path = voices.resolve_voice_path(cfg.voice)
        spk["waveform"] = load_audio(path)
        if cfg.isolate or cfg.dereverb:
            # Reuse the cleaned reference if this exact voice + flags combo was
            # processed before; otherwise tag the speaker so the job can cache
            # the cleaned ref the worker hands back.
            key = ref_cache.cache_key(path, cfg.isolate, cfg.dereverb, cfg.dereverb_method, cfg.normalize)
            cached = ref_cache.load(key)
            if cached is not None:
                spk["waveform"] = cached
                spk["isolate"] = spk["dereverb"] = spk["normalize"] = False
            else:
                spk["cache_key"] = key
    return spk


def _store_cleaned_refs(payload: Dict[str, Any], result: Dict[str, Any]) -> None:
    """Cache the cleaned references the worker returned for any speaker whose
    voice+flags combo wasn't cached yet (tagged with cache_key above)."""
    refs = result.get("refs") or {}
    for sid, spk in payload.get("speakers", {}).items():
        key = spk.get("cache_key")
        if key and sid in refs:
            ref_cache.store(key, np.asarray(refs[sid], dtype=np.float32))


def build_generation_payload(req: GenerateRequest) -> Dict[str, Any]:
    if req.multi_speaker:
        lines = parse_script(req.script or "", req.num_speakers)
    else:
        text = (req.text or req.script or "").strip()
        if not text:
            raise ValueError("No text provided.")
        lines = [{"speaker_id": 1, "text": text}]

    if not lines:
        raise ValueError("Nothing to synthesize.")

    referenced = {str(ln["speaker_id"]) for ln in lines}
    speakers: Dict[str, Any] = {}
    for sid in referenced:
        cfg = req.speakers.get(sid) or req.speakers.get(str(sid))
        if cfg is None:
            cfg = SpeakerConfig(mode="auto")
        speakers[sid] = _speaker_to_worker(cfg)

    return {
        "lines": lines,
        "speakers": speakers,
        "params": req.params.model_dump(),
        "gap_ms": req.params.gap_ms,
        "low_vram": settings.low_vram,
        "trim_silence": settings.trim_silence,
    }


_OUTPUT_EXTS = (".mp3", ".wav", ".m4a", ".ogg", ".flac", ".opus")


def save_output(audio: np.ndarray, sr: int, title: str, num_speakers: int = 1) -> Dict[str, Any]:
    date = time.strftime("%Y%m%d-%H%M%S")
    slug = slugify(title)
    fmt = settings.output_format
    filename = f"{date}_{num_speakers}spk_{slug}.{fmt}"
    path = encode_audio(OUTPUT_DIR / filename, audio, sr, fmt=fmt, bitrate=settings.output_bitrate)
    filename = path.name  # encode_audio may fall back to .wav
    return {
        "filename": filename,
        "audio_url": f"/api/audio/output/{filename}",
        "duration_s": duration_seconds(audio, sr),
    }


def list_outputs(limit: int = 100) -> List[Dict[str, Any]]:
    if not OUTPUT_DIR.exists():
        return []
    files = sorted(
        [p for p in OUTPUT_DIR.glob("*") if p.is_file() and p.suffix.lower() in _OUTPUT_EXTS and not p.name.startswith("_")],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    out = []
    for p in files[:limit]:
        out.append(
            {
                "filename": p.name,
                "audio_url": f"/api/audio/output/{p.name}",
                "size_kb": round(p.stat().st_size / 1024, 1),
                "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime)),
            }
        )
    return out


def delete_output(filename: str) -> bool:
    """Delete a saved output file (Outputs pillar). Path-safe; format-checked."""
    p = (OUTPUT_DIR / filename).resolve()
    if OUTPUT_DIR.resolve() not in p.parents or not p.is_file():
        return False
    if p.suffix.lower() not in _OUTPUT_EXTS:
        return False
    p.unlink()
    return True


def rename_output(filename: str, new_name: str) -> Dict[str, Any]:
    """Rename a saved output (keeps its extension). Returns the refreshed entry."""
    p = (OUTPUT_DIR / filename).resolve()
    if OUTPUT_DIR.resolve() not in p.parents or not p.is_file():
        raise FileNotFoundError("Output not found")
    base = slugify(new_name, default="output")
    target = OUTPUT_DIR / f"{base}{p.suffix.lower()}"
    n = 1
    while target.exists() and target.resolve() != p:
        target = OUTPUT_DIR / f"{base}-{n}{p.suffix.lower()}"
        n += 1
    p.rename(target)
    return {
        "filename": target.name,
        "audio_url": f"/api/audio/output/{target.name}",
        "size_kb": round(target.stat().st_size / 1024, 1),
        "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(target.stat().st_mtime)),
    }


def make_multitrack_job(
    model_manager, req: GenerateRequest, title: str
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    """Generate a multi-speaker scene as individual, regenerable segments."""
    payload = build_generation_payload(req)
    for i, ln in enumerate(payload["lines"]):
        ln["index"] = i
    payload["multitrack"] = True
    speakers_cfg = {k: v.model_dump() for k, v in req.speakers.items()}

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        result = model_manager.generate(payload, progress_cb=progress_cb)
        _store_cleaned_refs(payload, result)
        session = sessions.create(
            title=title,
            speakers_cfg=speakers_cfg,
            params=req.params.model_dump(),
            gap_ms=req.params.gap_ms,
            worker_result=result,
            prompt=req.prompt or "",
            script=req.script or req.text or "",
        )
        # Optional follow-on: sentence-slice every voice segment now that all TTS
        # is done. Kept as a second phase (not inline per-clip) so the Whisper
        # pass loads once instead of thrashing the GPU against the TTS model.
        if settings.auto_slice:
            sid = session["id"]
            sliced = sentence_slicer.slice_all_voice(model_manager, sid, progress_cb=progress_cb)
            if sliced is not None:
                sliced.pop("_bulk_sliced", None)
                session = sliced
        return {"session": session, "session_id": session["id"]}

    return job


def make_bulk_slice_job(
    model_manager, sid: str
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    """Sentence-slice every voice track in an existing scene as a heavy job."""

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        session = sentence_slicer.slice_all_voice(model_manager, sid, progress_cb=progress_cb)
        sliced = (session or {}).pop("_bulk_sliced", 0) if session else 0
        if session is not None:
            actionhist.commit(sid, "Auto-slice scene")
        return {"session": session, "session_id": sid, "bulk_sliced": sliced}

    return job


def make_regen_job(
    model_manager, sid: str, index: int, text: str | None = None, plain: bool = False
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    """Regenerate a single segment of a session and re-stitch the mix.

    With ``plain`` the render ignores any attached vocal performance and uses
    the channel voice only (Capture Performance toggled off in the UI)."""
    payload = sessions.regen_payload(sid, index, text=text, plain=plain)

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        result = model_manager.generate(payload, progress_cb=progress_cb)
        session = sessions.apply_regen(sid, index, result, perform_rendered=not plain)
        actionhist.commit(sid, "Regenerate clip")
        return {"session": session, "session_id": sid, "regenerated_index": index}

    return job


def make_insert_job(
    model_manager, sid: str, speaker_id: str, text: str, start_s: float, ripple: bool
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    """Generate a brand-new segment and drop it onto the timeline."""
    new_index = sessions.reserve_index(sid)
    payload = sessions.insert_payload(sid, speaker_id, text, new_index)

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        result = model_manager.generate(payload, progress_cb=progress_cb)
        session = sessions.apply_insert(sid, new_index, speaker_id, text, start_s, ripple, result)
        actionhist.commit(sid, "Insert clip")
        return {"session": session, "session_id": sid, "inserted_index": new_index}

    return job


def make_channel_regen_job(
    model_manager, sid: str, pos: str
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    """Regenerate every spoken segment on a channel (e.g. after re-casting a voice)."""
    payload = sessions.channel_regen_payload(sid, pos)

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        result = model_manager.generate(payload, progress_cb=progress_cb)
        session = sessions.apply_channel_regen(sid, pos, result)
        actionhist.commit(sid, "Regenerate channel")
        return {"session": session, "session_id": sid, "channel_regen": pos}

    return job


def finalize_session(sid: str) -> Dict[str, Any]:
    """Bake a session's current mix into a normal output + history entry."""
    info = sessions.finalize_info(sid)
    saved = save_output(info["audio"], info["sample_rate"], info["title"], info["num_speakers"])
    history.add_entry(
        {
            "type": "generation",
            "title": info["title"],
            "prompt": info["prompt"],
            "script": info["script"],
            "multi_speaker": info["num_speakers"] > 1,
            "num_speakers": info["num_speakers"],
            "speakers": info["speakers"],
            "filename": saved["filename"],
            "audio_url": saved["audio_url"],
            "params": info["params"],
        }
    )
    return {"title": info["title"], **saved}


def make_generation_job(
    model_manager,
    req: GenerateRequest,
    title: str,
    perform: Dict[str, Any] | None = None,
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    payload = build_generation_payload(req)
    if perform is not None:
        # Standalone V2V (Voice Clone tab): the single line rides the take.
        payload["lines"][0]["perform"] = perform
    num_speakers = req.num_speakers if req.multi_speaker else 1

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        result = model_manager.generate(payload, progress_cb=progress_cb)
        _store_cleaned_refs(payload, result)
        audio = np.asarray(result["waveform"], dtype=np.float32)
        sr = int(result["sample_rate"])
        out: Dict[str, Any] = {"title": title, "duration_s": duration_seconds(audio, sr)}
        if req.save:
            saved = save_output(audio, sr, title, num_speakers)
            out.update(saved)
            history.add_entry(
                {
                    "type": "generation",
                    "title": title,
                    "prompt": req.prompt or "",
                    "script": req.script or req.text or "",
                    "multi_speaker": req.multi_speaker,
                    "num_speakers": num_speakers,
                    "speakers": {k: v.model_dump() for k, v in req.speakers.items()},
                    "filename": saved["filename"],
                    "audio_url": saved["audio_url"],
                    "params": req.params.model_dump(),
                }
            )
        return out

    return job
