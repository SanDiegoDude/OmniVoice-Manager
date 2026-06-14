"""Configuration and shared paths for the OmniVoice Manager."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import dotenv_values, load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = REPO_ROOT / ".env"

# Load .env from repo root (Gemini / OpenAI-compatible script AI keys live here).
load_dotenv(ENV_PATH)

CUSTOM_VOICES_DIR = REPO_ROOT / "custom_voices"
OUTPUT_DIR = REPO_ROOT / "output"
DATA_DIR = REPO_ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"
MODELS_DIR = REPO_ROOT / "models"
WEB_DIST_DIR = REPO_ROOT / "web" / "dist"

AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}

for _d in (CUSTOM_VOICES_DIR, OUTPUT_DIR, DATA_DIR, HISTORY_DIR, MODELS_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


@dataclass
class Settings:
    """Runtime settings, overridable via CLI in server.py."""

    model_id: str = field(default_factory=lambda: _env("OMNIVOICE_MODEL", "k2-fsa/OmniVoice"))
    # "auto" resolves to the best backend inside the GPU worker (CUDA > MPS >
    # CPU), keeping the server process torch-free. Pin e.g. "cuda:0" / "mps" /
    # "cpu" via OMNIVOICE_DEVICE or --device.
    device: str = field(default_factory=lambda: _env("OMNIVOICE_DEVICE", "auto"))
    dtype: str = "float16"
    # Load-on-demand: load the TTS model per job in a child process and free
    # VRAM by terminating it afterwards (mirrors VibeVoice's --lod).
    load_on_demand: bool = False
    # Low-VRAM: within a job, load models sequentially and free each secondary
    # model (isolation / dereverb) before the TTS model loads, minimizing the
    # peak VRAM at the cost of some speed. Great for smaller consumer GPUs.
    low_vram: bool = False
    # Auto-trim near-silence from both ends of every generated clip and recorded
    # take (leaves a small natural pad). Kills the dead air the model and human
    # timing leave at the head/tail so users stop hand-trimming every segment.
    trim_silence: bool = False
    # Output encoding for finished renders + history. MP3 keeps files small and
    # universally shareable (socials/messaging) without audible loss for speech.
    output_format: str = "mp3"  # mp3 | wav | m4a | ogg
    output_bitrate: str = "192k"
    # Pre-load the model at startup (only relevant when not in LOD mode).
    eager_load: bool = False
    host: str = "0.0.0.0"
    port: int = 8200
    debug: bool = False
    asr_model: str = field(default_factory=lambda: _env("OMNIVOICE_ASR_MODEL", "openai/whisper-large-v3-turbo"))
    # Preload Whisper ASR at model load. Default off: it loads on demand only when
    # a clone reference has no transcript, saving ~1.6 GB of VRAM otherwise.
    load_asr: bool = False

    # ---- Script AI (OpenAI-compatible / Gemini) ----
    @property
    def script_ai_url(self) -> str:
        return _env("SCRIPT_AI_URL")

    @property
    def script_ai_model(self) -> str:
        return _env("SCRIPT_AI_MODEL") or _env("OPENAI_MODEL", "gpt-4.1-mini")

    @property
    def script_ai_key(self) -> str:
        return _env("SCRIPT_AI_API_KEY") or _env("OPENAI_API_KEY")


settings = Settings()


def list_available_models() -> List[str]:
    """Models offered in the UI dropdown. Extendable via OMNIVOICE_MODELS env."""
    raw = _env("OMNIVOICE_MODELS")
    models = [m.strip() for m in raw.split(",") if m.strip()] if raw else []
    if settings.model_id not in models:
        models.insert(0, settings.model_id)
    return models


# ---------------------------------------------------------------------------
# AI Script providers (multi-provider, hot-reloadable from .env)
# ---------------------------------------------------------------------------
# Primary format (one provider per line):
#   AI_PROVIDER_<ID> = Label | model | base_url (blank = OpenAI) | api_key
# Legacy single-provider vars (OPENAI_* / SCRIPT_AI_*) are also recognized.

_active_provider_id: Optional[str] = None


def _endpoint_kind(url: str) -> str:
    if not url:
        return "openai"
    if "generativelanguage.googleapis.com" in url:
        return "gemini"
    return "custom"


def _resolve_providers() -> List[Dict[str, str]]:
    """Read providers fresh from the .env file (respects comments)."""
    vals = dotenv_values(ENV_PATH) if ENV_PATH.exists() else {}
    providers: List[Dict[str, str]] = []
    seen_ids = set()

    # New per-line format.
    for key, raw in vals.items():
        if not key.startswith("AI_PROVIDER_") or not raw:
            continue
        pid = key[len("AI_PROVIDER_") :].lower()
        parts = [p.strip() for p in str(raw).split("|")]
        label = parts[0] if parts and parts[0] else pid
        model = parts[1] if len(parts) > 1 else ""
        url = parts[2] if len(parts) > 2 else ""
        api_key = parts[3] if len(parts) > 3 else ""
        if not model:
            continue
        providers.append(
            {"id": pid, "label": label, "model": model, "url": url, "key": api_key, "endpoint": _endpoint_kind(url)}
        )
        seen_ids.add(pid)

    # Legacy fallbacks (only if not already defined above).
    def _v(name: str) -> str:
        return (vals.get(name) or "").strip()

    if (_v("SCRIPT_AI_MODEL") or _v("SCRIPT_AI_URL")) and "script_ai" not in seen_ids:
        url = _v("SCRIPT_AI_URL")
        label = "Gemini" if "googleapis" in url else ("Local / Custom" if url else "Script AI")
        providers.append(
            {
                "id": "script_ai",
                "label": label,
                "model": _v("SCRIPT_AI_MODEL") or _v("OPENAI_MODEL") or "gpt-4.1-mini",
                "url": url,
                "key": _v("SCRIPT_AI_API_KEY") or _v("OPENAI_API_KEY"),
                "endpoint": _endpoint_kind(url),
            }
        )
    if _v("OPENAI_API_KEY") and "openai" not in seen_ids:
        providers.append(
            {
                "id": "openai",
                "label": f"OpenAI ({_v('OPENAI_MODEL') or 'gpt-4.1-mini'})",
                "model": _v("OPENAI_MODEL") or "gpt-4.1-mini",
                "url": "",
                "key": _v("OPENAI_API_KEY"),
                "endpoint": "openai",
            }
        )
    return providers


def list_providers_public() -> List[Dict[str, object]]:
    """Provider list for the UI (no secrets)."""
    return [
        {"id": p["id"], "label": p["label"], "model": p["model"], "endpoint": p["endpoint"], "has_key": bool(p["key"])}
        for p in _resolve_providers()
    ]


def get_provider(pid: Optional[str]) -> Optional[Dict[str, str]]:
    if not pid:
        return None
    for p in _resolve_providers():
        if p["id"] == pid:
            return p
    return None


def active_provider() -> Optional[Dict[str, str]]:
    providers = _resolve_providers()
    if not providers:
        return None
    if _active_provider_id:
        for p in providers:
            if p["id"] == _active_provider_id:
                return p
    return providers[0]


def set_active_provider(pid: str) -> bool:
    global _active_provider_id
    if get_provider(pid):
        _active_provider_id = pid
        return True
    return False


def get_active_provider_id() -> Optional[str]:
    p = active_provider()
    return p["id"] if p else None


def reload_env() -> None:
    """Re-read .env into the environment (providers are read fresh each call)."""
    if ENV_PATH.exists():
        load_dotenv(ENV_PATH, override=True)
