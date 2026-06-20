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
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .audio_utils import (
    duration_seconds,
    load_audio,
    match_loudness,
    peak_limit,
    save_wav,
    time_stretch,
)
from .config import OUTPUT_DIR, settings

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
    clip = _apply_fades(clip, seg, sr)
    seg["duration_s"] = round(len(clip) / sr, 3) if clip.size else 0.0
    return clip.astype(np.float32)


def _apply_fades(clip: np.ndarray, seg: Dict[str, Any], sr: int) -> np.ndarray:
    """Linear fade-in/out envelopes over the rendered (post-trim/speed) clip.
    Fade times are audible seconds; overlapping fades multiply, so a short clip
    with long fades degrades gracefully into a triangle instead of clipping."""
    fi = float(seg.get("fade_in_s", 0.0) or 0.0)
    fo = float(seg.get("fade_out_s", 0.0) or 0.0)
    if clip.size == 0 or (fi <= 1e-3 and fo <= 1e-3):
        return clip
    n = len(clip)
    env = np.ones(n, dtype=np.float32)
    nfi = min(n, int(fi * sr))
    nfo = min(n, int(fo * sr))
    if nfi > 1:
        env[:nfi] *= np.linspace(0.0, 1.0, nfi, dtype=np.float32)
    if nfo > 1:
        env[n - nfo :] *= np.linspace(1.0, 0.0, nfo, dtype=np.float32)
    return (clip * env).astype(np.float32)


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
        if chan.get("muted"):  # muted track: keep its clips on disk, just drop from the mix
            continue
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


def render_mix(sid: str) -> Tuple[np.ndarray, int, str]:
    """Re-stitch the full timeline and hand back the mix samples + a title for
    on-demand download (encoded into the configured FLAC/MP3 format by the
    caller). Re-stitching guarantees the download matches the live edit."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        sr = int(session["sample_rate"])
        full = _stitch(session)
        _write(session)
        title = str(session.get("title") or "scene")
        return full, sr, title


def segment_text(sid: str, index: int) -> str:
    """A segment's current dialogue text ('' when missing)."""
    with _lock:
        session = _read(sid)
        if not session:
            return ""
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        return str(seg.get("text") or "") if seg else ""


def voice_segment_indices(sid: str) -> List[int]:
    """Indices of segments on generative (voice) tracks, in timeline order —
    the targets for sentence auto-slicing. Uploaded audio channels are skipped
    (slicing music/SFX by 'sentence' makes no sense)."""
    with _lock:
        session = _read(sid)
        if not session:
            return []
        segs = sorted(
            session["segments"],
            key=lambda s: (float(s.get("start_s", 0.0) or 0.0), int(s["index"])),
        )
        out: List[int] = []
        for s in segs:
            if _channel_of(session, s["speaker_id"]).get("kind") == "audio":
                continue
            out.append(int(s["index"]))
        return out


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
    # A user-arranged track order (drag / arrows) wins; ids it doesn't know about
    # (e.g. a speaker added since) fall back to roster order at the end.
    saved = [str(k) for k in session.get("track_order", []) if str(k) in all_ids]
    if saved:
        order = saved + [k for k in order if k not in saved]

    def _rev(fn: str) -> int:
        # Cheap content marker so the UI can cache per-clip waveform peaks across
        # the cache-busted URLs public() hands out on every call.
        try:
            return int((_dir(sid) / fn).stat().st_mtime)
        except OSError:
            return 0

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
                "fade_in_s": round(float(s.get("fade_in_s", 0.0) or 0.0), 3),
                "fade_out_s": round(float(s.get("fade_out_s", 0.0) or 0.0), 3),
                "rev": _rev(s["file"]),
                "inpaint": bool(s.get("inpaint", False)),
                "has_bed": bool(s.get("inpaint_bed")),
                "preserve_nonvocal": bool(s.get("preserve_nonvocal", False)),
                # Baked-in per-segment vocal transforms (None = clip is original).
                "fx": s.get("transforms") or None,
                "perform": (
                    {
                        "mode": s["perform"].get("mode", "character"),
                        "strength": int(s["perform"].get("strength", 3)),
                        "gain_db": float(s["perform"].get("gain_db", 0.0) or 0.0),
                        "speed": float(s["perform"].get("speed", 1.0) or 1.0),
                        "transforms": s["perform"].get("transforms") or None,
                        "auto_pitch": bool(s["perform"].get("auto_pitch", False)),
                        "clean_isolate": bool(s["perform"].get("clean_isolate", False)),
                        "clean_dereverb": bool(s["perform"].get("clean_dereverb", False)),
                        "dirty": bool(s["perform"].get("dirty", False)),
                        "url": seg_url(s["perform"]["file"]),
                    }
                    if s.get("perform") and s["perform"].get("file")
                    else None
                ),
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
                "voice": cfg.get("voice") or None,
                "custom_name": custom_name,
                "gain_db": float(cfg.get("gain_db", 0.0) or 0.0),
                "muted": bool(cfg.get("muted", False)),
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


