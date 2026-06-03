"""Service helpers: build worker payloads, save outputs, slugging."""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Callable, Dict, List

import numpy as np

from . import history, voices
from .audio_utils import duration_seconds, save_wav
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
        spk["waveform"] = voices.load_voice_audio(cfg.voice)
    return spk


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
    }


def save_output(audio: np.ndarray, sr: int, title: str, num_speakers: int = 1) -> Dict[str, Any]:
    date = time.strftime("%Y%m%d-%H%M%S")
    slug = slugify(title)
    filename = f"{date}_{num_speakers}spk_{slug}.wav"
    path = OUTPUT_DIR / filename
    save_wav(path, audio, sr)
    return {
        "filename": filename,
        "audio_url": f"/api/audio/output/{filename}",
        "duration_s": duration_seconds(audio, sr),
    }


def list_outputs(limit: int = 100) -> List[Dict[str, Any]]:
    if not OUTPUT_DIR.exists():
        return []
    files = sorted(
        [p for p in OUTPUT_DIR.glob("*.wav") if not p.name.startswith("_")],
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


def make_generation_job(model_manager, req: GenerateRequest, title: str) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    payload = build_generation_payload(req)
    num_speakers = req.num_speakers if req.multi_speaker else 1

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        result = model_manager.generate(payload, progress_cb=progress_cb)
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
