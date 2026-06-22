"""Essentia Analyzer — OmniVoice headless *service* plug-in.

Audio in → a structured breakdown out: tempo (BPM), key, integrated loudness,
danceability (DSP, always available), plus genre / mood-theme / instrument /
vocal-vs-instrumental tags via Essentia's TensorFlow models (Discogs-EffNet
embeddings + MTG-Jamendo classifier heads). It has **no UI** — it exists only to
be brokered by the host through the ``analyze_audio`` capability (e.g. on
sound-library ingest, or on demand). TensorFlow is quarantined in this plug-in's
own venv — the textbook reason an otherwise-lightweight CPU tool is a sidecar
rather than core.

The handler degrades gracefully: if essentia-tensorflow or the model files are
missing, it still returns the DSP fields and simply omits the learned tags, so
the core always gets *something* useful.

Output maps onto OmniVoice's core analysis schema (manager/library_meta.py):
  bpm, key, loudness_lufs, duration_s, danceability,
  genre[], mood[], instruments[], voice_instrumental, extra{}.

Config via env:
  ESSENTIA_TOPK         tags to keep per head (default 5)
  ESSENTIA_TAG_FLOOR    min activation to report a tag (default 0.1)
  ESSENTIA_MODELS_DIR   override model dir (default <plugin>/models)
"""

from __future__ import annotations

import json
import os
import platform
import sys


def _no_prebuilt_essentia() -> bool:
    """True on platforms where Essentia ships no installable package, so a failed
    import is an expected platform limit rather than a broken install. Essentia's
    Python wheels cover Linux x86_64 and macOS (x86_64/arm64) only — there are no
    Windows wheels and no Linux aarch64 wheels (and no conda-forge build)."""
    sysname = platform.system().lower()
    if sysname == "windows":
        return True
    if sysname == "linux":
        return (platform.machine() or "").lower() not in ("x86_64", "amd64", "i686", "i386")
    return False  # macOS: wheels exist for x86_64 and arm64

# This is a declared CPU service (plugin.json gpu:false) — the host does NOT free
# the TTS model for us, so TensorFlow must never touch VRAM. Force CPU + quiet the
# (very chatty) TF startup logs before essentia/TF import.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

_sdk = os.environ.get("OMNIVOICE_PLUGIN_SDK")
if _sdk and _sdk not in sys.path:
    sys.path.insert(0, _sdk)

from omnivoice_plugin import run

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.environ.get("ESSENTIA_MODELS_DIR", os.path.join(HERE, "models"))
TOPK = int(os.environ.get("ESSENTIA_TOPK", "5") or 5)
TAG_FLOOR = float(os.environ.get("ESSENTIA_TAG_FLOOR", "0.05") or 0.05)

# Classifier heads that run on Discogs-EffNet embeddings. Each is a (.pb, .json)
# pair under MODELS_DIR; the .json carries the class label list. Missing heads
# are skipped (graceful degradation).
EMBED_MODEL = "discogs-effnet-bs64-1.pb"
HEADS = {
    "genre": "genre_discogs400-discogs-effnet-1",
    "mood": "mtg_jamendo_moodtheme-discogs-effnet-1",
    "instruments": "mtg_jamendo_instrument-discogs-effnet-1",
    "voice_instrumental": "voice_instrumental-discogs-effnet-1",
}