def _perform_line(session: Dict[str, Any], seg: Dict[str, Any], sr: int) -> Optional[Dict[str, Any]]:
    """Build the worker `perform` payload for a segment in vocal-performance
    mode: the recorded take with its dB boost and speed baked in."""
    pf = seg.get("perform")
    if not pf or not pf.get("file"):
        return None
    path = _dir(session["id"]) / pf["file"]
    if not path.exists():
        return None
    wav = load_audio(path, sr=sr)
    gain = float(pf.get("gain_db", 0.0) or 0.0)
    if abs(gain) > 1e-3:
        wav = np.clip(wav * (10.0 ** (gain / 20.0)), -1.0, 1.0).astype(np.float32)
    # Vocal transforms (pitch/formant/character fx) reshape the take before it's
    # tokenized, so the model clones a performance already in the target's range.
    # Auto pitch-match transparently folds a take→target f0 shift into the pitch.
    from .voice_transforms import apply_transforms, auto_pitch_shift, has_effect

    tf = dict(pf.get("transforms") or {})
    if pf.get("auto_pitch"):
        voice_id = session.get("speakers", {}).get(str(seg.get("speaker_id")), {}).get("voice")
        if voice_id:
            try:
                from . import voices as _voices

                shift = auto_pitch_shift(wav, sr, str(_voices.resolve_voice_path(voice_id)))
                if abs(shift) > 1e-3:
                    tf["pitch"] = float(tf.get("pitch", 0.0)) + shift
            except (FileNotFoundError, ValueError):
                pass  # no resolvable target — skip auto-match
    if tf and has_effect(tf):
        wav = apply_transforms(wav, sr, tf)
    speed = float(pf.get("speed", 1.0) or 1.0)
    if abs(speed - 1.0) > 1e-3:
        wav = time_stretch(wav, speed)
    return {
        "waveform": wav,
        "sample_rate": sr,
        "mode": pf.get("mode", "character"),
        "strength": int(pf.get("strength", 3)),
        "seed": pf.get("seed"),
    }


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


