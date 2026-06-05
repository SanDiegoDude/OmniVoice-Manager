"""Multitrack sessions: per-segment audio that can be regenerated individually.

A "session" is a multi-speaker generation kept as separate per-line segments on
disk instead of one baked render. Each segment can be regenerated on its own;
the full mix is re-stitched (LUFS-leveled + true-peak limited) from the current
segments so one bad take never forces a full re-run.

Layout (under output/sessions/<id>/):
    seg_<index>.wav   raw per-line audio (pre-loudness)
    ref_<sid>.wav     cleaned reference per clone speaker (for fast regen)
    mix.wav           current stitched preview
    session.json      manifest
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from .audio_utils import duration_seconds, load_audio, match_loudness, peak_limit, save_wav
from .config import OUTPUT_DIR

SESSIONS_DIR = OUTPUT_DIR / "sessions"
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

_SR = 24000
_lock = threading.Lock()


def _dir(sid: str) -> Path:
    return SESSIONS_DIR / sid


def _manifest_path(sid: str) -> Path:
    return _dir(sid) / "session.json"


def _read(sid: str) -> Optional[Dict[str, Any]]:
    p = _manifest_path(sid)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _write(session: Dict[str, Any]) -> None:
    p = _manifest_path(session["id"])
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(session, indent=2, ensure_ascii=False))
    tmp.replace(p)


def _speaker_name(sid: str, cfg: Dict[str, Any]) -> str:
    voice = cfg.get("voice")
    if cfg.get("mode") == "clone" and voice:
        return Path(voice).name.rsplit(".", 1)[0]
    if cfg.get("mode") == "design":
        return f"Speaker {sid} (design)"
    return f"Speaker {sid}"


def create(
    title: str,
    speakers_cfg: Dict[str, Dict[str, Any]],
    params: Dict[str, Any],
    gap_ms: int,
    worker_result: Dict[str, Any],
    *,
    prompt: str = "",
    script: str = "",
) -> Dict[str, Any]:
    """Persist a worker multitrack result (raw segments + refs) as a session."""
    sid = uuid.uuid4().hex[:12]
    sr = int(worker_result.get("sample_rate", _SR))
    d = _dir(sid)
    d.mkdir(parents=True, exist_ok=True)

    # Save cleaned references (used to rebuild clone prompts on regen).
    refs: Dict[str, str] = {}
    for spk_id, wav in (worker_result.get("refs") or {}).items():
        fn = f"ref_{spk_id}.wav"
        save_wav(d / fn, np.asarray(wav, dtype=np.float32), sr)
        refs[str(spk_id)] = fn

    # Save each raw segment in generation order.
    segments: List[Dict[str, Any]] = []
    for seg in worker_result.get("segments", []):
        idx = int(seg["index"])
        wav = np.asarray(seg["waveform"], dtype=np.float32)
        fn = f"seg_{idx:03d}.wav"
        save_wav(d / fn, wav, sr)
        segments.append(
            {
                "index": idx,
                "speaker_id": str(seg["speaker_id"]),
                "text": seg["text"],
                "file": fn,
                "duration_s": duration_seconds(wav, sr),
            }
        )
    segments.sort(key=lambda s: s["index"])

    # Attach display names to speaker configs.
    speakers = {
        str(k): {**v, "name": _speaker_name(str(k), v)} for k, v in speakers_cfg.items()
    }

    session = {
        "id": sid,
        "title": title,
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": time.time(),
        "sample_rate": sr,
        "gap_ms": int(gap_ms),
        "params": params,
        "speakers": speakers,
        "refs": refs,
        "segments": segments,
        "mix_file": "mix.wav",
        "prompt": prompt,
        "script": script,
    }
    _stitch(session)
    _write(session)
    return public(session)


def _stitch(session: Dict[str, Any]) -> np.ndarray:
    """Re-stitch the full mix from current segments (LUFS + gaps + limiter)."""
    sid = session["id"]
    d = _dir(sid)
    sr = int(session["sample_rate"])
    params = session.get("params", {})
    gap = np.zeros(int(sr * int(session.get("gap_ms", 250)) / 1000.0), dtype=np.float32)

    arrays: List[np.ndarray] = []
    for seg in session["segments"]:
        wav = load_audio(d / seg["file"], sr=sr)
        seg["duration_s"] = duration_seconds(wav, sr)
        arrays.append(wav)

    if not arrays:
        full = np.zeros(1, dtype=np.float32)
    else:
        leveled = arrays
        if params.get("match_loudness", True):
            leveled = match_loudness(arrays, sr, target_lufs=float(params.get("target_lufs", -20.0)))
        chunks: List[np.ndarray] = []
        for i, seg in enumerate(leveled):
            chunks.append(seg)
            if i < len(leveled) - 1 and gap.size:
                chunks.append(gap)
        full = np.concatenate(chunks).astype(np.float32)
        if params.get("match_loudness", True):
            full = peak_limit(full, ceiling_db=float(params.get("peak_ceiling_db", -1.0)))

    save_wav(d / session["mix_file"], full, sr)

    # Recompute the timeline from raw durations + inter-segment gaps.
    gap_s = int(session.get("gap_ms", 250)) / 1000.0
    cursor = 0.0
    for seg in session["segments"]:
        seg["start_s"] = round(cursor, 3)
        cursor += seg["duration_s"] + gap_s
    session["total_duration_s"] = round(duration_seconds(full, sr), 2)
    return full


def get(sid: str) -> Optional[Dict[str, Any]]:
    with _lock:
        session = _read(sid)
        return public(session) if session else None


def public(session: Dict[str, Any]) -> Dict[str, Any]:
    """Shape a session for the UI: per-speaker tracks with timeline + URLs."""
    sid = session["id"]
    bust = int(time.time())

    def seg_url(fn: str) -> str:
        return f"/api/audio/session/{sid}/{fn}?t={bust}"

    # Group segments into one row per speaker, preserving speaker order.
    order: List[str] = []
    for seg in session["segments"]:
        if seg["speaker_id"] not in order:
            order.append(seg["speaker_id"])
    for spk_id in session.get("speakers", {}):
        if spk_id not in order:
            order.append(spk_id)

    tracks = []
    for spk_id in order:
        cfg = session.get("speakers", {}).get(spk_id, {})
        segs = [
            {
                "index": s["index"],
                "speaker_id": s["speaker_id"],
                "text": s["text"],
                "start_s": s.get("start_s", 0.0),
                "duration_s": s.get("duration_s", 0.0),
                "url": seg_url(s["file"]),
            }
            for s in session["segments"]
            if s["speaker_id"] == spk_id
        ]
        tracks.append(
            {
                "speaker_id": spk_id,
                "name": cfg.get("name") or _speaker_name(spk_id, cfg),
                "mode": cfg.get("mode", "auto"),
                "segments": segs,
            }
        )

    return {
        "id": sid,
        "title": session["title"],
        "created": session.get("created"),
        "sample_rate": session["sample_rate"],
        "gap_ms": session.get("gap_ms", 250),
        "total_duration_s": session.get("total_duration_s", 0.0),
        "mix_url": f"/api/audio/session/{sid}/{session['mix_file']}?t={bust}",
        "tracks": tracks,
        "segment_count": len(session["segments"]),
    }


def apply_regen(sid: str, index: int, worker_result: Dict[str, Any]) -> Dict[str, Any]:
    """Replace one segment with a freshly generated take and re-stitch."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        segs = worker_result.get("segments") or []
        if not segs:
            raise ValueError("Regeneration produced no audio")
        wav = np.asarray(segs[0]["waveform"], dtype=np.float32)
        sr = int(session["sample_rate"])
        target = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if target is None:
            raise FileNotFoundError(f"Segment {index} not found")
        save_wav(_dir(sid) / target["file"], wav, sr)
        _stitch(session)
        _write(session)
        return public(session)


