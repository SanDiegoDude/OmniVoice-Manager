"""Audio helpers for the Voice Lab: load, isolate, boost/normalize, trim, save."""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import librosa
import numpy as np
import soundfile as sf

TARGET_SR = 24000


def load_audio(path: str | Path, sr: int = TARGET_SR) -> np.ndarray:
    """Load an audio file as mono float32 at the target sample rate."""
    wav, _ = librosa.load(str(path), sr=sr, mono=True)
    return wav.astype(np.float32)


def save_wav(path: str | Path, audio: np.ndarray, sr: int = TARGET_SR) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = np.clip(audio, -1.0, 1.0).astype(np.float32)
    sf.write(str(path), audio, sr)


_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
}


def media_type_for(path: str | Path) -> str:
    return _MEDIA_TYPES.get(Path(path).suffix.lower(), "application/octet-stream")


def encode_audio(
    path: str | Path,
    audio: np.ndarray,
    sr: int = TARGET_SR,
    fmt: str = "mp3",
    bitrate: str = "192k",
) -> Path:
    """Write mono audio to ``path`` in ``fmt`` (wav lossless, or a compressed
    codec via ffmpeg/pydub). Falls back to WAV if the encoder is unavailable so
    a job never loses its output."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = np.clip(audio, -1.0, 1.0).astype(np.float32)
    fmt = (fmt or "mp3").lower().lstrip(".")
    if fmt == "wav":
        sf.write(str(path), audio, sr)
        return path
    if fmt == "flac":
        # Lossless, ~half of WAV, pro-audio standard. Written straight through
        # libsndfile (no ffmpeg dependency); 24-bit preserves the model output.
        sf.write(str(path), audio, sr, subtype="PCM_24")
        return path
    try:
        from pydub import AudioSegment

        pcm = (audio * 32767.0).astype("<i2").tobytes()
        seg = AudioSegment(data=pcm, sample_width=2, frame_rate=sr, channels=1)
        # Pin the MP3 encoder to libmp3lame. Some ffmpeg builds (notably conda's
        # on Windows) default the mp3 muxer to the MediaFoundation encoder
        # (mp3_mf), which exits 0 but encodes nothing — a silent ~500-byte file.
        codec = "libmp3lame" if fmt == "mp3" else None
        seg.export(str(path), format=fmt, bitrate=bitrate, codec=codec)
        # Sanity check: a broken encoder can still exit 0 with a header-only
        # file. Anything implausibly small for the duration means it failed.
        min_bytes = max(1024, int(len(audio) / sr * 1000))  # ~8 kbit/s floor
        if path.stat().st_size < min_bytes:
            raise RuntimeError(f"encoder produced an empty {fmt} file")
        return path
    except Exception:  # noqa: BLE001 — ffmpeg/pydub missing or codec error
        fallback = path.with_suffix(".wav")
        sf.write(str(fallback), audio, sr)
        return fallback


def rms(audio: np.ndarray) -> float:
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio**2)))


def apply_gain_db(audio: np.ndarray, gain_db: float) -> np.ndarray:
    if gain_db == 0.0:
        return audio
    factor = 10.0 ** (gain_db / 20.0)
    out = audio * factor
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1.0:
        out = out / peak
    return out.astype(np.float32)


def normalize_rms(audio: np.ndarray, target_rms: float = 0.08, max_gain: float = 6.0) -> np.ndarray:
    """Boost/attenuate a single sample toward a target RMS (loudness leveling)."""
    cur = rms(audio)
    if cur <= 1e-6:
        return audio
    gain = min(target_rms / cur, max_gain)
    out = audio * gain
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0.99:
        out = out * (0.99 / peak)
    return out.astype(np.float32)


def balance_samples(samples: List[np.ndarray], max_gain: float = 3.0) -> List[np.ndarray]:
    """Match a set of samples to their median RMS so speakers sit at even volume."""
    if not samples:
        return samples
    rms_values = [rms(s) for s in samples]
    nonzero = [r for r in rms_values if r > 1e-6]
    if not nonzero:
        return samples
    target = float(np.median(nonzero))
    out = []
    for s, r in zip(samples, rms_values):
        if r <= 1e-6:
            out.append(s)
            continue
        gain = min(target / r, max_gain)
        adj = s * gain
        peak = float(np.max(np.abs(adj))) if adj.size else 0.0
        if peak > 0.99:
            adj = adj * (0.99 / peak)
        out.append(adj.astype(np.float32))
    return out


def measure_lufs(audio: np.ndarray, sr: int = TARGET_SR) -> Optional[float]:
    """Integrated loudness (LUFS, ITU-R BS.1770 / EBU R128, K-weighted).

    Returns None for clips too short to gate or effectively silent."""
    if audio.size == 0:
        return None
    dur = audio.size / float(sr)
    if dur < 0.05:
        return None
    try:
        import pyloudnorm as pyln
    except ImportError:
        return None
    # The integrated meter needs at least one full gating block; shrink the
    # block for short utterances so a brief "Yeah." still measures.
    block = min(0.400, max(0.100, dur * 0.9))
    try:
        meter = pyln.Meter(sr, block_size=block)
        loud = float(meter.integrated_loudness(audio.astype(np.float64)))
    except Exception:  # noqa: BLE001
        return None
    if not np.isfinite(loud) or loud < -70.0:
        return None
    return loud


def match_loudness(
    segments: List[np.ndarray],
    sr: int = TARGET_SR,
    target_lufs: float = -20.0,
    max_gain_db: float = 15.0,
) -> List[np.ndarray]:
    """Level each segment to a common perceptual loudness (LUFS) target.

    This is how dialogue is matched professionally: every utterance is
    normalized to the same integrated loudness, regardless of how compressed
    or dynamic the source is. Peaks are NOT clamped per-segment — apply
    `peak_limit` to the final mix instead so the limiter sees the whole track.
    """
    out: List[np.ndarray] = []
    for seg in segments:
        loud = measure_lufs(seg, sr)
        if loud is None:
            out.append(seg)
            continue
        gain_db = float(np.clip(target_lufs - loud, -max_gain_db, max_gain_db))
        factor = 10.0 ** (gain_db / 20.0)
        out.append((seg * factor).astype(np.float32))
    return out


def peak_limit(audio: np.ndarray, ceiling_db: float = -1.0, oversample: int = 4) -> np.ndarray:
    """Brick-wall the track below a (near-)true-peak ceiling to prevent clipping.

    Estimates inter-sample peaks via light oversampling, then applies a single
    flat gain so the loudest peak sits at the ceiling. No distortion — it only
    pulls down if needed."""
    if audio.size == 0:
        return audio
    ceiling = 10.0 ** (ceiling_db / 20.0)
    peak = float(np.max(np.abs(audio)))
    if oversample and oversample > 1:
        try:
            up = librosa.resample(audio.astype(np.float32), orig_sr=1, target_sr=oversample)
            peak = max(peak, float(np.max(np.abs(up))))
        except Exception:  # noqa: BLE001
            pass
    if peak <= ceiling or peak <= 1e-9:
        return audio.astype(np.float32)
    return (audio * (ceiling / peak)).astype(np.float32)


def time_stretch(audio: np.ndarray, rate: float) -> np.ndarray:
    """Speed a clip up/down (rate>1 = faster/shorter) while preserving pitch.

    Used for per-segment / global speed tweaks in the multitrack editor without
    re-running the model. Prefers WSOLA (audiotsm) which is clean on speech; the
    librosa phase-vocoder fallback can sound reverberant/"echoey" so it's last
    resort only."""
    if audio.size == 0 or rate is None or abs(rate - 1.0) < 1e-3:
        return audio.astype(np.float32)
    x = np.ascontiguousarray(audio.astype(np.float32))
    try:
        from audiotsm import wsola
        from audiotsm.io.array import ArrayReader, ArrayWriter

        reader = ArrayReader(x.reshape(1, -1))
        writer = ArrayWriter(channels=1)
        wsola(channels=1, speed=float(rate)).run(reader, writer)
        out = np.asarray(writer.data, dtype=np.float32)
        return out[0] if out.ndim == 2 else out
    except Exception:  # noqa: BLE001
        try:
            return librosa.effects.time_stretch(y=x, rate=float(rate)).astype(np.float32)
        except Exception:  # noqa: BLE001
            return x


def trim_silence(audio: np.ndarray, top_db: float = 30.0) -> np.ndarray:
    if audio.size == 0:
        return audio
    trimmed, _ = librosa.effects.trim(audio, top_db=top_db)
    return trimmed if trimmed.size else audio


def trim_silence_edges(
    audio: np.ndarray, sr: int, top_db: float = 35.0, pad_ms: float = 40.0
) -> np.ndarray:
    """Trim near-silence (incl. low-level hiss/artifacts) from both ends, keeping
    a small pad so soft onsets/plosives and natural breaths aren't clipped.

    Used for generated TTS clips and recorded takes — the auto dead-air killer.
    A higher ``top_db`` only trims quieter material, so 35 dB is safe for speech
    while still catching faint room/codec hiss that sits well below the voice.
    """
    if audio.size == 0:
        return audio
    _, idx = librosa.effects.trim(audio, top_db=top_db)
    start, end = int(idx[0]), int(idx[1])
    if end <= start:
        return audio  # all silence (or detection failed) — leave it untouched
    pad = int(sr * pad_ms / 1000.0)
    start = max(0, start - pad)
    end = min(audio.size, end + pad)
    return audio[start:end].astype(np.float32)


def peak_normalize(audio: np.ndarray, peak: float = 0.95) -> np.ndarray:
    cur = float(np.max(np.abs(audio))) if audio.size else 0.0
    if cur <= 1e-6:
        return audio
    return (audio * (peak / cur)).astype(np.float32)


def duration_seconds(audio: np.ndarray, sr: int = TARGET_SR) -> float:
    return round(len(audio) / sr, 2) if sr else 0.0