def regen_payload(
    sid: str, index: int, text: Optional[str] = None, plain: bool = False
) -> Dict[str, Any]:
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
        # V2V: ride the recorded take — unless the caller asked for a plain TTS
        # render (Capture Performance off), which must use the channel voice only.
        perform = None if plain else _perform_line(session, seg, sr)
        # Vocal Inpaint: synthesize against the segment's own locked clone, keyed
        # off the segment index so it never collides with the channel's voice ref.
        if seg.get("inpaint") and seg.get("inpaint_ref") and (_dir(sid) / seg["inpaint_ref"]).exists():
            ipkey = f"ip{int(index)}"
            line = {"speaker_id": ipkey, "text": seg["text"], "index": int(index)}
            if perform:
                line["perform"] = perform
            return {
                "lines": [line],
                "speakers": {ipkey: _inpaint_worker(session, seg, ipkey, sr)},
                "params": session.get("params", {}),
                "gap_ms": session.get("gap_ms", 250),
                "low_vram": settings.low_vram,
                "trim_silence": settings.trim_silence,
                "multitrack": True,
            }
        spk_id = seg["speaker_id"]
        spk = _speaker_worker(session, spk_id, sr)
        if perform and spk.get("mode") != "clone":
            # Performance transfer needs a voice reference. Channels without a
            # clone (auto/design) fall back to the segment's own current audio —
            # the established voice IS the target.
            spk = {
                **spk,
                "mode": "clone",
                "waveform": load_audio(_dir(sid) / seg["file"], sr=sr),
                "isolate": False,
                "normalize": True,
                "dereverb": False,
            }
        line = {"speaker_id": spk_id, "text": seg["text"], "index": int(index)}
        if perform:
            line["perform"] = perform
        return {
            "lines": [line],
            "speakers": {spk_id: spk},
            "params": session.get("params", {}),
            "gap_ms": session.get("gap_ms", 250),
            "low_vram": settings.low_vram,
            "trim_silence": settings.trim_silence,
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
        "low_vram": settings.low_vram,
        "trim_silence": settings.trim_silence,
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


def _ripple_endpoint(session: Dict[str, Any], index: int, end_old: float, delta: float, controls: bool) -> None:
    """When a regenerated clip controls its endpoint, shift everything downstream
    by the length delta so the gap after it is preserved."""
    if not controls or abs(delta) <= 1e-3:
        return
    for o in session["segments"]:
        if int(o["index"]) == int(index):
            continue
        if float(o.get("start_s", 0.0) or 0.0) >= end_old - 1e-3:
            o["start_s"] = round(max(0.0, float(o["start_s"]) + delta), 3)


def _apply_bed(sid: str, seg: Dict[str, Any], vocal: np.ndarray, sr: int) -> np.ndarray:
    """Vocal Inpaint "Preserve non-vocal": sum the captured background bed under a
    freshly-generated voice take. The bed is trimmed to the voice length (the clip
    tracks the voice) — if the voice is longer, the bed simply runs out."""
    if not (seg.get("inpaint") and seg.get("preserve_nonvocal") and seg.get("inpaint_bed")):
        return vocal
    bed_path = _dir(sid) / seg["inpaint_bed"]
    if not bed_path.exists():
        return vocal
    bed = load_audio(bed_path, sr=sr)
    out = np.asarray(vocal, dtype=np.float32).copy()
    n = min(len(out), len(bed))
    if n > 0:
        out[:n] = out[:n] + bed[:n]
    return peak_limit(out)


def apply_regen(
    sid: str, index: int, worker_result: Dict[str, Any], perform_rendered: bool = True
) -> Dict[str, Any]:
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

        wav = _apply_bed(sid, target, wav, sr)  # Vocal Inpaint: re-add non-vocal bed
        save_wav(_dir(sid) / target["file"], wav, sr)
        # Fresh take → any baked per-segment transforms (and their stash) are stale.
        if target.get("fx_orig"):
            (_dir(sid) / target["fx_orig"]).unlink(missing_ok=True)
        target.pop("fx_orig", None)
        target.pop("transforms", None)
        dur = duration_seconds(wav, sr)
        target["raw_duration_s"] = dur
        target["trim_start_s"] = 0.0
        target["trim_end_s"] = dur
        target["speed"] = 1.0
        new_eff = _eff_duration(target)  # speed reset to 1 → == dur

        _ripple_endpoint(session, int(index), end_old, new_eff - old_eff, controls)

        if perform_rendered and target.get("perform"):
            target["perform"]["dirty"] = False  # take has been rendered

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


def import_clip(sid: str, speaker_id: str, text: str, start_s: float, source: Path) -> Dict[str, Any]:
    """Drop an existing audio file (e.g. a Voice Clone output) onto a track as a
    regular segment — no model run, no ripple. The clip keeps full editability:
    move / trim / regen / perform all work on it afterwards."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        if str(speaker_id) not in session.get("speakers", {}):
            raise FileNotFoundError(f"Speaker {speaker_id} not found")
        sr = int(session["sample_rate"])
        wav = load_audio(source, sr=sr)
        new_index = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        session["next_index"] = new_index + 1
        fn = f"seg_{new_index:03d}.wav"
        save_wav(_dir(sid) / fn, wav, sr)
        dur = duration_seconds(wav, sr)
        session["segments"].append(
            {
                "index": new_index,
                "speaker_id": str(speaker_id),
                "text": (text or "").strip(),
                "file": fn,
                "raw_duration_s": dur,
                "trim_start_s": 0.0,
                "trim_end_s": dur,
                "speed": 1.0,
                "start_s": round(max(0.0, float(start_s)), 3),
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
        if fields.get("fade_in_s") is not None:
            seg["fade_in_s"] = round(float(np.clip(float(fields["fade_in_s"]), 0.0, 30.0)), 3)
        if fields.get("fade_out_s") is not None:
            seg["fade_out_s"] = round(float(np.clip(float(fields["fade_out_s"]), 0.0, 30.0)), 3)
        _stitch(session)
        _write(session)
        return public(session)


def move_segment(sid: str, index: int, speaker_id: str, start_s: Optional[float] = None) -> Dict[str, Any]:
    """Re-home a segment onto another track (and optionally a new start). The
    audio is untouched — the clip keeps its current take until the user chooses
    to regenerate it in the new channel's voice."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        dst = session.get("speakers", {}).get(str(speaker_id))
        if dst is None:
            raise FileNotFoundError(f"Channel {speaker_id} not found")
        src = _channel_of(session, seg["speaker_id"])
        if (dst.get("kind") == "audio") != (src.get("kind") == "audio"):
            raise ValueError("Clips can only move between tracks of the same kind")
        seg["speaker_id"] = str(speaker_id)
        if start_s is not None:
            seg["start_s"] = round(max(0.0, float(start_s)), 3)
        # Re-stitch: the destination channel's gain/mute may differ.
        _stitch(session)
        _write(session)
        return public(session)


def reorder_tracks(sid: str, order: List[str]) -> Dict[str, Any]:
    """Reorder the timeline's tracks. Purely organizational — the mix is additive
    so nothing is re-rendered. Generative speakers are renumbered so top-to-bottom
    is always Speaker 1..N: configs, refs and segments are re-attributed together,
    so every clip keeps its own voice, text and audio."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        req = [str(k) for k in order]
        existing = set(session.get("speakers", {}))
        if len(req) != len(existing) or set(req) != existing:
            raise ValueError("Track order must list every track exactly once")
        nums = [k for k in req if k.isdigit()]
        ren = {old: str(i + 1) for i, old in enumerate(nums)}

        def m(k: str) -> str:
            return ren.get(str(k), str(k))

        session["speakers"] = {
            m(k): ({**v, "name": _speaker_name(m(k), v)} if str(k).isdigit() else v)
            for k, v in session.get("speakers", {}).items()
        }
        session["refs"] = {m(k) if str(k).isdigit() else str(k): v for k, v in session.get("refs", {}).items()}
        for s in session["segments"]:
            s["speaker_id"] = m(str(s["speaker_id"]))
        session["track_order"] = [m(k) for k in req]
        _write(session)
        return public(session)


def segment_peaks(sid: str, index: int, n: int = 800) -> Dict[str, Any]:
    """Coarse max-abs amplitude bins over a segment's FULL raw audio (pre-trim).
    The UI slices the trim window out client-side, so one fetch survives any
    amount of trim/fade/gain dragging."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        sr = int(session["sample_rate"])
        raw = load_audio(_dir(sid) / seg["file"], sr=sr)
        if raw.size == 0:
            return {"index": int(index), "peaks": [], "raw_duration_s": 0.0}
        n = max(16, min(int(n), 8000))
        block = max(1, int(np.ceil(len(raw) / n)))
        m = int(np.ceil(len(raw) / block))
        a = np.abs(raw)
        a = np.pad(a, (0, m * block - len(a)))
        peaks = a.reshape(m, block).max(axis=1)
        return {
            "index": int(index),
            "peaks": [round(float(x), 4) for x in peaks],
            "raw_duration_s": round(len(raw) / sr, 3),
        }


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
        if session.get("track_order"):
            session["track_order"].append(nid)
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


def set_channel(sid: str, pos: str, name: Optional[str] = None, gain_db: Optional[float] = None, muted: Optional[bool] = None) -> Dict[str, Any]:
    """Set a channel's custom display name, output gain (dB) and/or mute state.
    Re-stitches when gain or mute changes so the mix reflects it."""
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
        if muted is not None:
            cfg["muted"] = bool(muted)
            restitch = True
        session["speakers"][str(pos)] = cfg
        if restitch:
            _stitch(session)
        _write(session)
        return public(session)


def add_audio_channel(
    sid: str, name: str, audio: np.ndarray, in_sr: int, start_s: float = 0.0
) -> Dict[str, Any]:
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
        if session.get("track_order"):
            session["track_order"].append(pos)
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
                "start_s": round(max(0.0, float(start_s)), 3),
            }
        )
        _stitch(session)
        _write(session)
        return public(session)


