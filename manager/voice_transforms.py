"""Programmatic vocal transforms for performance takes (V2V pre-processing).

These run on the *input* take before it is tokenized for the performance
transfer, so the model is handed a reshaped performance — e.g. a deep voice
pitched up toward a high target, which clones far more cleanly than fighting a
large register gap. The same engine is exposed to both the ADR Studio
performance modal and the Voice Clone tab so the two stay in sync.

Pitch and formant are handled with the WORLD vocoder (pyworld): the signal is
decomposed into f0 + spectral envelope + aperiodicity, the pieces are warped
independently, then resynthesised. That keeps prosody and timing intact while
letting pitch and timbre move separately — the difference between a believable
child voice and a chipmunk. Sub-octave / drive / ring-mod / vibrato are the
classic creative colours (Vader, growl, robot…), each weighted 0..1.

Everything is best-effort: a transform that fails (or pyworld being absent)
degrades to passing the take through untouched rather than breaking a render.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional, Tuple

import numpy as np

# WORLD analysis frame period (ms). 5 ms is the library default and a good
# quality/speed balance for speech.
_FRAME_PERIOD = 5.0
_F0_FLOOR = 60.0
_F0_CEIL = 1100.0

# Field -> (min, max) clamps. Pitch/formant in semitones; the rest are 0..1
# weights with optional rate/frequency companions.
_LIMITS = {
    "pitch": (-24.0, 24.0),
    "formant": (-12.0, 12.0),
    "sub": (0.0, 1.0),
    "drive": (0.0, 1.0),
    "ringmod": (0.0, 1.0),
    "ringmod_hz": (10.0, 800.0),
    "vibrato": (0.0, 1.0),
    "vibrato_hz": (0.5, 12.0),
    # "Bad telephone call" lo-fi: band-limit + sample-rate/bit crush. Weight 0..1.
    "telephone": (0.0, 1.0),
    # Crackle / line-noise riding on top of the telephone effect. Weight 0..1.
    "tel_crackle": (0.0, 1.0),
}

_DEFAULTS = {
    "pitch": 0.0,
    "formant": 0.0,
    "sub": 0.0,
    "drive": 0.0,
    "ringmod": 0.0,
    "ringmod_hz": 80.0,
    "vibrato": 0.0,
    "vibrato_hz": 5.0,
    "telephone": 0.0,
    "tel_crackle": 0.0,
}


def normalize_transforms(t: Optional[Dict[str, Any]]) -> Dict[str, float]:
    """Parse + clamp a raw transform dict; unknown keys dropped, gaps filled."""
    out = dict(_DEFAULTS)
    if not t:
        return out
    for key, default in _DEFAULTS.items():
        if key not in t or t[key] is None:
            continue
        try:
            val = float(t[key])
        except (TypeError, ValueError):
            continue
        lo, hi = _LIMITS[key]
        out[key] = float(np.clip(val, lo, hi))
    return out


def has_effect(t: Optional[Dict[str, Any]]) -> bool:
    """True if a normalized transform dict would actually change the audio."""
    n = normalize_transforms(t)
    return (
        abs(n["pitch"]) > 1e-3
        or abs(n["formant"]) > 1e-3
        or n["sub"] > 1e-3
        or n["drive"] > 1e-3
        or n["ringmod"] > 1e-3
        or n["vibrato"] > 1e-3
        or n["telephone"] > 1e-3
    )


def _warp_formant(sp: np.ndarray, ratio: float) -> np.ndarray:
    """Shift the spectral envelope along the frequency axis. ratio > 1 raises
    formants (brighter / smaller head → child), < 1 lowers them (darker /
    larger → monster). out[f] = sp[f / ratio]."""
    if abs(ratio - 1.0) < 1e-3:
        return sp
    n_bins = sp.shape[1]
    bins = np.arange(n_bins)
    src = bins / ratio
    warped = np.empty_like(sp)
    for i in range(sp.shape[0]):
        warped[i] = np.interp(src, bins, sp[i])
    # Keep the envelope strictly positive so synthesis stays stable.
    return np.clip(warped, 1e-16, None)


def _world_transform(wav: np.ndarray, sr: int, n: Dict[str, float]) -> np.ndarray:
    """Pitch / formant / sub-octave / vibrato via the WORLD vocoder."""
    import pyworld as pw

    x = np.ascontiguousarray(wav.astype(np.float64))
    f0, t = pw.harvest(x, sr, f0_floor=_F0_FLOOR, f0_ceil=_F0_CEIL, frame_period=_FRAME_PERIOD)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)

    pitch_ratio = 2.0 ** (n["pitch"] / 12.0)
    formant_ratio = 2.0 ** (n["formant"] / 12.0)

    f0_shift = f0 * pitch_ratio
    if n["vibrato"] > 1e-3:
        # Gentle musical vibrato: ±~6% f0 at full weight.
        depth = 0.06 * n["vibrato"]
        lfo = np.sin(2.0 * np.pi * n["vibrato_hz"] * t)
        f0_shift = f0_shift * (1.0 + depth * lfo)

    sp_shift = _warp_formant(sp, formant_ratio) if abs(formant_ratio - 1.0) > 1e-3 else sp

    y = pw.synthesize(f0_shift, sp_shift, ap, sr, frame_period=_FRAME_PERIOD)

    if n["sub"] > 1e-3:
        # Octave-below double from the same envelope/aperiodicity — the body of
        # a Vader / monster voice. Voiced frames only (f0 > 0).
        sub_f0 = np.where(f0_shift > 0, f0_shift * 0.5, 0.0)
        sub = pw.synthesize(sub_f0, sp_shift, ap, sr, frame_period=_FRAME_PERIOD)
        m = min(len(y), len(sub))
        y = y[:m] + n["sub"] * sub[:m]

    return np.asarray(y, dtype=np.float32)


def _drive(wav: np.ndarray, amount: float) -> np.ndarray:
    """Soft-clip overdrive (growl / grit), wet/dry mixed by amount."""
    k = 1.0 + 9.0 * amount  # up to ~10x pre-gain into tanh
    wet = np.tanh(wav * k)
    peak = float(np.max(np.abs(wet))) if wet.size else 0.0
    if peak > 1e-6:
        wet = wet / peak * (float(np.max(np.abs(wav))) or 1.0)
    return (1.0 - amount) * wav + amount * wet


def _ringmod(wav: np.ndarray, sr: int, amount: float, hz: float) -> np.ndarray:
    """Ring modulation (robot / demon), wet/dry mixed by amount."""
    t = np.arange(len(wav), dtype=np.float32) / float(sr)
    carrier = np.sin(2.0 * np.pi * hz * t).astype(np.float32)
    wet = wav * carrier
    return (1.0 - amount) * wav + amount * wet


def _telephone(wav: np.ndarray, sr: int, amount: float, crackle: float) -> np.ndarray:
    """"Bad telephone call" / old-voicemail lo-fi.

    Three stages stacked the way a real phone line degrades a voice, scaled by
    ``amount`` so the slider sweeps from a hint of compression to full GSM-grade
    mush:
      1. Band-limit to the classic 300 Hz–3.4 kHz telephone passband (the band
         tightens as the weight climbs), killing the lows/airy highs that make
         speech sound full.
      2. Crush the resolution — drop the effective sample rate (zero-order hold,
         giving that aliased digital edge) and the bit depth — for the "low Hz
         quality" the user is after.
      3. Soft-clip/compress so it sits squashed and loud like a phone earpiece.
    ``crackle`` rides faint static + sparse pops on top for the dodgy-line feel.

    Wet/dry is mixed by ``amount`` (full weight = fully degraded). Best-effort:
    if SciPy's filters aren't available the band-limit step is skipped."""
    a = float(np.clip(amount, 0.0, 1.0))
    if a <= 1e-3 or wav.size == 0:
        return np.asarray(wav, dtype=np.float32)
    dry = np.asarray(wav, dtype=np.float32)

    band = dry
    try:
        from scipy.signal import butter, sosfilt

        low = 300.0
        high = 3400.0 - 1000.0 * a  # narrows toward 2.4 kHz at full weight
        nyq = sr * 0.5
        high = min(high, nyq * 0.98)
        if high > low:
            sos = butter(4, [low / nyq, high / nyq], btype="band", output="sos")
            band = sosfilt(sos, dry).astype(np.float32)
    except Exception:  # noqa: BLE001 — SciPy missing / filter blew up → skip band-limit
        band = dry

    # Sample-rate crush via zero-order hold (decimate, then repeat-hold back up).
    crush_sr = float(np.interp(a, [0.0, 1.0], [12000.0, 5000.0]))
    step = max(1, int(round(sr / crush_sr)))
    crushed = band
    if step > 1:
        held = np.repeat(band[::step], step)[: band.size]
        if held.size < band.size:  # pad the tail so lengths match exactly
            held = np.concatenate([held, np.full(band.size - held.size, held[-1] if held.size else 0.0, dtype=np.float32)])
        crushed = held.astype(np.float32)

    # Bit-depth crush (10 bits → 6 bits at full weight).
    bits = float(np.interp(a, [0.0, 1.0], [11.0, 6.0]))
    levels = float(2.0 ** bits)
    crushed = np.round(crushed * levels) / levels

    # Squashed earpiece loudness.
    crushed = np.tanh(crushed * (1.0 + 2.5 * a)).astype(np.float32)

    c = float(np.clip(crackle, 0.0, 1.0))
    if c > 1e-3:
        rng = np.random.default_rng()
        n = crushed.size
        crushed = crushed + (rng.standard_normal(n).astype(np.float32) * 0.012 * c)
        # Sparse pops/clicks — a dying connection.
        k = int((6.0 + 50.0 * c) * n / sr)
        if k > 0:
            idx = rng.integers(0, n, size=k)
            crushed[idx] += rng.standard_normal(k).astype(np.float32) * 0.6 * c

    # Re-match the crushed signal to the dry clip's level before the wet/dry mix.
    wet_peak = float(np.max(np.abs(crushed))) or 1.0
    dry_peak = float(np.max(np.abs(dry))) or 1.0
    crushed = crushed / wet_peak * dry_peak

    m = min(crushed.size, dry.size)
    return ((1.0 - a) * dry[:m] + a * crushed[:m]).astype(np.float32)


def apply_transforms(
    wav: np.ndarray, sr: int, transforms: Optional[Dict[str, Any]]
) -> np.ndarray:
    """Apply the full transform chain to a mono float32 take. Returns the take
    unchanged if there's nothing to do or anything goes wrong."""
    n = normalize_transforms(transforms)
    if not has_effect(n):
        return np.asarray(wav, dtype=np.float32)
    wav = np.asarray(wav, dtype=np.float32)
    if wav.size < sr // 50:  # < 20 ms — nothing to analyse
        return wav

    out = wav
    # WORLD-domain (pitch/formant/sub/vibrato) first so time-domain colours sit
    # on top of the reshaped voice.
    if (
        abs(n["pitch"]) > 1e-3
        or abs(n["formant"]) > 1e-3
        or n["sub"] > 1e-3
        or n["vibrato"] > 1e-3
    ):
        try:
            out = _world_transform(out, sr, n)
        except Exception:  # noqa: BLE001 — never let a transform kill a render
            out = wav

    if n["drive"] > 1e-3:
        out = _drive(out, n["drive"])
    if n["ringmod"] > 1e-3:
        out = _ringmod(out, sr, n["ringmod"], n["ringmod_hz"])
    # Telephone last: it models the transmission channel, so it colours whatever
    # voice the earlier stages produced.
    if n["telephone"] > 1e-3:
        out = _telephone(out, sr, n["telephone"], n["tel_crackle"])

    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1.0:
        out = out / peak
    return np.asarray(out, dtype=np.float32)


