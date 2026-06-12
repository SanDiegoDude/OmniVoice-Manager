"""Disk cache of cleaned clone references (post isolation/dereverb/normalize).

Re-using a library voice used to re-run vocal isolation / de-reverb on the
exact same file with the exact same flags on every job — the dominant cost of
a warm rerun. ADR sessions already cache their own cleaned refs per session;
this is the global, voice-keyed equivalent that also covers one-shot
generations (Voice Clone tab, V2V reruns) and brand-new sessions.

Keys include the voice file's mtime + size, so re-processing a voice in the
Voice Lab (overwrite-in-place) invalidates its cached refs automatically.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional

import numpy as np

from .audio_utils import load_audio, save_wav
from .config import DATA_DIR

CACHE_DIR = DATA_DIR / "ref_cache"
MAX_ENTRIES = 40


def cache_key(voice_path: Path, isolate: bool, dereverb: bool, dereverb_method: str, normalize: bool) -> str:
    st = voice_path.stat()
    raw = "|".join(
        [
            str(voice_path.resolve()),
            str(st.st_mtime_ns),
            str(st.st_size),
            str(int(bool(isolate))),
            str(int(bool(dereverb))),
            (dereverb_method or "") if dereverb else "",
            str(int(bool(normalize))),
        ]
    )
    return hashlib.sha1(raw.encode()).hexdigest()


def load(key: str) -> Optional[np.ndarray]:
    path = CACHE_DIR / f"{key}.wav"
    if not path.exists():
        return None
    try:
        path.touch()  # bump recency so pruning is LRU-ish
        return load_audio(path)
    except Exception:  # noqa: BLE001 — corrupt entry: treat as a miss
        return None


def store(key: str, wav: np.ndarray) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        save_wav(CACHE_DIR / f"{key}.wav", np.asarray(wav, dtype=np.float32))
        _prune()
    except Exception:  # noqa: BLE001 — cache writes must never fail a job
        pass


def _prune() -> None:
    files = sorted(CACHE_DIR.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
    for p in files[MAX_ENTRIES:]:
        p.unlink(missing_ok=True)
