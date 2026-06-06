"""Multitrack sessions: a true timeline of per-segment audio.

A "session" is a multi-speaker generation kept as separate per-line segments on
disk instead of one baked render. Each segment has an EXPLICIT timeline position
(start_s), an in/out trim window, and a speed, so the editor can move, trim,
speed-shift, insert and regenerate individual clips without re-running the whole
scene. The full mix is rendered by ADDITIVE placement (clips that overlap in
time are summed → real layering), LUFS-leveled per clip, then true-peak limited.

Layout (under output/sessions/<id>/):
    seg_<index>.wav   raw per-line audio (full, pre-trim/speed)
    ref_<sid>.wav     cleaned reference per clone speaker (for fast regen)
    mix.wav           current stitched preview
    session.json      manifest
"""

from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from .audio_utils import (
    duration_seconds,
    load_audio,
    match_loudness,
    peak_limit,
    save_wav,
    time_stretch,
)
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


def _eff_duration(seg: Dict[str, Any]) -> float:
    """Audible length of a segment after trim + speed."""
    rdur = float(seg.get("raw_duration_s", 0.0) or 0.0)
    ts = float(seg.get("trim_start_s", 0.0) or 0.0)
    te = seg.get("trim_end_s")
    te = float(te) if te else rdur
    ts = max(0.0, min(ts, rdur))
    te = max(ts, min(te, rdur))
    speed = float(seg.get("speed", 1.0) or 1.0)
    return max(0.0, (te - ts) / (speed if speed > 0 else 1.0))


# ---------------------------------------------------------------------------
# Creation
# ---------------------------------------------------------------------------
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

    refs: Dict[str, str] = {}
    for spk_id, wav in (worker_result.get("refs") or {}).items():
        fn = f"ref_{spk_id}.wav"
        save_wav(d / fn, np.asarray(wav, dtype=np.float32), sr)
        refs[str(spk_id)] = fn

    segments: List[Dict[str, Any]] = []
    for seg in worker_result.get("segments", []):
        idx = int(seg["index"])
        wav = np.asarray(seg["waveform"], dtype=np.float32)
        fn = f"seg_{idx:03d}.wav"
        save_wav(d / fn, wav, sr)
        dur = duration_seconds(wav, sr)
        segments.append(
            {
                "index": idx,
                "speaker_id": str(seg["speaker_id"]),
                "text": seg["text"],
                "file": fn,
                "raw_duration_s": dur,
                "trim_start_s": 0.0,
                "trim_end_s": dur,
                "speed": 1.0,
                "start_s": 0.0,
            }
        )
    segments.sort(key=lambda s: s["index"])

    # Initial layout: sequential turns with the requested gap.
    gap_s = int(gap_ms) / 1000.0
    cursor = 0.0
    for seg in segments:
        seg["start_s"] = round(cursor, 3)
        cursor += _eff_duration(seg) + gap_s

    speakers = {str(k): {**v, "name": _speaker_name(str(k), v)} for k, v in speakers_cfg.items()}

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
        "next_index": (max((s["index"] for s in segments), default=-1) + 1),
        "mix_file": "mix.wav",
        "prompt": prompt,
        "script": script,
    }
    _stitch(session)
    _write(session)
    return public(session)


# ---------------------------------------------------------------------------
# Rendering (additive timeline mix)
# ---------------------------------------------------------------------------
def _render_clip(d: Path, seg: Dict[str, Any], sr: int, level: bool, target: float, extra_gain_db: float = 0.0) -> np.ndarray:
    """Apply trim + speed (+ optional LUFS leveling, + manual gain) to a segment's
    raw audio. Also refreshes the segment's cached raw/effective durations.

    Manual gain (segment ``gain_db`` plus the channel's ``extra_gain_db``) is
    applied AFTER LUFS leveling so a dB tweak is a deliberate offset from the
    leveled baseline rather than being erased by re-normalization."""
    raw = load_audio(d / seg["file"], sr=sr)
    rdur = len(raw) / sr
    seg["raw_duration_s"] = round(rdur, 3)
    ts = max(0.0, min(float(seg.get("trim_start_s", 0.0) or 0.0), rdur))
    te = seg.get("trim_end_s")
    te = float(te) if te else rdur
    te = max(ts, min(te, rdur))
    clip = raw[int(ts * sr) : int(te * sr)]
    speed = float(seg.get("speed", 1.0) or 1.0)
    if abs(speed - 1.0) > 1e-3:
        clip = time_stretch(clip, speed)
    if clip.size and level:
        clip = match_loudness([clip], sr, target_lufs=target)[0]
    gain_db = float(seg.get("gain_db", 0.0) or 0.0) + float(extra_gain_db or 0.0)
    if clip.size and abs(gain_db) > 1e-3:
        clip = clip * float(10.0 ** (gain_db / 20.0))
    seg["duration_s"] = round(len(clip) / sr, 3) if clip.size else 0.0
    return clip.astype(np.float32)


def _channel_of(session: Dict[str, Any], speaker_id: str) -> Dict[str, Any]:
    return session.get("speakers", {}).get(str(speaker_id), {})


def _stitch(session: Dict[str, Any]) -> np.ndarray:
    sid = session["id"]
    d = _dir(sid)
    sr = int(session["sample_rate"])
    params = session.get("params", {})
    level = bool(params.get("match_loudness", True))
    target = float(params.get("target_lufs", -20.0))

    placed: List[tuple] = []  # (start_sample, clip)
    for seg in session["segments"]:
        chan = _channel_of(session, seg["speaker_id"])
        is_audio = chan.get("kind") == "audio"  # uploaded soundtrack/SFX: don't LUFS it
        clip = _render_clip(d, seg, sr, level and not is_audio, target, extra_gain_db=float(chan.get("gain_db", 0.0) or 0.0))
        if clip.size == 0:
            continue
        start = max(0.0, float(seg.get("start_s", 0.0) or 0.0))
        placed.append((int(round(start * sr)), clip))

    if not placed:
        full = np.zeros(1, dtype=np.float32)
    else:
        total = max(st + len(c) for st, c in placed)
        full = np.zeros(total, dtype=np.float32)
        for st, c in placed:
            full[st : st + len(c)] += c
        if level:
            full = peak_limit(full, ceiling_db=float(params.get("peak_ceiling_db", -1.0)))

    save_wav(d / session["mix_file"], full, sr)
    session["total_duration_s"] = round(duration_seconds(full, sr), 2)
    return full