def estimate_f0_median(wav: np.ndarray, sr: int) -> float:
    """Median voiced f0 (Hz) of a clip, or 0.0 if unvoiced/too short."""
    wav = np.asarray(wav, dtype=np.float32)
    if wav.size < sr // 10:
        return 0.0
    try:
        import pyworld as pw

        x = np.ascontiguousarray(wav.astype(np.float64))
        f0, _ = pw.harvest(x, sr, f0_floor=_F0_FLOOR, f0_ceil=_F0_CEIL, frame_period=_FRAME_PERIOD)
        voiced = f0[f0 > 0]
        if voiced.size == 0:
            return 0.0
        return float(np.median(voiced))
    except Exception:  # noqa: BLE001
        return 0.0


# Cache target-voice f0 by (path, mtime) — harvest is the slow part and a voice
# reference doesn't change between renders.
_TARGET_F0_CACHE: Dict[Tuple[str, float], float] = {}


def target_voice_f0(path: str) -> float:
    """Median f0 (Hz) of a reference voice file, cached by path + mtime."""
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return 0.0
    key = (str(path), mt)
    if key in _TARGET_F0_CACHE:
        return _TARGET_F0_CACHE[key]
    from .audio_utils import load_audio

    f0 = estimate_f0_median(load_audio(str(path), sr=24000), 24000)
    _TARGET_F0_CACHE[key] = f0
    return f0


