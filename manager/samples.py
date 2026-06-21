"""Foley / SFX sound library: scan custom_sounds/, resolve and save samples.

The non-vocal counterpart to ``voices.py``. Same browseable, folder-tree,
content-addressed model — footsteps, doors, ambience, stingers, generated foley —
dropped onto audio channels in the multitrack editor. Kept structurally parallel
to the voice library so projects can snapshot the samples they use (de-duped by
content) and re-import any that are missing on the far end, exactly like voices.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from .audio_utils import duration_seconds, load_audio
from .config import AUDIO_EXTENSIONS, CUSTOM_SOUNDS_DIR


def _safe_relpath(rel: str) -> Path:
    """Resolve a user-supplied relative path inside CUSTOM_SOUNDS_DIR (no escapes)."""
    rel = (rel or "").strip().lstrip("/")
    target = (CUSTOM_SOUNDS_DIR / rel).resolve()
    base = CUSTOM_SOUNDS_DIR.resolve()
    if base != target and base not in target.parents:
        raise ValueError("Path escapes the sound library.")
    return target


def _natkey(s: str):
    """Case-insensitive, number-aware sort key (Explorer style)."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _sanitize_segment(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9 _\-./]", "", name).strip()
    return name.replace("..", "").strip("/")


def list_sounds() -> List[Dict[str, object]]:
    """Flat list of sounds; display name is the relative path without extension."""
    sounds: List[Dict[str, object]] = []
    if not CUSTOM_SOUNDS_DIR.exists():
        return sounds
    files = [
        p
        for p in CUSTOM_SOUNDS_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
    ]
    for path in sorted(files, key=lambda p: _natkey(str(p.relative_to(CUSTOM_SOUNDS_DIR)))):
        rel = path.relative_to(CUSTOM_SOUNDS_DIR)
        sounds.append(
            {
                "id": str(rel),
                "name": str(rel.with_suffix("")),
                "folder": str(rel.parent) if str(rel.parent) != "." else "",
                "filename": path.name,
                "size_kb": round(path.stat().st_size / 1024, 1),
            }
        )
    return sounds


def list_folders() -> List[str]:
    if not CUSTOM_SOUNDS_DIR.exists():
        return []
    base = CUSTOM_SOUNDS_DIR.resolve()
    folders = [
        str(p.relative_to(base)) for p in CUSTOM_SOUNDS_DIR.rglob("*") if p.is_dir()
    ]
    return sorted(folders, key=_natkey)


def create_folder(rel: str) -> Dict[str, object]:
    rel = _sanitize_segment(rel)
    if not rel:
        raise ValueError("Empty folder name.")
    target = _safe_relpath(rel)
    if target.exists() and target.is_file():
        raise ValueError("A sound with that name already exists.")
    target.mkdir(parents=True, exist_ok=True)
    return {"folder": str(target.relative_to(CUSTOM_SOUNDS_DIR))}


def _descriptor(path: Path) -> Dict[str, object]:
    rel = path.relative_to(CUSTOM_SOUNDS_DIR)
    return {
        "id": str(rel),
        "name": str(rel.with_suffix("")),
        "folder": str(rel.parent) if str(rel.parent) != "." else "",
        "filename": path.name,
    }


def move_sound(sound_id: str, dest_folder: str) -> Dict[str, object]:
    src = resolve_sound_path(sound_id)
    folder = _sanitize_segment(dest_folder or "")
    dest_dir = _safe_relpath(folder) if folder else CUSTOM_SOUNDS_DIR.resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / src.name
    if target.resolve() == src.resolve():
        return _descriptor(src)
    if target.exists():
        raise ValueError(f"'{src.name}' already exists in that folder.")
    src.rename(target)
    return _descriptor(target)


def rename_sound(sound_id: str, new_name: str) -> Dict[str, object]:
    src = resolve_sound_path(sound_id)
    base = Path(_sanitize_segment(new_name or "")).name
    if not base:
        raise ValueError("Empty name.")
    target = src.with_name(base + src.suffix)
    if target.resolve() == src.resolve():
        return _descriptor(src)
    if target.exists():
        raise ValueError(f"'{target.name}' already exists in that folder.")
    src.rename(target)
    return _descriptor(target)