# ---------------------------------------------------------------------------
# Public shape (for the UI)
# ---------------------------------------------------------------------------
def get(sid: str) -> Optional[Dict[str, Any]]:
    with _lock:
        session = _read(sid)
        return public(session) if session else None


def public(session: Dict[str, Any]) -> Dict[str, Any]:
    sid = session["id"]
    bust = int(time.time() * 1000)

    def seg_url(fn: str) -> str:
        return f"/api/audio/session/{sid}/{fn}?t={bust}"

    # Stable, roster-aligned track order: generative speakers by numeric id
    # (1..N), then uploaded audio channels (a1, a2 …). Keeps row N == Speaker N
    # and stops promoted/edited tracks from jumping around.
    all_ids = set(session.get("speakers", {}))
    for seg in session["segments"]:
        all_ids.add(str(seg["speaker_id"]))

    def _ord(k: str):
        return (0, int(k)) if str(k).isdigit() else (1, int(k[1:]) if k[1:].isdigit() else 0)

    order: List[str] = sorted(all_ids, key=_ord)

    tracks = []
    for spk_id in order:
        cfg = session.get("speakers", {}).get(spk_id, {})
        segs = [
            {
                "index": s["index"],
                "speaker_id": s["speaker_id"],
                "text": s["text"],
                "start_s": round(float(s.get("start_s", 0.0) or 0.0), 3),
                "duration_s": s.get("duration_s", _eff_duration(s)),
                "raw_duration_s": s.get("raw_duration_s", 0.0),
                "trim_start_s": round(float(s.get("trim_start_s", 0.0) or 0.0), 3),
                "trim_end_s": round(float(s.get("trim_end_s", s.get("raw_duration_s", 0.0)) or 0.0), 3),
                "speed": float(s.get("speed", 1.0) or 1.0),
                "gain_db": float(s.get("gain_db", 0.0) or 0.0),
                "inpaint": bool(s.get("inpaint", False)),
                "url": seg_url(s["file"]),
                "clip_url": f"/api/multitrack/{sid}/segment/{s['index']}/clip?t={bust}",
            }
            for s in session["segments"]
            if s["speaker_id"] == spk_id
        ]
        segs.sort(key=lambda x: x["start_s"])
        voice_name = cfg.get("name") or _speaker_name(spk_id, cfg)
        custom_name = cfg.get("custom_name") or None
        tracks.append(
            {
                "speaker_id": spk_id,
                "name": custom_name or voice_name,
                "voice_name": voice_name,
                "custom_name": custom_name,
                "gain_db": float(cfg.get("gain_db", 0.0) or 0.0),
                "kind": cfg.get("kind", "speaker"),
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
        "can_undo": _undo_dir(sid).exists(),
    }


# ---------------------------------------------------------------------------
# Worker payloads (single-line generate, reusing cleaned refs)
# ---------------------------------------------------------------------------
def _speaker_worker(session: Dict[str, Any], speaker_id: str, sr: int) -> Dict[str, Any]:
    cfg = dict(session.get("speakers", {}).get(str(speaker_id), {}))
    spk: Dict[str, Any] = {
        "mode": cfg.get("mode", "auto"),
        "ref_text": cfg.get("ref_text"),
        "instruct": cfg.get("instruct"),
        "language": cfg.get("language"),
        "isolate": False,
        "normalize": False,
        "dereverb": False,
        "dereverb_method": cfg.get("dereverb_method", "roformer"),
        "sample_rate": sr,
    }
    if cfg.get("mode") == "clone":
        ref_fn = session.get("refs", {}).get(str(speaker_id))
        local = cfg.get("local_source")
        if ref_fn and (_dir(session["id"]) / ref_fn).exists():
            # Already cleaned once — reuse it (fast, consistent).
            spk["waveform"] = load_audio(_dir(session["id"]) / ref_fn, sr=sr)
        elif local and (_dir(session["id"]) / local).exists():
            # Promoted / session-local clone source: cold-build from the stored
            # sample with the channel's cleaning flags; cleaned ref cached below.
            spk["waveform"] = load_audio(_dir(session["id"]) / local, sr=sr)
            spk["isolate"] = bool(cfg.get("isolate", True))
            spk["normalize"] = bool(cfg.get("normalize", True))
            spk["dereverb"] = bool(cfg.get("dereverb", False))
        elif cfg.get("voice"):
            # Cold build: hand the worker the raw voice + the cleaning flags so it
            # isolates/dereverbs/normalizes once; we capture the cleaned ref below.
            from . import voices as _voices

            spk["waveform"] = _voices.load_voice_audio(cfg["voice"])
            spk["isolate"] = bool(cfg.get("isolate", True))
            spk["normalize"] = bool(cfg.get("normalize", True))
            spk["dereverb"] = bool(cfg.get("dereverb", False))
    return spk


def _inpaint_worker(session: Dict[str, Any], seg: Dict[str, Any], ipkey: str, sr: int) -> Dict[str, Any]:
    """Build the worker speaker config for a Vocal-Inpaint segment: a per-segment,
    timeline-local clone of the segment's own (locked) audio. Uses the channel's
    vocal-processing settings — only the *source voice* differs."""
    chan = dict(session.get("speakers", {}).get(str(seg["speaker_id"]), {}))
    spk: Dict[str, Any] = {
        "mode": "clone",
        "ref_text": None,
        "instruct": chan.get("instruct"),
        "language": chan.get("language"),
        "isolate": False,
        "normalize": False,
        "dereverb": False,
        "dereverb_method": chan.get("dereverb_method", "roformer"),
        "sample_rate": sr,
    }
    ref_fn = session.get("refs", {}).get(ipkey)
    if ref_fn and (_dir(session["id"]) / ref_fn).exists():
        spk["waveform"] = load_audio(_dir(session["id"]) / ref_fn, sr=sr)
    else:
        spk["waveform"] = load_audio(_dir(session["id"]) / seg["inpaint_ref"], sr=sr)
        spk["isolate"] = bool(chan.get("isolate", True))
        spk["normalize"] = bool(chan.get("normalize", True))
        spk["dereverb"] = bool(chan.get("dereverb", False))
    return spk


def _store_refs(session: Dict[str, Any], worker_result: Dict[str, Any], sr: int) -> None:
    """Persist any cleaned references the worker handed back (cold builds), so the
    next regen/insert for that speaker is fast and consistent."""
    for spk_id, wav in (worker_result.get("refs") or {}).items():
        sid = str(spk_id)
        if sid in session.get("refs", {}):
            continue
        fn = f"ref_{sid}.wav"
        save_wav(_dir(session["id"]) / fn, np.asarray(wav, dtype=np.float32), sr)
        session.setdefault("refs", {})[sid] = fn


def regen_payload(sid: str, index: int, text: Optional[str] = None) -> Dict[str, Any]:
    """Single-segment payload for regeneration (optionally with edited text)."""
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
        sr = int(session["sample_rate"])
        # Vocal Inpaint: synthesize against the segment's own locked clone, keyed
        # off the segment index so it never collides with the channel's voice ref.
        if seg.get("inpaint") and seg.get("inpaint_ref") and (_dir(sid) / seg["inpaint_ref"]).exists():
            ipkey = f"ip{int(index)}"
            return {
                "lines": [{"speaker_id": ipkey, "text": seg["text"], "index": int(index)}],
                "speakers": {ipkey: _inpaint_worker(session, seg, ipkey, sr)},
                "params": session.get("params", {}),
                "gap_ms": session.get("gap_ms", 250),
                "multitrack": True,
            }
        spk_id = seg["speaker_id"]
        return {
            "lines": [{"speaker_id": spk_id, "text": seg["text"], "index": int(index)}],
            "speakers": {spk_id: _speaker_worker(session, spk_id, sr)},
            "params": session.get("params", {}),
            "gap_ms": session.get("gap_ms", 250),
            "multitrack": True,
        }


def reserve_index(sid: str) -> int:
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        ni = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        session["next_index"] = ni + 1
        _write(session)
        return ni


def insert_payload(sid: str, speaker_id: str, text: str, new_index: int) -> Dict[str, Any]:
    session = _read(sid)
    if not session:
        raise FileNotFoundError("Session not found")
    sr = int(session["sample_rate"])
    return {
        "lines": [{"speaker_id": str(speaker_id), "text": text, "index": int(new_index)}],
        "speakers": {str(speaker_id): _speaker_worker(session, str(speaker_id), sr)},
        "params": session.get("params", {}),
        "gap_ms": session.get("gap_ms", 250),
        "multitrack": True,
    }


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------
def _controls_endpoint(session: Dict[str, Any], target: Dict[str, Any], start: float, end_old: float) -> bool:
    """Is `target` the segment that defines the timeline at its own endpoint? True
    when it ends alone, or it's the latest-ending clip in its overlap stack. False
    when it's tucked under a longer overlapping clip (so we must NOT shift the
    timeline when it regenerates — that would drag the longer clip's tail)."""
    eps = 1e-3
    for o in session["segments"]:
        if o is target or int(o["index"]) == int(target["index"]):
            continue
        os_ = float(o.get("start_s", 0.0) or 0.0)
        oe = os_ + _eff_duration(o)
        # overlaps target's span AND extends past target's end → target is "under"
        if os_ < end_old - eps and oe > start + eps and oe > end_old + eps:
            return False
    return True


def apply_regen(sid: str, index: int, worker_result: Dict[str, Any]) -> Dict[str, Any]:
    """Replace one segment with a fresh take. Resets trim + speed, keeps position.

    Endpoint-align: if the new take is a different length, ripple downstream clips
    by the delta so the gap after this clip is preserved — but ONLY when this clip
    controls its endpoint (ends alone, or is the longest of its overlap stack).
    A short clip layered under a longer one leaves the timeline untouched."""
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

        start = float(target.get("start_s", 0.0) or 0.0)
        old_eff = _eff_duration(target)
        end_old = start + old_eff
        controls = _controls_endpoint(session, target, start, end_old)

        save_wav(_dir(sid) / target["file"], wav, sr)
        dur = duration_seconds(wav, sr)
        target["raw_duration_s"] = dur
        target["trim_start_s"] = 0.0
        target["trim_end_s"] = dur
        target["speed"] = 1.0
        new_eff = _eff_duration(target)  # speed reset to 1 → == dur

        delta = new_eff - old_eff
        if controls and abs(delta) > 1e-3:
            for o in session["segments"]:
                if int(o["index"]) == int(index):
                    continue
                if float(o.get("start_s", 0.0) or 0.0) >= end_old - 1e-3:
                    o["start_s"] = round(max(0.0, float(o["start_s"]) + delta), 3)

        _store_refs(session, worker_result, sr)
        _stitch(session)
        _write(session)
        return public(session)


def apply_insert(
    sid: str,
    new_index: int,
    speaker_id: str,
    text: str,
    start_s: float,
    ripple: bool,
    worker_result: Dict[str, Any],
) -> Dict[str, Any]:
    """Place a freshly generated segment on the timeline.

    Ripple pushes only DOWNSTREAM clips (those that *start* at/after the insert
    point) out by the new clip's length; clips already in progress keep their
    original end (they layer with the new one)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        segs = worker_result.get("segments") or []
        if not segs:
            raise ValueError("Insert produced no audio")
        sr = int(session["sample_rate"])
        wav = np.asarray(segs[0]["waveform"], dtype=np.float32)
        fn = f"seg_{int(new_index):03d}.wav"
        save_wav(_dir(sid) / fn, wav, sr)
        dur = duration_seconds(wav, sr)
        start_s = max(0.0, float(start_s))

        if ripple:
            for seg in session["segments"]:
                if float(seg.get("start_s", 0.0) or 0.0) >= start_s - 1e-6:
                    seg["start_s"] = round(float(seg["start_s"]) + dur, 3)

        _store_refs(session, worker_result, sr)
        session["segments"].append(
            {
                "index": int(new_index),
                "speaker_id": str(speaker_id),
                "text": text,
                "file": fn,
                "raw_duration_s": dur,
                "trim_start_s": 0.0,
                "trim_end_s": dur,
                "speed": 1.0,
                "start_s": round(start_s, 3),
            }
        )
        _stitch(session)
        _write(session)
        return public(session)


def set_segment(sid: str, index: int, **fields: Any) -> Dict[str, Any]:
    """Update a segment's timeline properties (start_s / trim / speed) and
    re-stitch. No model run."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        rdur = float(seg.get("raw_duration_s", 0.0) or 0.0)
        if fields.get("start_s") is not None:
            seg["start_s"] = round(max(0.0, float(fields["start_s"])), 3)
        if fields.get("trim_start_s") is not None:
            seg["trim_start_s"] = round(max(0.0, min(float(fields["trim_start_s"]), rdur)), 3)
        if fields.get("trim_end_s") is not None:
            seg["trim_end_s"] = round(max(0.0, min(float(fields["trim_end_s"]), rdur)), 3)
        if fields.get("speed") is not None:
            seg["speed"] = float(np.clip(float(fields["speed"]), 0.5, 2.0))
        if fields.get("gain_db") is not None:
            seg["gain_db"] = float(np.clip(float(fields["gain_db"]), -36.0, 36.0))
        _stitch(session)
        _write(session)
        return public(session)


def reflow(sid: str, gap_ms: Optional[int] = None, speed: Optional[float] = None) -> Dict[str, Any]:
    """Re-arrange every segment sequentially (index order) with a global gap and
    optionally a global speed. Tidy-up / global controls — no model run."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        if gap_ms is not None:
            session["gap_ms"] = int(gap_ms)
        if speed is not None:
            sp = float(np.clip(speed, 0.5, 2.0))
            for seg in session["segments"]:
                seg["speed"] = sp
        gap_s = int(session.get("gap_ms", 250)) / 1000.0
        cursor = 0.0
        for seg in sorted(session["segments"], key=lambda s: s["index"]):
            seg["start_s"] = round(cursor, 3)
            cursor += _eff_duration(seg) + gap_s
        _stitch(session)
        _write(session)
        return public(session)


# ---------------------------------------------------------------------------
# Empty sessions + on-the-fly speaker (track) management
# ---------------------------------------------------------------------------
def create_empty(
    title: str,
    speakers_cfg: Dict[str, Dict[str, Any]],
    params: Dict[str, Any],
    gap_ms: int,
) -> Dict[str, Any]:
    """Spin up a blank timeline (no segments) seeded with a speaker roster, so a
    scene can be composed entirely by hand in the multitrack editor."""
    sid = uuid.uuid4().hex[:12]
    d = _dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    speakers = {str(k): {**v, "name": _speaker_name(str(k), v)} for k, v in speakers_cfg.items()}
    session = {
        "id": sid,
        "title": title or "Untitled Scene",
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": time.time(),
        "sample_rate": _SR,
        "gap_ms": int(gap_ms),
        "params": params,
        "speakers": speakers,
        "refs": {},
        "segments": [],
        "next_index": 0,
        "mix_file": "mix.wav",
        "prompt": "",
        "script": "",
    }
    _stitch(session)
    _write(session)
    return public(session)


def add_speaker(sid: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Append a new, empty generative track. Generative IDs stay contiguous 1..N
    (removal renumbers); uploaded audio channels use a separate "a#" namespace."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        nids = [int(k) for k in session.get("speakers", {}) if str(k).isdigit()]
        nid = str((max(nids) + 1) if nids else 1)
        session.setdefault("speakers", {})[nid] = {**cfg, "name": _speaker_name(nid, cfg)}
        _write(session)
        return public(session)


def update_speaker(sid: str, pos: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Update a speaker's config. If the voice changed, drop its cleaned ref so
    the next take cold-builds from the new sample."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        pos = str(pos)
        old = session.get("speakers", {}).get(pos, {})
        voice_changed = old.get("voice") != cfg.get("voice")
        merged = {**cfg, "name": _speaker_name(pos, cfg)}
        # Preserve channel-level controls (gain) and the custom name across config
        # updates — but a voice change resets the custom name back to the default.
        merged["gain_db"] = float(old.get("gain_db", 0.0) or 0.0)
        if not voice_changed and old.get("custom_name"):
            merged["custom_name"] = old["custom_name"]
        session.setdefault("speakers", {})[pos] = merged
        if voice_changed:
            ref_fn = session.get("refs", {}).pop(pos, None)
            if ref_fn:
                (_dir(sid) / ref_fn).unlink(missing_ok=True)
        _write(session)
        return public(session)


def set_channel(sid: str, pos: str, name: Optional[str] = None, gain_db: Optional[float] = None) -> Dict[str, Any]:
    """Set a channel's custom display name and/or output gain (dB). Re-stitches
    when gain changes so the mix reflects the new level."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        cfg = session.get("speakers", {}).get(str(pos))
        if cfg is None:
            raise FileNotFoundError(f"Channel {pos} not found")
        restitch = False
        if name is not None:
            cfg["custom_name"] = name.strip() or None
        if gain_db is not None:
            cfg["gain_db"] = float(np.clip(float(gain_db), -36.0, 36.0))
            restitch = True
        session["speakers"][str(pos)] = cfg
        if restitch:
            _stitch(session)
        _write(session)
        return public(session)


def add_audio_channel(sid: str, name: str, audio: np.ndarray, in_sr: int) -> Dict[str, Any]:
    """Add an uploaded audio file (soundtrack / SFX) as its own channel: a single
    long clip on a non-speaker track that's layered into the mix (no leveling)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        sr = int(session["sample_rate"])
        wav = np.asarray(audio, dtype=np.float32)
        if in_sr and int(in_sr) != sr:
            import librosa

            wav = librosa.resample(wav, orig_sr=int(in_sr), target_sr=sr).astype(np.float32)
        # Audio channels live in their OWN id namespace ("a1", "a2", …) so they
        # never disturb the generative speakers' contiguous 1..N roster mapping.
        aids = [int(k[1:]) for k in session.get("speakers", {}) if str(k).startswith("a") and k[1:].isdigit()]
        pos = "a" + str((max(aids) + 1) if aids else 1)
        nid = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        session["next_index"] = nid + 1
        fn = f"seg_{nid:03d}.wav"
        save_wav(_dir(sid) / fn, wav, sr)
        dur = duration_seconds(wav, sr)
        label = (name or "Audio").strip() or "Audio"
        session.setdefault("speakers", {})[pos] = {
            "mode": "audio",
            "kind": "audio",
            "name": label,
            "custom_name": label,
            "gain_db": 0.0,
        }
        session["segments"].append(
            {
                "index": nid,
                "speaker_id": pos,
                "text": label,
                "file": fn,
                "raw_duration_s": dur,
                "trim_start_s": 0.0,
                "trim_end_s": dur,
                "speed": 1.0,
                "gain_db": 0.0,
                "start_s": 0.0,
            }
        )
        _stitch(session)
        _write(session)
        return public(session)


def channel_regen_payload(sid: str, pos: str) -> Dict[str, Any]:
    """Build a worker payload to regenerate EVERY segment on a speaker channel
    (e.g. after re-casting the voice). Keeps each segment's index for mapping."""
    session = _read(sid)
    if not session:
        raise FileNotFoundError("Session not found")
    cfg = session.get("speakers", {}).get(str(pos), {})
    if cfg.get("kind") == "audio":
        raise ValueError("Cannot regenerate an uploaded audio channel")
    sr = int(session["sample_rate"])
    lines = [
        {"speaker_id": str(pos), "text": s["text"], "index": int(s["index"])}
        for s in sorted(session["segments"], key=lambda x: x["index"])
        if str(s["speaker_id"]) == str(pos) and (s.get("text") or "").strip()
    ]
    if not lines:
        raise ValueError("This channel has no spoken segments to regenerate")
    return {
        "lines": lines,
        "speakers": {str(pos): _speaker_worker(session, str(pos), sr)},
        "params": session.get("params", {}),
        "gap_ms": session.get("gap_ms", 250),
        "multitrack": True,
    }


def apply_channel_regen(sid: str, pos: str, worker_result: Dict[str, Any]) -> Dict[str, Any]:
    """Swap in fresh audio for each regenerated segment on a channel, keeping each
    one's timeline position. Resets per-segment trim/speed (gain is preserved)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        sr = int(session["sample_rate"])
        by_index = {int(s["index"]): s for s in session["segments"]}
        for out in worker_result.get("segments") or []:
            idx = int(out["index"])
            target = by_index.get(idx)
            if target is None:
                continue
            wav = np.asarray(out["waveform"], dtype=np.float32)
            save_wav(_dir(sid) / target["file"], wav, sr)
            dur = duration_seconds(wav, sr)
            target["raw_duration_s"] = dur
            target["trim_start_s"] = 0.0
            target["trim_end_s"] = dur
            target["speed"] = 1.0
        _store_refs(session, worker_result, sr)
        _stitch(session)
        _write(session)
        return public(session)


def remove_speaker(sid: str, pos: str) -> Dict[str, Any]:
    """Remove a track + its segments. For a generative speaker, renumber later
    generative speakers/segments down by one so 1..N stays contiguous (mirrors the
    UI roster). Audio channels ("a#") are removed in place — they're outside the
    numeric namespace, so nothing is renumbered."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        pos = str(pos)
        is_num = pos.isdigit()
        p = int(pos) if is_num else -1
        # Drop the removed track's segment files; renumber only NUMERIC ids above it.
        kept: List[Dict[str, Any]] = []
        for seg in session["segments"]:
            sp = str(seg["speaker_id"])
            if sp == pos:
                (_dir(sid) / seg["file"]).unlink(missing_ok=True)
                continue
            if is_num and sp.isdigit() and int(sp) > p:
                seg["speaker_id"] = str(int(sp) - 1)
            kept.append(seg)
        session["segments"] = kept
        ref_fn = session.get("refs", {}).pop(pos, None)
        if ref_fn:
            (_dir(sid) / ref_fn).unlink(missing_ok=True)
        new_speakers: Dict[str, Any] = {}
        for k, v in session.get("speakers", {}).items():
            if k == pos:
                continue
            if is_num and str(k).isdigit() and int(k) > p:
                nk = str(int(k) - 1)
                new_speakers[nk] = {**v, "name": _speaker_name(nk, v)}
            else:
                new_speakers[k] = v
        session["speakers"] = new_speakers
        new_refs: Dict[str, Any] = {}
        for k, fn in session.get("refs", {}).items():
            if is_num and str(k).isdigit() and int(k) > p:
                new_refs[str(int(k) - 1)] = fn
            else:
                new_refs[k] = fn
        session["refs"] = new_refs
        _stitch(session)
        _write(session)
        return public(session)


# ---------------------------------------------------------------------------
# Segment + timeline structural edits (no model run)
# ---------------------------------------------------------------------------
def delete_segment(sid: str, index: int, ripple: bool = False) -> Dict[str, Any]:
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        start = float(seg.get("start_s", 0.0) or 0.0)
        eff = _eff_duration(seg)
        (_dir(sid) / seg["file"]).unlink(missing_ok=True)
        session["segments"] = [s for s in session["segments"] if int(s["index"]) != int(index)]
        if ripple:
            for s in session["segments"]:
                st = float(s.get("start_s", 0.0) or 0.0)
                if st > start + 1e-6:
                    s["start_s"] = round(max(start, st - eff), 3)
        _stitch(session)
        _write(session)
        return public(session)


def split_segment(sid: str, index: int, at_s: float) -> Dict[str, Any]:
    """Split a clip at an absolute timeline position into two clips (same raw
    audio, duplicated text). Dialogue cleanup is left to the user."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        start = float(seg.get("start_s", 0.0) or 0.0)
        eff = _eff_duration(seg)
        cut = float(at_s)
        if not (start + 0.05 < cut < start + eff - 0.05):
            cut = start + eff / 2.0  # fall back to midpoint if out of range
        offset_eff = cut - start
        sp = float(seg.get("speed", 1.0) or 1.0)
        ts = float(seg.get("trim_start_s", 0.0) or 0.0)
        raw_cut = round(ts + offset_eff * sp, 4)

        nid = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        session["next_index"] = nid + 1
        new_fn = f"seg_{nid:03d}.wav"
        shutil.copyfile(_dir(sid) / seg["file"], _dir(sid) / new_fn)

        right = {
            "index": nid,
            "speaker_id": seg["speaker_id"],
            "text": seg["text"],
            "file": new_fn,
            "raw_duration_s": seg.get("raw_duration_s", 0.0),
            "trim_start_s": raw_cut,
            "trim_end_s": seg.get("trim_end_s", seg.get("raw_duration_s", 0.0)),
            "speed": sp,
            "start_s": round(start + offset_eff, 3),
        }
        seg["trim_end_s"] = raw_cut
        session["segments"].append(right)
        _stitch(session)
        _write(session)
        return public(session)


def add_space(sid: str, start_s: float, amount: float) -> Dict[str, Any]:
    """Insert empty time: push every clip that starts at/after `start_s` later by
    `amount` (inverse of delete_space)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        a = max(0.0, float(start_s))
        w = max(0.0, min(float(amount), 60.0))
        for s in session["segments"]:
            st = float(s.get("start_s", 0.0) or 0.0)
            if st >= a - 1e-6:
                s["start_s"] = round(st + w, 3)
        _stitch(session)
        _write(session)
        return public(session)


def duplicate_segment(sid: str, index: int, start_s: float, ripple: bool = False) -> Dict[str, Any]:
    """Copy a segment (audio + trim/speed/text) to a new spot. No model run."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        src = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if src is None:
            raise FileNotFoundError(f"Segment {index} not found")
        nid = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        session["next_index"] = nid + 1
        new_fn = f"seg_{nid:03d}.wav"
        shutil.copyfile(_dir(sid) / src["file"], _dir(sid) / new_fn)
        start_s = max(0.0, float(start_s))
        dur = _eff_duration(src)
        if ripple:
            for s in session["segments"]:
                if float(s.get("start_s", 0.0) or 0.0) >= start_s - 1e-6:
                    s["start_s"] = round(float(s["start_s"]) + dur, 3)
        session["segments"].append(
            {
                "index": nid,
                "speaker_id": src["speaker_id"],
                "text": src["text"],
                "file": new_fn,
                "raw_duration_s": src.get("raw_duration_s", 0.0),
                "trim_start_s": src.get("trim_start_s", 0.0),
                "trim_end_s": src.get("trim_end_s", src.get("raw_duration_s", 0.0)),
                "speed": src.get("speed", 1.0),
                "start_s": round(start_s, 3),
            }
        )
        _stitch(session)
        _write(session)
        return public(session)


def auto_slice(sid: str, index: int, sentences: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Split a segment into one clip per sentence, given sentence boundaries in
    *audible* time (Whisper timestamps on the rendered clip). Each slice carries
    its own trimmed audio + sentence text, keeps the original speed/gain, and the
    slices are laid back-to-back from the original start so the timeline (and any
    downstream clips) is unchanged. No model run here — caller does the ASR."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        sr = int(session["sample_rate"])
        raw = load_audio(_dir(sid) / seg["file"], sr=sr)
        rdur = len(raw) / sr
        ts = max(0.0, min(float(seg.get("trim_start_s", 0.0) or 0.0), rdur))
        te = seg.get("trim_end_s")
        te = float(te) if te else rdur
        te = max(ts, min(te, rdur))
        speed = float(seg.get("speed", 1.0) or 1.0)
        gain = float(seg.get("gain_db", 0.0) or 0.0)
        spk = seg["speaker_id"]
        eff = max(0.0, (te - ts) / (speed if speed > 0 else 1.0))

        # Clean + clamp sentence boundaries (audible seconds), keep order.
        clean = []
        for s in sentences:
            txt = (s.get("text") or "").strip()
            st = s.get("start")
            en = s.get("end")
            if not txt:
                continue
            clean.append({"text": txt, "start": float(st) if st is not None else None, "end": float(en) if en is not None else None})
        if len(clean) < 2:
            raise ValueError("Not enough sentences to slice (need at least 2).")

        next_id = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        new_segs: List[Dict[str, Any]] = []
        place = float(seg.get("start_s", 0.0) or 0.0)
        prev_a_end = 0.0
        for i, s in enumerate(clean):
            a_start = 0.0 if i == 0 else prev_a_end
            a_end = eff if i == len(clean) - 1 else (s["end"] if s["end"] is not None else eff)
            a_end = max(a_start, min(a_end, eff))
            # audible → raw offset from the trim-in point
            rs = ts + a_start * speed
            re = ts + a_end * speed
            rs = max(ts, min(rs, te))
            re = max(rs, min(re, te))
            slice_raw = raw[int(round(rs * sr)) : int(round(re * sr))]
            if slice_raw.size < int(0.05 * sr):  # skip slivers < 50ms
                prev_a_end = a_end
                continue
            fn = f"seg_{next_id:03d}.wav"
            save_wav(_dir(sid) / fn, slice_raw.astype(np.float32), sr)
            dur = len(slice_raw) / sr
            new_segs.append(
                {
                    "index": next_id,
                    "speaker_id": spk,
                    "text": s["text"],
                    "file": fn,
                    "raw_duration_s": round(dur, 3),
                    "trim_start_s": 0.0,
                    "trim_end_s": round(dur, 3),
                    "speed": speed,
                    "gain_db": gain,
                    "start_s": round(place, 3),
                }
            )
            next_id += 1
            place += dur / (speed if speed > 0 else 1.0)
            prev_a_end = a_end

        if len(new_segs) < 2:
            raise ValueError("Auto-slice produced fewer than 2 usable clips.")

        # Replace the original segment with the slices.
        (_dir(sid) / seg["file"]).unlink(missing_ok=True)
        session["segments"] = [s for s in session["segments"] if int(s["index"]) != int(index)]
        session["segments"].extend(new_segs)
        session["next_index"] = next_id
        _stitch(session)
        _write(session)
        return public(session)


def clone_source(sid: str, index: int) -> tuple:
    """Return a segment's trimmed raw audio (no speed/leveling) for use as a clone
    source (Vocal Inpaint / promotion). Returns (audio, sr)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        sr = int(session["sample_rate"])
        raw = load_audio(_dir(sid) / seg["file"], sr=sr)
        rdur = len(raw) / sr
        ts = max(0.0, min(float(seg.get("trim_start_s", 0.0) or 0.0), rdur))
        te = seg.get("trim_end_s")
        te = float(te) if te else rdur
        te = max(ts, min(te, rdur))
        clip = raw[int(ts * sr) : int(te * sr)]
        return (clip.astype(np.float32) if clip.size else raw.astype(np.float32)), sr


def set_inpaint(sid: str, index: int, enabled: bool, prepped: Optional[np.ndarray] = None, prepped_sr: Optional[int] = None) -> Dict[str, Any]:
    """Toggle Vocal Inpaint on a segment. When enabling, `prepped` is the cleaned,
    length-bounded clone source (caller does the Whisper word-boundary trim); it's
    stored as the segment's locked voice and any cached cleaned ref is dropped so
    the next regen cold-builds. Disabling keeps the file (lazy) and just unlocks."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        if enabled:
            if prepped is None or prepped.size == 0:
                raise ValueError("No usable audio to lock as the inpaint source.")
            sr = int(prepped_sr or session["sample_rate"])
            fn = f"inpaint_src_{int(index):03d}.wav"
            save_wav(_dir(sid) / fn, np.asarray(prepped, dtype=np.float32), sr)
            seg["inpaint"] = True
            seg["inpaint_ref"] = fn
            # Re-locking re-captures the voice: drop the cached cleaned inpaint ref.
            ipkey = f"ip{int(index)}"
            old = session.get("refs", {}).pop(ipkey, None)
            if old:
                (_dir(sid) / old).unlink(missing_ok=True)
        else:
            seg["inpaint"] = False  # leave inpaint_ref + cleaned ref on disk (lazy)
        _write(session)
        return public(session)


def channel_info(sid: str, pos: str) -> Dict[str, Any]:
    """Lightweight read of a channel: its kind, name, ordered segment indices and
    the best segment to clone from (the longest one)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        cfg = session.get("speakers", {}).get(str(pos))
        if cfg is None:
            raise FileNotFoundError(f"Channel {pos} not found")
        segs = [s for s in session["segments"] if str(s["speaker_id"]) == str(pos)]
        segs.sort(key=lambda s: float(s.get("start_s", 0.0) or 0.0))
        clone_index = None
        if segs:
            clone_index = int(max(segs, key=lambda s: float(s.get("raw_duration_s", 0.0) or 0.0))["index"])
        return {
            "kind": cfg.get("kind", "speaker"),
            "name": cfg.get("custom_name") or cfg.get("name") or f"Voice {pos}",
            "gain_db": float(cfg.get("gain_db", 0.0) or 0.0),
            "indices": [int(s["index"]) for s in segs],
            "clone_index": clone_index,
        }


def promote_channel(sid: str, pos: str, prepped: np.ndarray, prepped_sr: int, label: str, transcripts: Optional[Dict[int, str]] = None) -> Dict[str, Any]:
    """Promote an uploaded AUDIO channel into a brand-new generative clone speaker.
    The channel's clips are re-attributed to the new speaker (last slot, like a
    fresh "+ Add speaker"), dialogue filled in from `transcripts`, and the old
    external channel is destroyed. `prepped` is the length-bounded clone source,
    cold-built into a clean ref on the new speaker's first generation."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        cfg = session.get("speakers", {}).get(str(pos))
        if cfg is None:
            raise FileNotFoundError(f"Channel {pos} not found")
        if cfg.get("kind") != "audio":
            raise ValueError("Only uploaded audio channels can be promoted")
        if prepped is None or prepped.size == 0:
            raise ValueError("No usable audio to promote.")
        sr = int(prepped_sr or session["sample_rate"])
        nids = [int(k) for k in session.get("speakers", {}) if str(k).isdigit()]
        new_pos = str((max(nids) + 1) if nids else 1)
        fn = f"promoted_{new_pos}.wav"
        save_wav(_dir(sid) / fn, np.asarray(prepped, dtype=np.float32), sr)
        name = (label or f"Speaker {new_pos}").strip() or f"Speaker {new_pos}"
        session.setdefault("speakers", {})[new_pos] = {
            "mode": "clone",
            "kind": "speaker",
            "voice": None,
            "local_source": fn,
            "isolate": True,
            "normalize": True,
            "dereverb": False,
            "dereverb_method": "roformer",
            "name": name,
            "custom_name": name,
            "gain_db": float(cfg.get("gain_db", 0.0) or 0.0),
        }
        # Move the channel's clips onto the new generative track + fill dialogue.
        tx = transcripts or {}
        for s in session["segments"]:
            if str(s["speaker_id"]) == str(pos):
                s["speaker_id"] = new_pos
                t = tx.get(int(s["index"]))
                if t:
                    s["text"] = t
        # Destroy the old external channel (its clips now live on the new speaker).
        session["speakers"].pop(str(pos), None)
        _stitch(session)
        _write(session)
        return public(session)


def render_segment(sid: str, index: int, overrides: Optional[Dict[str, Any]] = None) -> tuple:
    """Render a single segment exactly as it sits in the mix (trim + speed +
    leveling). Returns (audio, sr, name, start). Used for accurate solo preview /
    download and Whisper alignment. `overrides` (trim_start_s/trim_end_s/speed)
    renders a not-yet-saved trim draft without persisting it."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        if overrides:
            seg = {**seg, **{k: v for k, v in overrides.items() if v is not None}}
        sr = int(session["sample_rate"])
        params = session.get("params", {})
        spk = session.get("speakers", {}).get(str(seg["speaker_id"]), {})
        is_audio = spk.get("kind") == "audio"
        level = bool(params.get("match_loudness", True)) and not is_audio
        target = float(params.get("target_lufs", -20.0))
        clip = _render_clip(_dir(sid), seg, sr, level, target, extra_gain_db=float(spk.get("gain_db", 0.0) or 0.0))
        if clip.size and level:
            clip = peak_limit(clip, ceiling_db=float(params.get("peak_ceiling_db", -1.0)))
        name = spk.get("custom_name") or spk.get("name") or _speaker_name(str(seg["speaker_id"]), spk)
        return clip if clip.size else np.zeros(1, dtype=np.float32), sr, name, float(seg.get("start_s", 0.0) or 0.0)


def set_segment_text(sid: str, index: int, text: str) -> Dict[str, Any]:
    """Set a segment's dialogue text WITHOUT touching its audio. Used to align the
    displayed line to the actual sample (manual edit in the trim panel / Whisper),
    so it intentionally does not flag the clip as needing regeneration."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        seg["text"] = (text or "").strip()
        _write(session)
        return public(session)


def delete_space(sid: str, start_s: float, amount: float) -> Dict[str, Any]:
    """Ripple-delete empty time: pull every clip that starts after `start_s` up by
    `amount` (clamped so nothing crosses the slice point). Clips are not chopped."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        a = max(0.0, float(start_s))
        w = max(0.0, float(amount))
        for s in session["segments"]:
            st = float(s.get("start_s", 0.0) or 0.0)
            if st > a + 1e-6:
                s["start_s"] = round(max(a, st - w), 3)
        _stitch(session)
        _write(session)
        return public(session)


def discard(sid: str) -> None:
    """Delete a session directory (e.g. an abandoned empty skeleton)."""
    shutil.rmtree(_dir(sid), ignore_errors=True)
    shutil.rmtree(_undo_dir(sid), ignore_errors=True)


def _undo_dir(sid: str) -> Path:
    return SESSIONS_DIR / f"{sid}__undo"


def checkpoint(sid: str) -> None:
    """Snapshot the current session for single-step undo. Copies the manifest +
    per-segment audio; the large, regenerable mix is skipped (rebuilt on undo).
    Overwrites any previous snapshot — only ONE step back is kept on purpose."""
    with _lock:
        src = _dir(sid)
        sess = _read(sid)
        if not sess:
            return
        mix = sess.get("mix_file")
        dst = _undo_dir(sid)
        if dst.exists():
            shutil.rmtree(dst, ignore_errors=True)
        dst.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            if f.is_file() and f.name != mix:
                shutil.copy2(f, dst / f.name)


def can_undo(sid: str) -> bool:
    return _undo_dir(sid).exists()


def undo(sid: str) -> Dict[str, Any]:
    """Restore the last checkpoint (one step back), then rebuild the mix."""
    with _lock:
        dst = _undo_dir(sid)
        if not dst.exists():
            raise FileNotFoundError("Nothing to undo")
        src = _dir(sid)
        for f in src.iterdir():
            if f.is_file():
                f.unlink()
        for f in dst.iterdir():
            if f.is_file():
                shutil.copy2(f, src / f.name)
        shutil.rmtree(dst, ignore_errors=True)
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        _stitch(session)
        _write(session)
        return public(session)


# ---------------------------------------------------------------------------
# Finalize + file serving
# ---------------------------------------------------------------------------
def finalize_info(sid: str) -> Dict[str, Any]:
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        full = _stitch(session)
        _write(session)
        ordered = sorted(session["segments"], key=lambda s: (float(s.get("start_s", 0.0) or 0.0), s["index"]))
        script = "\n".join(f"Speaker {s['speaker_id']}: {s['text']}" for s in ordered)
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
    base = _dir(sid).resolve()
    target = (base / name).resolve()
    if base != target and base not in target.parents:
        raise ValueError("Path escapes the session.")
    if not target.exists():
        raise FileNotFoundError(name)
    return target
