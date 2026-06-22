"""Audio Analyzer — OmniVoice headless *universal* service plug-in.

Audio in → a structured breakdown out, using a pure-Python / PyTorch stack that
installs on **every** platform OmniVoice runs on (Linux x86_64 + aarch64, Windows,
macOS arm64) — unlike Essentia, whose native wheels are x86_64-Linux/macOS only.

  * DSP (always): tempo (BPM), key, integrated loudness (LUFS), duration, and a
    danceability proxy — via ``librosa`` + ``pyloudnorm``.
  * Learned tags: genre / mood / instruments / vocal-vs-instrumental — via
    **PANNs** (CNN14 trained on AudioSet's 527 classes), run on CPU through
    PyTorch.

It has **no UI** — it exists only to be brokered by the host through the
``analyze_audio`` capability (sound-library ingest, or on demand). Output maps
onto OmniVoice's core analysis schema (manager/library_meta.py):

  bpm, key, loudness_lufs, duration_s, danceability,
  genre[], mood[], instruments[], voice_instrumental, extra{}.

The handler degrades gracefully: if PANNs/torch or the checkpoint are missing it
still returns the DSP fields and simply omits the learned tags.

Config via env:
  AUDIO_ANALYZER_TOPK        tags to keep per field (default 5)
  AUDIO_ANALYZER_TAG_FLOOR   min probability to report a tag (default 0.05)
  AUDIO_ANALYZER_CKPT        override PANNs checkpoint path (default models/Cnn14_mAP=0.431.pth)
"""

from __future__ import annotations

import os
import sys

# Declared CPU service (plugin.json gpu:false) — the host does NOT free the TTS
# model for us, so PyTorch must never touch VRAM. Pin CPU before torch imports.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("OMP_NUM_THREADS", os.environ.get("OMP_NUM_THREADS", "4"))

_sdk = os.environ.get("OMNIVOICE_PLUGIN_SDK")
if _sdk and _sdk not in sys.path:
    sys.path.insert(0, _sdk)

from omnivoice_plugin import run

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CKPT = os.path.join(HERE, "models", "Cnn14_mAP=0.431.pth")
CKPT = os.environ.get("AUDIO_ANALYZER_CKPT", DEFAULT_CKPT)
TOPK = int(os.environ.get("AUDIO_ANALYZER_TOPK", "5") or 5)
TAG_FLOOR = float(os.environ.get("AUDIO_ANALYZER_TAG_FLOOR", "0.05") or 0.05)

PANNS_SR = 32000  # CNN14 was trained at 32 kHz

# Krumhansl-Schmuckler key profiles (major / minor), used to estimate key from a
# mean chroma vector. Index 0 == C.
_KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
_PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# ── AudioSet label → core field mapping ───────────────────────────────────────
# PANNs emits probabilities over AudioSet's 527 classes. We bucket the musically
# meaningful ones onto our schema. Matching is exact (case-insensitive) against
# panns_inference.labels. Anything off these lists is ignored for the schema but
# the raw top hits are preserved in extra["audioset_top"].
_GENRE = {
    "pop music", "hip hop music", "rock music", "rhythm and blues", "soul music",
    "reggae", "country", "funk", "folk music", "middle eastern music", "jazz",
    "disco", "classical music", "electronic music", "house music", "techno",
    "dubstep", "drum and bass", "electronica", "electronic dance music",
    "ambient music", "trance music", "music of latin america", "salsa music",
    "flamenco", "blues", "music for children", "new-age music", "music of africa",
    "afrobeat", "christian music", "gospel music", "music of asia",
    "carnatic music", "music of bollywood", "ska", "traditional music",
    "independent music", "swing music", "bluegrass", "opera", "punk rock",
    "heavy metal", "grunge", "progressive rock", "psychedelic rock",
}
_MOOD = {
    "happy music", "funny music", "sad music", "tender music", "exciting music",
    "angry music", "scary music",
}
_INSTRUMENT = {
    "plucked string instrument", "guitar", "electric guitar", "bass guitar",
    "acoustic guitar", "steel guitar, slide guitar", "banjo", "sitar", "mandolin",
    "zither", "ukulele", "keyboard (musical)", "piano", "electric piano", "organ",
    "electronic organ", "hammond organ", "synthesizer", "sampler", "harpsichord",
    "percussion", "drum kit", "drum machine", "drum", "snare drum", "bass drum",
    "timpani", "tabla", "cymbal", "hi-hat", "wood block", "tambourine",
    "rattle (instrument)", "maraca", "gong", "tubular bells", "mallet percussion",
    "marimba, xylophone", "glockenspiel", "vibraphone", "steelpan", "orchestra",
    "brass instrument", "french horn", "trumpet", "trombone",
    "bowed string instrument", "string section", "violin, fiddle", "cello",
    "double bass", "wind instrument, woodwind instrument", "flute", "saxophone",
    "clarinet", "oboe", "bassoon", "harp", "harmonica", "accordion", "bagpipes",
    "didgeridoo", "theremin", "bell", "cowbell", "wind chime",
}
# Vocal presence: any of these scoring above a small floor flips the track to
# "vocal"; otherwise we call it "instrumental".
_VOCAL = {
    "singing", "vocal music", "choir", "yodeling", "chant", "mantra",
    "male singing", "female singing", "child singing", "synthetic singing",
    "rapping", "a capella", "humming",
}
_VOCAL_FLOOR = 0.15


