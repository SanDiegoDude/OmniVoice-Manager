"""Voice library: scan custom_voices/, resolve and save voice files safely."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List

from .audio_utils import duration_seconds, load_audio
from .config import AUDIO_EXTENSIONS, CUSTOM_VOICES_DIR


def _safe_relpath(rel: str) -> Path:
    """Resolve a user-supplied relative path inside CUSTOM_VOICES_DIR (no escapes)."""
    rel = (rel or "").strip().lstrip("/")
    target = (CUSTOM_VOICES_DIR / rel).resolve()
    base = CUSTOM_VOICES_DIR.resolve()
    if base != target and base not in target.parents:
        raise ValueError("Path escapes the voice library.")
    return target


def list_voices() -> List[Dict[str, object]]:
    """Flat list of voices; display name is the relative path without extension."""
    voices: List[Dict[str, object]] = []
    if not CUSTOM_VOICES_DIR.exists():
        return voices
    for path in sorted(CUSTOM_VOICES_DIR.rglob("*")):
        if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS:
            rel = path.relative_to(CUSTOM_VOICES_DIR)
            voices.append(
                {
                    "id": str(rel),
                    "name": str(rel.with_suffix("")),
                    "folder": str(rel.parent) if str(rel.parent) != "." else "",
                    "filename": path.name,
                    "size_kb": round(path.stat().st_size / 1024, 1),
                }
            )
    return voices


def voice_tree() -> Dict[str, object]:
    """Nested folder tree for the UI."""
    root: Dict[str, object] = {"name": "", "folders": {}, "voices": []}
    for v in list_voices():
        parts = Path(v["id"]).parts
        node = root
        for folder in parts[:-1]:
            node = node["folders"].setdefault(folder, {"name": folder, "folders": {}, "voices": []})  # type: ignore[index]
        node["voices"].append(v)  # type: ignore[index]
    return root


def resolve_voice_path(voice_id: str) -> Path:
    path = _safe_relpath(voice_id)
    if not path.exists():
        raise FileNotFoundError(f"Voice not found: {voice_id}")
    return path


def load_voice_audio(voice_id: str):
    path = resolve_voice_path(voice_id)
    return load_audio(path)


def _sanitize_segment(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9 _\-./]", "", name).strip()
    return name.replace("..", "").strip("/")


def save_voice(rel_path: str, audio, sample_rate: int = 24000) -> Dict[str, object]:
    """Save a processed voice sample into the library and return its descriptor."""
    from .audio_utils import save_wav

    rel_path = _sanitize_segment(rel_path)
    if not rel_path:
        raise ValueError("Empty voice name.")
    if not rel_path.lower().endswith(".wav"):
        rel_path += ".wav"
    target = _safe_relpath(rel_path)
    save_wav(target, audio, sample_rate)
    rel = target.relative_to(CUSTOM_VOICES_DIR)
    return {
        "id": str(rel),
        "name": str(rel.with_suffix("")),
        "duration_s": duration_seconds(audio, sample_rate),
    }


def delete_voice(voice_id: str) -> None:
    path = resolve_voice_path(voice_id)
    path.unlink()