def auto_pitch_shift(take: np.ndarray, take_sr: int, target_path: str, cap: float = 18.0) -> float:
    """Semitones to move the take's median f0 onto the target voice's, capped.
    0.0 if either pitch can't be detected (transparent no-op). The transparent
    "auto pitch-match to target" preprocessing — deterministic, no UI."""
    tgt = target_voice_f0(target_path)
    tk = estimate_f0_median(np.asarray(take, dtype=np.float32), take_sr)
    if tk <= 1e-3 or tgt <= 1e-3:
        return 0.0
    return float(np.clip(12.0 * np.log2(tgt / tk), -cap, cap))


def suggest_pitch_semitones(
    take: np.ndarray,
    take_sr: int,
    target: np.ndarray,
    target_sr: int,
    cap: float = 18.0,
) -> Dict[str, float]:
    """Semitone shift that moves the take's median f0 onto the target voice's.
    Returns the (capped) suggestion plus both raw medians for the UI."""
    take_hz = estimate_f0_median(take, take_sr)
    target_hz = estimate_f0_median(target, target_sr)
    semitones = 0.0
    if take_hz > 1e-3 and target_hz > 1e-3:
        semitones = float(np.clip(12.0 * np.log2(target_hz / take_hz), -cap, cap))
    return {
        "semitones": round(semitones, 2),
        "take_hz": round(take_hz, 1),
        "target_hz": round(target_hz, 1),
    }