class AudioAnalyzer:
    def __init__(self):
        self._np = None
        self._librosa = None
        self._meter_cls = None     # pyloudnorm.Meter
        self._tagger = None        # panns_inference.AudioTagging
        self._labels = None        # AudioSet label list
        self._import_error = None
        self._tags_error = None

    # ---- lifecycle ----
    def load(self, ctx):
        import traceback  # noqa: PLC0415
        try:
            import numpy as np  # noqa: PLC0415
            import librosa  # noqa: PLC0415
            import pyloudnorm as pyln  # noqa: PLC0415
        except BaseException as e:  # noqa: BLE001
            self._import_error = f"{type(e).__name__}: {e}"
            ctx.log(f"Core DSP import failed — {self._import_error}", "error")
            ctx.log(traceback.format_exc(), "error")
            return
        self._np = np
        self._librosa = librosa
        self._meter_cls = pyln.Meter
        self._import_error = None
        self._ensure_tagger(ctx)  # best-effort; DSP works without it
        ctx.log("Audio Analyzer ready (DSP always; PANNs tags if torch+checkpoint present).")

    def _ensure_tagger(self, ctx):
        """Lazily build the PANNs tagger. Failures are non-fatal (DSP still runs);
        the reason is captured for health()."""
        if self._tagger is not None:
            return self._tagger
        try:
            import torch  # noqa: PLC0415,F401
            from panns_inference import AudioTagging, labels  # noqa: PLC0415
        except BaseException as e:  # noqa: BLE001
            self._tags_error = f"{type(e).__name__}: {e}"
            ctx.log(f"PANNs unavailable ({self._tags_error}); DSP-only tags.", "warn")
            return None
        ckpt = CKPT if os.path.exists(CKPT) else None
        if ckpt is None:
            self._tags_error = f"checkpoint not found at {CKPT}"
            ctx.log(f"PANNs checkpoint missing ({CKPT}); DSP-only tags.", "warn")
            return None
        try:
            self._tagger = AudioTagging(checkpoint_path=ckpt, device="cpu")
            self._labels = list(labels)
            self._tags_error = None
        except BaseException as e:  # noqa: BLE001
            self._tags_error = f"{type(e).__name__}: {e}"
            ctx.log(f"PANNs load failed ({self._tags_error}); DSP-only tags.", "warn")
            return None
        return self._tagger

    def health(self, ctx):
        if self._np is None:
            self.load(ctx)
        return {
            "ok": self._np is not None,
            "import_error": self._import_error,
            "tags_available": self._tagger is not None,
            "tags_error": self._tags_error,
            "checkpoint": CKPT,
            "checkpoint_present": os.path.exists(CKPT),
        }

    def unload(self, ctx):
        self._tagger = None

    # ---- DSP helpers ----
    def _estimate_key(self, chroma_mean):
        np = self._np
        x = chroma_mean - chroma_mean.mean()
        if not np.any(x):
            return None, None
        best = (-2.0, 0, "major")
        for mode, profile in (("major", _KS_MAJOR), ("minor", _KS_MINOR)):
            p = np.array(profile, dtype="float64")
            p = p - p.mean()
            denom = (np.linalg.norm(x) * np.linalg.norm(p)) or 1.0
            for shift in range(12):
                corr = float(np.dot(x, np.roll(p, shift)) / denom)
                if corr > best[0]:
                    best = (corr, shift, mode)
        return f"{_PITCHES[best[1]]} {best[2]}", round(best[0], 3)

    # ---- learned tags ----
    def _tag(self, ctx, y32):
        """Run PANNs on a 32 kHz mono signal → bucketed tag dict, or None."""
        np = self._np
        tagger = self._ensure_tagger(ctx)
        if tagger is None:
            return None
        try:
            clip, _ = tagger.inference(y32[None, :])  # (1, 527)
        except BaseException as e:  # noqa: BLE001
            ctx.log(f"PANNs inference failed ({e}); skipping tags.", "warn")
            return None
        probs = np.asarray(clip).reshape(-1)
        labels = self._labels or []
        scored = {}
        for i, p in enumerate(probs):
            if i < len(labels):
                scored[labels[i].lower()] = float(p)

        def pick(group):
            hits = [(lab, scored.get(lab, 0.0)) for lab in group]
            hits = [(l, s) for l, s in hits if s >= TAG_FLOOR]
            hits.sort(key=lambda t: t[1], reverse=True)
            return hits[:TOPK]

        genre = pick(_GENRE)
        mood = pick(_MOOD)
        instruments = pick(_INSTRUMENT)
        vocal_score = max((scored.get(l, 0.0) for l in _VOCAL), default=0.0)
        order = np.argsort(probs)[::-1][:10]
        top = [{"label": labels[i], "score": round(float(probs[i]), 4)}
               for i in order if i < len(labels)]
        return {
            "genre": [l for l, _ in genre],
            "mood": [l for l, _ in mood],
            "instruments": [l for l, _ in instruments],
            "voice_instrumental": "vocal" if vocal_score >= _VOCAL_FLOOR else "instrumental",
            "extra": {
                "genre_scored": [{"label": l, "score": round(s, 4)} for l, s in genre],
                "mood_scored": [{"label": l, "score": round(s, 4)} for l, s in mood],
                "instruments_scored": [{"label": l, "score": round(s, 4)} for l, s in instruments],
                "vocal_score": round(float(vocal_score), 4),
                "audioset_top": top,
            },
        }

    # ---- the capability ----
    def analyze_audio(self, ctx, **payload):
        """Analyze one audio file. Payload: {"path": "<abs path>"}.
        Returns the core analysis schema (graceful subset if PANNs is unavailable)."""
        path = str(payload.get("path") or payload.get("audio_path") or "").strip()
        if not path or not os.path.exists(path):
            raise RuntimeError(f"Audio file not found: {path!r}")
        if self._np is None:
            self.load(ctx)
        if self._np is None:
            raise RuntimeError(
                "Audio Analyzer failed to import its DSP stack "
                f"({self._import_error or 'unknown error'}). See the plug-in log "
                "(data/plugins/logs/audio-analyzer.log) for the full traceback."
            )
        np, librosa = self._np, self._librosa

        out = {
            "bpm": None, "key": None, "loudness_lufs": None, "duration_s": None,
            "danceability": None, "genre": [], "mood": [], "instruments": [],
            "voice_instrumental": None, "extra": {},
        }

        # ---- load once at 32 kHz mono (PANNs sr; librosa features are sr-agnostic) ----
        ctx.progress(stage="dsp", message="Analyzing tempo / key / loudness…")
        try:
            y, sr = librosa.load(path, sr=PANNS_SR, mono=True)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"Could not decode audio ({type(e).__name__}: {e}).")
        if not len(y):
            return out
        out["duration_s"] = round(len(y) / float(sr), 3)

        try:
            tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
            out["bpm"] = round(float(np.atleast_1d(tempo)[0]), 2)
        except Exception as e:  # noqa: BLE001
            ctx.log(f"BPM failed ({e}).", "warn")
        try:
            chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
            key, strength = self._estimate_key(chroma.mean(axis=1))
            out["key"] = key
            if strength is not None:
                out["extra"]["key_strength"] = strength
        except Exception as e:  # noqa: BLE001
            ctx.log(f"Key failed ({e}).", "warn")
        try:
            meter = self._meter_cls(sr)
            out["loudness_lufs"] = round(float(meter.integrated_loudness(y)), 2)
        except Exception as e:  # noqa: BLE001
            ctx.log(f"Loudness failed ({e}).", "warn")
        try:
            # Danceability proxy: mean pulse clarity (PLP) — how strongly a steady
            # beat is present (0..1-ish). Not Essentia's metric, but a useful signal.
            pulse = librosa.beat.plp(y=y, sr=sr)
            out["danceability"] = round(float(np.clip(pulse.mean() * 2.0, 0.0, 1.0)), 4)
        except Exception as e:  # noqa: BLE001
            ctx.log(f"Danceability proxy failed ({e}).", "warn")

        # ---- learned tags (PANNs) ----
        ctx.progress(stage="tags", message="Tagging genre / mood / instruments…")
        tags = self._tag(ctx, y.astype("float32"))
        if tags:
            out["genre"] = tags["genre"]
            out["mood"] = tags["mood"]
            out["instruments"] = tags["instruments"]
            out["voice_instrumental"] = tags["voice_instrumental"]
            out["extra"].update(tags["extra"])

        ctx.log(
            f"Analyzed {os.path.basename(path)}: bpm={out['bpm']} key={out['key']} "
            f"genre={out['genre'][:2]} vocal={out['voice_instrumental']}"
        )
        return out


run(AudioAnalyzer())
