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


def _natkey(s: str):
    """Case-insensitive, number-aware sort key (Windows Explorer style): so
    'clip2' sorts before 'clip10' and case doesn't fragment the list."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def list_voices() -> List[Dict[str, object]]:
    """Flat list of voices; display name is the relative path without extension."""
    voices: List[Dict[str, object]] = []
    if not CUSTOM_VOICES_DIR.exists():
        return voices
    files = [
        p
        for p in CUSTOM_VOICES_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    ]
    for path in sorted(files, key=lambda p: _natkey(str(p.relative_to(CUSTOM_VOICES_DIR)))):
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


def list_folders() -> List[str]:
    """All folders (relative paths) under the library, natural-sorted. Excludes
    the root (represented as '' in the UI). Used by the save/move folder pickers."""
    if not CUSTOM_VOICES_DIR.exists():
        return []
    base = CUSTOM_VOICES_DIR.resolve()
    folders = [
        str(p.relative_to(base))
        for p in CUSTOM_VOICES_DIR.rglob("*")
        if p.is_dir()
    ]
    return sorted(folders, key=_natkey)


def create_folder(rel: str) -> Dict[str, object]:
    """Make a new (possibly nested) folder inside the library."""
    rel = _sanitize_segment(rel)
    if not rel:
        raise ValueError("Empty folder name.")
    target = _safe_relpath(rel)
    if target.exists() and target.is_file():
        raise ValueError("A voice with that name already exists.")
    target.mkdir(parents=True, exist_ok=True)
    return {"folder": str(target.relative_to(CUSTOM_VOICES_DIR))}


def _voice_descriptor(path: Path) -> Dict[str, object]:
    rel = path.relative_to(CUSTOM_VOICES_DIR)
    return {
        "id": str(rel),
        "name": str(rel.with_suffix("")),
        "folder": str(rel.parent) if str(rel.parent) != "." else "",
        "filename": path.name,
    }


def move_voice(voice_id: str, dest_folder: str) -> Dict[str, object]:
    """Move a voice file into ``dest_folder`` (root = ""), keeping its filename."""
    src = resolve_voice_path(voice_id)
    folder = _sanitize_segment(dest_folder or "")
    dest_dir = _safe_relpath(folder) if folder else CUSTOM_VOICES_DIR.resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / src.name
    if target.resolve() == src.resolve():
        return _voice_descriptor(src)
    if target.exists():
        raise ValueError(f"'{src.name}' already exists in that folder.")
    src.rename(target)
    return _voice_descriptor(target)


def rename_voice(voice_id: str, new_name: str) -> Dict[str, object]:
    """Rename a voice (the base name only) within its current folder."""
    src = resolve_voice_path(voice_id)
    base = _sanitize_segment(new_name or "")
    # A rename is a leaf operation — strip any path the user typed in.
    base = Path(base).name
    if not base:
        raise ValueError("Empty name.")
    target = src.with_name(base + src.suffix)
    if target.resolve() == src.resolve():
        return _voice_descriptor(src)
    if target.exists():
        raise ValueError(f"'{target.name}' already exists in that folder.")
    src.rename(target)
    return _voice_descriptor(target)


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