def regen_payload(sid: str, index: int, text: Optional[str] = None) -> Dict[str, Any]:
    """Build a single-segment worker payload (reuses the cleaned reference so we
    don't re-isolate/clean on every regen). If ``text`` is given, the segment's
    dialogue is edited + persisted before regenerating."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        if text is not None and text.strip():
            seg["text"] = text.strip()
            _write(session)
    spk_id = seg["speaker_id"]
    cfg = dict(session.get("speakers", {}).get(spk_id, {}))
    sr = int(session["sample_rate"])

    spk: Dict[str, Any] = {
        "mode": cfg.get("mode", "auto"),
        "ref_text": cfg.get("ref_text"),
        "instruct": cfg.get("instruct"),
        "language": cfg.get("language"),
        # Reference is already cleaned — skip secondary models on regen.
        "isolate": False,
        "normalize": False,
        "dereverb": False,
        "sample_rate": sr,
    }
    if cfg.get("mode") == "clone":
        ref_fn = session.get("refs", {}).get(spk_id)
        if ref_fn and (_dir(sid) / ref_fn).exists():
            spk["waveform"] = load_audio(_dir(sid) / ref_fn, sr=sr)
        elif cfg.get("voice"):
            from . import voices as _voices

            spk["waveform"] = _voices.load_voice_audio(cfg["voice"])

    return {
        "lines": [{"speaker_id": spk_id, "text": seg["text"], "index": int(index)}],
        "speakers": {spk_id: spk},
        "params": session.get("params", {}),
        "gap_ms": session.get("gap_ms", 250),
        "multitrack": True,
    }


def finalize_info(sid: str) -> Dict[str, Any]:
    """Return the data needed to bake a session into a normal output + history."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        full = _stitch(session)
        _write(session)
        script = "\n".join(
            f"Speaker {s['speaker_id']}: {s['text']}" for s in session["segments"]
        )
        speakers_cfg = {
            k: {kk: vv for kk, vv in v.items() if kk != "name"}
            for k, v in session.get("speakers", {}).items()
        }
        return {
            "audio": full,
            "sample_rate": int(session["sample_rate"]),
            "title": session["title"],
            "num_speakers": len(session.get("speakers", {})) or 1,
            "params": session.get("params", {}),
            "speakers": speakers_cfg,
            "prompt": session.get("prompt", ""),
            "script": script,
        }


def resolve_file(sid: str, name: str) -> Path:
    """Safely resolve a file inside a session dir (no path escapes)."""
    base = _dir(sid).resolve()
    target = (base / name).resolve()
    if base != target and base not in target.parents:
        raise ValueError("Path escapes the session.")
    if not target.exists():
        raise FileNotFoundError(name)
    return target
