"""Voice library: scan custom_voices/, resolve and save voice files safely."""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from typing import Dict, List, Optional

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
    """Nested folder tree for the UI. Includes empty folders (freshly created
    ones have no voices yet) so they show up the moment they're made."""
    root: Dict[str, object] = {"name": "", "folders": {}, "voices": []}

    def _descend(parts) -> Dict[str, object]:
        node = root
        for folder in parts:
            node = node["folders"].setdefault(folder, {"name": folder, "folders": {}, "voices": []})  # type: ignore[index]
        return node

    for folder in list_folders():
        _descend(Path(folder).parts)
    for v in list_voices():
        node = _descend(Path(v["id"]).parts[:-1])
        node["voices"].append(v)  # type: ignore[index]
    return root


def resolve_voice_path(voice_id: str) -> Path:
    path = _safe_relpath(voice_id)
    # Require an actual file: a category folder (e.g. "voiceovers") also "exists",
    # and passing a directory to the audio loader crashes ffmpeg with
    # "Is a directory" -> HTTP 500. Treat non-files as "not found" instead.
    if not path.is_file():
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


# ---------------------------------------------------------------------------
# Content matching + external import (used by project save/restore so a project
# always travels with the exact voice snapshots that produced its samples, and
# can re-import any that are missing from this machine's fluid library).
# ---------------------------------------------------------------------------
def content_hash(path: Path) -> str:
    """SHA-1 of a file's bytes — a stable fingerprint for de-dup / matching."""
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def find_by_content(path: Path) -> Optional[str]:
    """Find a library voice whose bytes are identical to ``path`` and return its
    id, else None. Size-filtered first so only same-length candidates get hashed
    (a proper recursive search of every subfolder, but cheap)."""
    if not CUSTOM_VOICES_DIR.exists() or not path.exists():
        return None
    try:
        size = path.stat().st_size
    except OSError:
        return None
    digest: Optional[str] = None
    for cand in CUSTOM_VOICES_DIR.rglob("*"):
        if not (cand.is_file() and cand.suffix.lower() in AUDIO_EXTENSIONS):
            continue
        try:
            if cand.stat().st_size != size:
                continue
            if digest is None:
                digest = content_hash(path)
            if content_hash(cand) == digest:
                return str(cand.relative_to(CUSTOM_VOICES_DIR))
        except OSError:
            continue
    return None


def import_file(src: Path, rel_path: str) -> Dict[str, object]:
    """Copy an external audio file into the library verbatim (preserving its
    extension). If an identical voice already exists anywhere in the library,
    relink to it instead of creating a duplicate."""
    existing = find_by_content(src)
    if existing:
        return {**_voice_descriptor(resolve_voice_path(existing)), "deduped": True}
    rel_path = _sanitize_segment(rel_path)
    if not rel_path:
        raise ValueError("Empty voice name.")
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
    return {**_voice_descriptor(target), "deduped": False}