def add_audio_segment(
    sid: str,
    pos: str,
    audio: np.ndarray,
    in_sr: int,
    name: str = "",
    start_s: float = 0.0,
    ripple: bool = False,
) -> Dict[str, Any]:
    """Drop an uploaded audio sample as a NEW clip on an EXISTING audio channel
    (quick foley/SFX without spawning a track). `ripple` pushes every clip that
    starts at/after the drop point later by the new clip's duration."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        spk = session.get("speakers", {}).get(str(pos))
        if spk is None:
            raise FileNotFoundError(f"Channel {pos} not found")
        if spk.get("kind") != "audio":
            raise ValueError("Target is not an uploaded audio channel")
        sr = int(session["sample_rate"])
        wav = np.asarray(audio, dtype=np.float32)
        if in_sr and int(in_sr) != sr:
            import librosa

            wav = librosa.resample(wav, orig_sr=int(in_sr), target_sr=sr).astype(np.float32)
        nid = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        session["next_index"] = nid + 1
        fn = f"seg_{nid:03d}.wav"
        save_wav(_dir(sid) / fn, wav, sr)
        dur = duration_seconds(wav, sr)
        start = max(0.0, float(start_s))
        if ripple:
            for s in session["segments"]:
                if float(s.get("start_s", 0.0) or 0.0) >= start - 1e-6:
                    s["start_s"] = round(float(s["start_s"]) + dur, 3)
        label = (name or "").strip() or "Audio"
        session["segments"].append(
            {
                "index": nid,
                "speaker_id": str(pos),
                "text": label,
                "file": fn,
                "raw_duration_s": dur,
                "trim_start_s": 0.0,
                "trim_end_s": dur,
                "speed": 1.0,
                "gain_db": 0.0,
                "start_s": round(start, 3),
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
    base_spk = _speaker_worker(session, str(pos), sr)
    speakers: Dict[str, Any] = {str(pos): base_spk}
    lines: List[Dict[str, Any]] = []
    for s in sorted(session["segments"], key=lambda x: x["index"]):
        if str(s["speaker_id"]) != str(pos) or not (s.get("text") or "").strip():
            continue
        line: Dict[str, Any] = {"speaker_id": str(pos), "text": s["text"], "index": int(s["index"])}
        # Segments with a saved vocal performance keep riding their take through
        # a channel-wide regen (e.g. re-casting the voice) instead of falling
        # back to a generic clone read.
        perform = _perform_line(session, s, sr)
        if perform:
            line["perform"] = perform
            if base_spk.get("mode") != "clone":
                # Same fallback as single-segment regen: V2V needs a voice
                # reference, so non-clone channels use the segment's own audio.
                key = f"pf{int(s['index'])}"
                speakers[key] = {
                    **base_spk,
                    "mode": "clone",
                    "waveform": load_audio(_dir(sid) / s["file"], sr=sr),
                    "isolate": False,
                    "normalize": True,
                    "dereverb": False,
                }
                line["speaker_id"] = key
        lines.append(line)
    if not lines:
        raise ValueError("This channel has no spoken segments to regenerate")
    return {
        "lines": lines,
        "speakers": speakers,
        "params": session.get("params", {}),
        "gap_ms": session.get("gap_ms", 250),
        "low_vram": settings.low_vram,
        "trim_silence": settings.trim_silence,
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
        outs = {int(o["index"]): o for o in (worker_result.get("segments") or [])}
        # Apply each regenerated clip in timeline order, rippling the timeline by
        # the same smart endpoint-align rules as a single regen so lines that grow
        # or shrink keep the scene's spacing intact.
        for idx in sorted(outs, key=lambda i: float(by_index.get(i, {}).get("start_s", 0.0) or 0.0)):
            target = by_index.get(idx)
            if target is None:
                continue
            start = float(target.get("start_s", 0.0) or 0.0)
            old_eff = _eff_duration(target)
            end_old = start + old_eff
            controls = _controls_endpoint(session, target, start, end_old)
            wav = np.asarray(outs[idx]["waveform"], dtype=np.float32)
            save_wav(_dir(sid) / target["file"], wav, sr)
            dur = duration_seconds(wav, sr)
            target["raw_duration_s"] = dur
            target["trim_start_s"] = 0.0
            target["trim_end_s"] = dur
            target["speed"] = 1.0
            _ripple_endpoint(session, idx, end_old, _eff_duration(target) - old_eff, controls)
            if target.get("perform"):
                target["perform"]["dirty"] = False  # take re-rendered with the channel
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
        if len(session.get("speakers", {})) <= 1:
            raise ValueError("Can't delete the last track — a scene needs at least one.")
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
        if session.get("track_order"):
            session["track_order"] = [
                str(int(k) - 1) if is_num and str(k).isdigit() and int(k) > p else str(k)
                for k in session["track_order"]
                if str(k) != pos
            ]
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
            # The outer fades follow their ends; the fresh cut itself is clean.
            "fade_in_s": 0.0,
            "fade_out_s": float(seg.get("fade_out_s", 0.0) or 0.0),
        }
        seg["trim_end_s"] = raw_cut
        seg["fade_out_s"] = 0.0
        session["segments"].append(right)
        _stitch(session)
        _write(session)
        return public(session)


def _bake_clip(d: Path, seg: Dict[str, Any], sr: int) -> np.ndarray:
    """Render a segment's audio with trim + speed + per-segment gain baked in, at
    raw level (no LUFS leveling, no channel gain — those still apply at stitch)."""
    raw = load_audio(d / seg["file"], sr=sr)
    rdur = len(raw) / sr
    ts = max(0.0, min(float(seg.get("trim_start_s", 0.0) or 0.0), rdur))
    te = seg.get("trim_end_s")
    te = float(te) if te else rdur
    te = max(ts, min(te, rdur))
    clip = raw[int(ts * sr) : int(te * sr)]
    speed = float(seg.get("speed", 1.0) or 1.0)
    if abs(speed - 1.0) > 1e-3 and clip.size:
        clip = time_stretch(clip, speed)
    g = float(seg.get("gain_db", 0.0) or 0.0)
    if clip.size and abs(g) > 1e-3:
        clip = clip * float(10.0 ** (g / 20.0))
    clip = _apply_fades(clip, seg, sr)
    return clip.astype(np.float32)


def merge_segments(sid: str, indices: List[int]) -> Dict[str, Any]:
    """Flatten 2+ segments on the SAME track into one continuous clip. The merged
    audio is laid out by each clip's timeline position (gaps become silence) and
    baked down (trim/speed/gain applied); the result behaves like any other
    segment — movable, trimmable, re-sliceable. Texts are concatenated."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        want = {int(i) for i in indices}
        sel = [s for s in session["segments"] if int(s["index"]) in want]
        if len(sel) < 2:
            raise ValueError("Select at least two segments to merge")
        spks = {str(s["speaker_id"]) for s in sel}
        if len(spks) > 1:
            raise ValueError("Can only merge segments on the same track")
        sr = int(session["sample_rate"])
        d = _dir(sid)
        sel.sort(key=lambda s: float(s.get("start_s", 0.0) or 0.0))
        min_start = float(sel[0].get("start_s", 0.0) or 0.0)
        placed: List[tuple] = []
        for s in sel:
            clip = _bake_clip(d, s, sr)
            off = int(round((float(s.get("start_s", 0.0) or 0.0) - min_start) * sr))
            placed.append((max(0, off), clip))
        total = max((off + len(c) for off, c in placed), default=0)
        buf = np.zeros(max(total, 1), dtype=np.float32)
        for off, c in placed:
            if c.size:
                buf[off : off + len(c)] += c
        buf = peak_limit(buf)

        nid = int(session.get("next_index", max((s["index"] for s in session["segments"]), default=-1) + 1))
        session["next_index"] = nid + 1
        fn = f"seg_{nid:03d}.wav"
        save_wav(d / fn, buf, sr)
        dur = duration_seconds(buf, sr)
        text = " ".join(t for t in ((s.get("text") or "").strip() for s in sel) if t)
        speaker_id = str(sel[0]["speaker_id"])

        gone = {int(s["index"]) for s in sel}
        for s in sel:
            (d / s["file"]).unlink(missing_ok=True)
            for key in ("inpaint_ref", "inpaint_bed"):
                if s.get(key):
                    (d / s[key]).unlink(missing_ok=True)
            session.get("refs", {}).pop(f"ip{int(s['index'])}", None)
        session["segments"] = [s for s in session["segments"] if int(s["index"]) not in gone]
        session["segments"].append(
            {
                "index": nid,
                "speaker_id": speaker_id,
                "text": text,
                "file": fn,
                "raw_duration_s": dur,
                "trim_start_s": 0.0,
                "trim_end_s": dur,
                "speed": 1.0,
                "gain_db": 0.0,
                "start_s": round(min_start, 3),
            }
        )
        _stitch(session)
        _write(session)
        return public(session)