def sound_tree() -> Dict[str, object]:
    """Nested folder tree for the UI. Includes empty folders so a freshly
    created folder appears immediately (before any sound lands in it)."""
    root: Dict[str, object] = {"name": "", "folders": {}, "sounds": []}

    def _descend(parts) -> Dict[str, object]:
        node = root
        for folder in parts:
            node = node["folders"].setdefault(folder, {"name": folder, "folders": {}, "sounds": []})  # type: ignore[index]
        return node

    for folder in list_folders():
        _descend(Path(folder).parts)
    for s in list_sounds():
        node = _descend(Path(s["id"]).parts[:-1])
        node["sounds"].append(s)  # type: ignore[index]
    return root


def resolve_sound_path(sound_id: str) -> Path:
    path = _safe_relpath(sound_id)
    if not path.exists():
        raise FileNotFoundError(f"Sound not found: {sound_id}")
    return path


def load_sound_audio(sound_id: str):
    return load_audio(resolve_sound_path(sound_id))


def save_sound(rel_path: str, audio, sample_rate: int = 24000, overwrite: bool = False) -> Dict[str, object]:
    """Save a processed/generated sample into the library; returns its descriptor.

    By default never clobbers (auto-suffixes ``_2`` etc., since generated foley
    reuses names). Pass ``overwrite=True`` to write straight to ``rel_path`` —
    the Sample editor's "overwrite in place"."""
    from .audio_utils import save_wav

    rel_path = _sanitize_segment(rel_path)
    if not rel_path:
        raise ValueError("Empty sound name.")
    if not rel_path.lower().endswith(".wav"):
        rel_path += ".wav"
    target = _safe_relpath(rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Never silently clobber an existing sample unless explicitly overwriting.
    if target.exists() and not overwrite:
        stem, n = target.stem, 2
        while target.exists():
            target = target.with_name(f"{stem}_{n}.wav")
            n += 1
    save_wav(target, audio, sample_rate)
    rel = target.relative_to(CUSTOM_SOUNDS_DIR)
    return {
        "id": str(rel),
        "name": str(rel.with_suffix("")),
        "folder": str(rel.parent) if str(rel.parent) != "." else "",
        "filename": target.name,
        "duration_s": duration_seconds(audio, sample_rate),
    }


def delete_sound(sound_id: str) -> None:
    resolve_sound_path(sound_id).unlink()


# ---------------------------------------------------------------------------
# Content matching + external import (parallels voices.py so the project bundle
# can carry/relink samples the same way it does voices).
# ---------------------------------------------------------------------------
def content_hash(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def find_by_content(path: Path) -> Optional[str]:
    if not CUSTOM_SOUNDS_DIR.exists() or not path.exists():
        return None
    try:
        size = path.stat().st_size
    except OSError:
        return None
    digest: Optional[str] = None
    for cand in CUSTOM_SOUNDS_DIR.rglob("*"):
        if not (cand.is_file() and cand.suffix.lower() in AUDIO_EXTENSIONS):
            continue
        try:
            if cand.stat().st_size != size:
                continue
            if digest is None:
                digest = content_hash(path)
            if content_hash(cand) == digest:
                return str(cand.relative_to(CUSTOM_SOUNDS_DIR))
        except OSError:
            continue
    return None


def import_file(src: Path, rel_path: str) -> Dict[str, object]:
    existing = find_by_content(src)
    if existing:
        return {**_descriptor(resolve_sound_path(existing)), "deduped": True}
    rel_path = _sanitize_segment(rel_path)
    if not rel_path:
        raise ValueError("Empty sound name.")
    ext = src.suffix.lower() or ".wav"
    if not rel_path.lower().endswith(ext):
        rel_path += ext
    target = _safe_relpath(rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        stem, n = target.stem, 2
        while target.exists():
            target = target.with_name(f"{stem}_{n}{ext}")
            n += 1
    shutil.copy2(src, target)
    return {**_descriptor(target), "deduped": False}