def _head_spec(stem: str):
    """Read a classifier head's label list + input/output tensor names from its
    sidecar JSON (they differ per head — e.g. voice_instrumental uses
    model/Placeholder→model/Softmax while genre uses
    serving_default_model_Placeholder→PartitionedCall:0)."""
    p = os.path.join(MODELS_DIR, stem + ".json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    classes = list(meta.get("classes") or [])
    schema = meta.get("schema") or {}
    inputs = schema.get("inputs") or []
    outputs = schema.get("outputs") or []
    in_name = inputs[0].get("name") if inputs else None
    out_name = None
    for o in outputs:
        if o.get("output_purpose") == "predictions":
            out_name = o.get("name")
            break
    if out_name is None and outputs:
        out_name = outputs[0].get("name")
    if not (classes and in_name and out_name):
        return None
    return {"classes": classes, "input": in_name, "output": out_name}


class EssentiaAnalyzer:
    def __init__(self):
        self._es = None          # essentia.standard module
        self._embed = None       # cached EffNet embedding model
        self._np = None
        self._import_error = None  # why import failed (surfaced to the host)

    # ---- lifecycle ----
    def load(self, ctx):
        import traceback  # noqa: PLC0415
        try:
            import numpy as np  # noqa: PLC0415
            import essentia.standard as es  # noqa: PLC0415
        except BaseException as e:  # noqa: BLE001 — catch SystemExit/abort from native libs too
            # The venv exists but the native extension won't import here (common on
            # platforms without prebuilt wheels — e.g. linux aarch64 / macOS arm64).
            # Capture the real cause so the host surfaces it instead of a generic
            # "not installed", and dump the traceback to the plug-in log.
            self._import_error = f"{type(e).__name__}: {e}"
            ctx.log(f"Essentia import failed — {self._import_error}", "error")
            ctx.log(traceback.format_exc(), "error")
            return
        self._np = np
        self._es = es
        self._import_error = None
        ctx.log("Essentia ready (DSP always; TF tags if models present).")

    def health(self, ctx):
        if self._es is None:
            self.load(ctx)
        return {
            "ok": self._es is not None,
            "import_error": self._import_error,
            "platform_unsupported": self._es is None and _no_prebuilt_essentia(),
            "platform": f"{platform.system()}/{platform.machine()}",
            "models_dir": MODELS_DIR,
        }

    def unload(self, ctx):
        self._embed = None

    # ---- embeddings + classifier heads (TensorFlow) ----
    def _embeddings(self, ctx, audio16):
        """Discogs-EffNet embeddings for the (16 kHz mono) signal, or None."""
        es = self._es
        pb = os.path.join(MODELS_DIR, EMBED_MODEL)
        if not os.path.exists(pb):
            return None
        try:
            if self._embed is None:
                self._embed = es.TensorflowPredictEffnetDiscogs(
                    graphFilename=pb, output="PartitionedCall:1"
                )
            return self._embed(audio16)
        except Exception as e:  # noqa: BLE001
            ctx.log(f"EffNet embedding failed ({e}); skipping learned tags.", "warn")
            return None

    def _run_head(self, ctx, stem, embeddings):
        es, np = self._es, self._np
        pb = os.path.join(MODELS_DIR, stem + ".pb")
        spec = _head_spec(stem)
        if not os.path.exists(pb) or spec is None:
            return None
        try:
            head = es.TensorflowPredict2D(
                graphFilename=pb, input=spec["input"], output=spec["output"]
            )
            acts = head(embeddings)               # [frames x classes]
            mean = np.mean(acts, axis=0)          # per-class score
            return mean, spec["classes"]
        except Exception as e:  # noqa: BLE001
            ctx.log(f"Classifier '{stem}' failed ({e}).", "warn")
            return None

    def _topk_tags(self, mean, labels):
        np = self._np
        order = np.argsort(mean)[::-1]
        out = []
        for i in order[:TOPK]:
            score = float(mean[i])
            if score < TAG_FLOOR:
                break
            out.append({"label": str(labels[i]), "score": round(score, 4)})
        return out

    # ---- the capability ----
    def analyze_audio(self, ctx, **payload):
        """Analyze one audio file. Payload: {"path": "<abs path>"}.
        Returns the core analysis schema (graceful subset if TF is unavailable)."""
        path = str(payload.get("path") or payload.get("audio_path") or "").strip()
        if not path or not os.path.exists(path):
            raise RuntimeError(f"Audio file not found: {path!r}")
        if self._es is None:
            self.load(ctx)
        if self._es is None:
            if _no_prebuilt_essentia():
                raise RuntimeError(
                    f"The Essentia analyzer isn't available on this platform "
                    f"({platform.system()}/{platform.machine()}). Essentia publishes no "
                    "installable package for it — there's no PyPI wheel and no conda-forge "
                    "build for Linux aarch64. Sounds still save and you can edit metadata by "
                    "hand; to enable analysis here, reinstall the built-in with "
                    "ESSENTIA_BUILD_FROM_SOURCE=1 (compiles Essentia — needs a C++ toolchain "
                    "and audio dev libraries)."
                )
            raise RuntimeError(
                "Essentia failed to import in the analyzer's venv "
                f"({self._import_error or 'unknown error'}). The venv exists but the "
                "native library won't load — see the plug-in log "
                "(data/plugins/logs/essentia-analyzer.log) for the full traceback."
            )
        es, np = self._es, self._np

        ctx.progress(stage="dsp", message="Analyzing tempo / key / loudness…")
        out = {
            "bpm": None, "key": None, "loudness_lufs": None, "duration_s": None,
            "danceability": None, "genre": [], "mood": [], "instruments": [],
            "voice_instrumental": None, "extra": {},
        }

        # ---- DSP (44.1 kHz mono) ----
        try:
            mono = es.MonoLoader(filename=path, sampleRate=44100)()
            if len(mono):
                out["duration_s"] = round(len(mono) / 44100.0, 3)
                try:
                    bpm, _, conf, _, _ = es.RhythmExtractor2013(method="multifeature")(mono)
                    out["bpm"] = round(float(bpm), 2)
                    out["extra"]["bpm_confidence"] = round(float(conf), 3)
                except Exception as e:  # noqa: BLE001
                    ctx.log(f"BPM failed ({e}).", "warn")
                try:
                    k, scale, strength = es.KeyExtractor()(mono)
                    out["key"] = f"{k} {scale}"
                    out["extra"]["key_strength"] = round(float(strength), 3)
                except Exception as e:  # noqa: BLE001
                    ctx.log(f"Key failed ({e}).", "warn")
                try:
                    dance, _ = es.Danceability()(mono)
                    out["danceability"] = round(float(dance) / 3.0, 4)  # ~0..3 → ~0..1
                except Exception as e:  # noqa: BLE001
                    ctx.log(f"Danceability failed ({e}).", "warn")
                try:
                    loud = es.LoudnessEBUR128()
                    stereo = np.column_stack([mono, mono]).astype("float32")
                    _, _, integrated, _ = loud(stereo)
                    out["loudness_lufs"] = round(float(integrated), 2)
                except Exception as e:  # noqa: BLE001
                    ctx.log(f"Loudness failed ({e}).", "warn")
        except Exception as e:  # noqa: BLE001
            ctx.log(f"DSP load failed ({e}).", "warn")

        # ---- learned tags (16 kHz mono → EffNet embeddings → heads) ----
        try:
            ctx.progress(stage="tags", message="Tagging genre / mood / instruments…")
            audio16 = es.MonoLoader(filename=path, sampleRate=16000)()
            emb = self._embeddings(ctx, audio16) if len(audio16) else None
            if emb is not None:
                for field, stem in HEADS.items():
                    res = self._run_head(ctx, stem, emb)
                    if res is None:
                        continue
                    mean, labels = res
                    if field == "voice_instrumental":
                        # 2-class head: pick the winner; labels like ["instrumental","voice"].
                        idx = int(np.argmax(mean))
                        lab = str(labels[idx]).lower()
                        out["voice_instrumental"] = "vocal" if lab.startswith("voice") or lab.startswith("voc") else "instrumental"
                        out["extra"]["vocal_score"] = round(float(np.max(mean)), 4)
                    else:
                        tags = self._topk_tags(mean, labels)
                        out[field] = [t["label"] for t in tags]
                        out["extra"][f"{field}_scored"] = tags
        except Exception as e:  # noqa: BLE001
            ctx.log(f"Tagging stage failed ({e}); returning DSP only.", "warn")

        ctx.log(
            f"Analyzed {os.path.basename(path)}: bpm={out['bpm']} key={out['key']} "
            f"genre={out['genre'][:2]} vocal={out['voice_instrumental']}"
        )
        return out


run(EssentiaAnalyzer())