def collapse_track(sid: str, pos: str) -> Dict[str, Any]:
    """Flatten an ENTIRE track into one continuous segment (timing preserved)."""
    session = _read(sid)
    if not session:
        raise FileNotFoundError("Session not found")
    idxs = [int(s["index"]) for s in session["segments"] if str(s["speaker_id"]) == str(pos)]
    if len(idxs) < 2:
        raise ValueError("This track needs at least two segments to collapse")
    return merge_segments(sid, idxs)


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


def duplicate_segment(
    sid: str,
    index: int,
    start_s: float,
    ripple: bool = False,
    speaker_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Copy a segment to a new spot — carrying the full clip identity: audio,
    trim/speed/text AND its level (gain_db), fades, and any baked vocal
    transforms (fx). `speaker_id` re-homes the copy onto another track (alt-drag
    onto a different lane); when omitted/unknown it stays on the source track.
    No model run."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        src = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if src is None:
            raise FileNotFoundError(f"Segment {index} not found")
        # Re-home onto another track only when the target exists and matches the
        # source's kind (don't drop a voice clip onto an uploaded-audio channel).
        target_spk = str(src["speaker_id"])
        if speaker_id is not None:
            dst = session.get("speakers", {}).get(str(speaker_id))
            src_chan = _channel_of(session, src["speaker_id"])
            if dst is not None and (dst.get("kind") == "audio") == (src_chan.get("kind") == "audio"):
                target_spk = str(speaker_id)
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
        new_seg: Dict[str, Any] = {
            "index": nid,
            "speaker_id": target_spk,
            "text": src["text"],
            "file": new_fn,
            "raw_duration_s": src.get("raw_duration_s", 0.0),
            "trim_start_s": src.get("trim_start_s", 0.0),
            "trim_end_s": src.get("trim_end_s", src.get("raw_duration_s", 0.0)),
            "speed": src.get("speed", 1.0),
            "gain_db": float(src.get("gain_db", 0.0) or 0.0),
            "fade_in_s": float(src.get("fade_in_s", 0.0) or 0.0),
            "fade_out_s": float(src.get("fade_out_s", 0.0) or 0.0),
            "start_s": round(start_s, 3),
        }
        if src.get("transforms"):
            new_seg["transforms"] = {**src["transforms"]}
        session["segments"].append(new_seg)
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


def set_inpaint(
    sid: str,
    index: int,
    enabled: bool,
    prepped: Optional[np.ndarray] = None,
    prepped_sr: Optional[int] = None,
    bed: Optional[np.ndarray] = None,
    pre_cleaned: bool = False,
) -> Dict[str, Any]:
    """Toggle Vocal Inpaint on a segment. When enabling, `prepped` is the cleaned,
    length-bounded clone source; it's stored as the segment's locked voice. If the
    caller pre-isolated the voice (`pre_cleaned`), it's also registered as the
    cleaned ref so regen skips a second isolation. `bed` (non-vocal residual, full
    length) is stored so "Preserve non-vocal" can mix it back. Disabling keeps the
    files on disk (lazy) and just unlocks."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        ipkey = f"ip{int(index)}"
        if enabled:
            if prepped is None or prepped.size == 0:
                raise ValueError("No usable audio to lock as the inpaint source.")
            sr = int(prepped_sr or session["sample_rate"])
            fn = f"inpaint_src_{int(index):03d}.wav"
            save_wav(_dir(sid) / fn, np.asarray(prepped, dtype=np.float32), sr)
            seg["inpaint"] = True
            seg["inpaint_ref"] = fn
            # Re-locking re-captures the voice: drop the cached cleaned inpaint ref.
            old = session.setdefault("refs", {}).pop(ipkey, None)
            if old and old != fn:
                (_dir(sid) / old).unlink(missing_ok=True)
            # Pre-isolated source → reuse it directly as the cleaned ref.
            if pre_cleaned:
                session["refs"][ipkey] = fn
            # Capture / refresh the non-vocal bed (or clear a stale one).
            bed_fn = f"inpaint_bed_{int(index):03d}.wav"
            if bed is not None and bed.size:
                save_wav(_dir(sid) / bed_fn, np.asarray(bed, dtype=np.float32), sr)
                seg["inpaint_bed"] = bed_fn
            else:
                (_dir(sid) / bed_fn).unlink(missing_ok=True)
                seg.pop("inpaint_bed", None)
                seg["preserve_nonvocal"] = False
        else:
            seg["inpaint"] = False  # leave inpaint_ref + cleaned ref on disk (lazy)
        _write(session)
        return public(session)


def apply_segment_transform(sid: str, index: int, transforms: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Bake creative vocal transforms (pitch/formant/…/telephone) onto a segment's
    own audio — the same engine the performance modal uses, applied directly to an
    existing clip instead of a take.

    Destructive but reversible: the first time a clip is transformed its pristine
    audio is stashed (``fx_orig``) and every later apply re-derives from that
    stash, so the sliders never stack on an already-mangled clip. Passing a
    no-op transform restores the original and clears the stash. The whole thing
    sits under the standard single-step undo (the route middleware checkpoints
    before we run)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")

        from .voice_transforms import apply_transforms, has_effect, normalize_transforms

        sr = int(session["sample_rate"])
        d = _dir(sid)
        orig_fn = seg.get("fx_orig")
        orig_path = (d / orig_fn) if orig_fn else None

        if has_effect(transforms):
            # Establish (once) the pristine source to transform from.
            if not orig_path or not orig_path.exists():
                orig_fn = f"{Path(seg['file']).stem}_fxorig.wav"
                shutil.copyfile(d / seg["file"], d / orig_fn)
                seg["fx_orig"] = orig_fn
            base = load_audio(d / orig_fn, sr=sr)
            out = apply_transforms(np.asarray(base, dtype=np.float32), sr, transforms)
            save_wav(d / seg["file"], np.asarray(out, dtype=np.float32), sr)
            rdur = len(out) / sr if sr else 0.0
            seg["raw_duration_s"] = round(rdur, 4)
            # Transforms preserve length; keep the trim window inside the clip.
            seg["trim_start_s"] = min(float(seg.get("trim_start_s", 0.0) or 0.0), rdur)
            te = seg.get("trim_end_s")
            seg["trim_end_s"] = min(float(te) if te else rdur, rdur)
            seg["transforms"] = normalize_transforms(transforms)
        else:
            # No-op transform → restore the pristine clip and drop the stash.
            if orig_path and orig_path.exists():
                shutil.copyfile(orig_path, d / seg["file"])
                orig_path.unlink(missing_ok=True)
                base = load_audio(d / seg["file"], sr=sr)
                seg["raw_duration_s"] = round(len(base) / sr if sr else 0.0, 4)
            seg.pop("fx_orig", None)
            seg.pop("transforms", None)

        _stitch(session)
        _write(session)
        return public(session)


def segment_full_audio(sid: str, index: int) -> tuple:
    """Return a segment's FULL, untrimmed raw audio + sample rate. Used by stem
    isolation, which re-writes the whole clip (unlike clone_source, which trims)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        sr = int(session["sample_rate"])
        raw = load_audio(_dir(sid) / seg["file"], sr=sr)
        return raw.astype(np.float32), sr


def apply_segment_isolate(sid: str, index: int, wav: np.ndarray, sr: int, stem: str) -> Dict[str, Any]:
    """Replace a segment's audio with an isolated stem (vocals / instrumental)
    produced by the RoFormer separator in the worker.

    Destructive but covered by the standard single-step undo (the route
    middleware snapshots the per-segment audio before we run, so a wrong stem
    is one Undo away — and isolating the other stem regenerates from the
    pre-isolation mix after that undo)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        out = np.asarray(wav, dtype=np.float32)
        if out.size == 0:
            raise ValueError("Isolation produced no audio.")
        d = _dir(sid)
        save_wav(d / seg["file"], out, sr)
        rdur = len(out) / sr if sr else 0.0
        seg["raw_duration_s"] = round(rdur, 4)
        # Isolation preserves length; keep the trim window inside the clip.
        seg["trim_start_s"] = min(float(seg.get("trim_start_s", 0.0) or 0.0), rdur)
        te = seg.get("trim_end_s")
        seg["trim_end_s"] = min(float(te) if te else rdur, rdur)
        # The audio changed under any prior transform stash; drop it so a later
        # transform re-stashes from the now-isolated clip instead of restoring
        # the pre-isolation mix.
        old_orig = seg.pop("fx_orig", None)
        if old_orig:
            (d / old_orig).unlink(missing_ok=True)
        seg.pop("transforms", None)
        seg["isolated"] = stem
        _stitch(session)
        _write(session)
        return public(session)


def set_preserve_nonvocal(sid: str, index: int, enabled: bool) -> Dict[str, Any]:
    """Toggle whether an inpainted clip re-adds its captured non-vocal bed on
    regen. The bed is captured at lock time; enabling without one is rejected."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        if enabled and not (seg.get("inpaint_bed") and (_dir(sid) / seg["inpaint_bed"]).exists()):
            raise ValueError("No non-vocal bed was captured for this clip (isolation unavailable).")
        seg["preserve_nonvocal"] = bool(enabled)
        _write(session)
        return public(session)


def set_performance(
    sid: str,
    index: int,
    wav: Optional[np.ndarray],
    sr: Optional[int],
    *,
    gain_db: float = 0.0,
    speed: float = 1.0,
    mode: str = "character",
    strength: int = 3,
    text: Optional[str] = None,
    transforms: Optional[Dict[str, Any]] = None,
    auto_pitch: bool = False,
    clean_isolate: bool = False,
    clean_dereverb: bool = False,
) -> Dict[str, Any]:
    """Attach (or update) a recorded vocal performance on a segment. With audio,
    the take is stored and the segment enters perform mode; without audio, only
    the params change (existing take required). Either way the segment is marked
    dirty until the next regen renders it."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        pf = dict(seg.get("perform") or {})
        if wav is not None:
            fn = f"perform_{int(index):03d}.wav"
            save_wav(_dir(sid) / fn, np.asarray(wav, dtype=np.float32), int(sr or session["sample_rate"]))
            pf["file"] = fn
        if not pf.get("file") or not (_dir(sid) / pf["file"]).exists():
            raise ValueError("No performance audio attached to this segment yet.")
        from .voice_transforms import normalize_transforms

        norm_tf = normalize_transforms(transforms) if transforms else None
        pf.update(
            {
                "gain_db": float(gain_db),
                "speed": float(speed),
                "mode": "voice" if str(mode).lower() == "voice" else "character",
                "strength": max(1, min(5, int(strength))),
                "transforms": norm_tf,
                "auto_pitch": bool(auto_pitch),
                "clean_isolate": bool(clean_isolate),
                "clean_dereverb": bool(clean_dereverb),
                "dirty": True,
            }
        )
        seg["perform"] = pf
        if text is not None and text.strip():
            seg["text"] = text.strip()
        _write(session)
        return public(session)


def clear_performance(sid: str, index: int) -> Dict[str, Any]:
    """Detach a segment's vocal performance (back to plain TTS regen)."""
    with _lock:
        session = _read(sid)
        if not session:
            raise FileNotFoundError("Session not found")
        seg = next((s for s in session["segments"] if int(s["index"]) == int(index)), None)
        if seg is None:
            raise FileNotFoundError(f"Segment {index} not found")
        pf = seg.pop("perform", None)
        if pf and pf.get("file"):
            (_dir(sid) / pf["file"]).unlink(missing_ok=True)
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
        if session.get("track_order"):
            # The promoted speaker keeps the old channel's spot in the layout.
            session["track_order"] = [new_pos if str(k) == str(pos) else str(k) for k in session["track_order"]]
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
