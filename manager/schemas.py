"""Pydantic request/response models for the API."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SpeakerConfig(BaseModel):
    mode: str = "clone"  # clone | design | auto
    voice: Optional[str] = None  # voice library id (relative path) for clone mode
    ref_text: Optional[str] = None
    instruct: Optional[str] = None  # voice-design attributes for design mode
    language: Optional[str] = None
    isolate: bool = True
    normalize: bool = True
    dereverb: bool = False
    dereverb_method: str = "roformer"  # roformer | deepfilternet


class GenParams(BaseModel):
    num_step: int = 32
    guidance_scale: float = 2.0
    speed: float = 1.0
    duration: Optional[float] = None
    denoise: bool = True
    t_shift: float = 0.1
    preprocess_prompt: bool = True
    postprocess_output: bool = True
    gap_ms: int = 250
    # Perceptual loudness leveling across stitched segments (LUFS, EBU R128).
    match_loudness: bool = True
    target_lufs: float = -20.0
    peak_ceiling_db: float = -1.0


class GenerateRequest(BaseModel):
    text: Optional[str] = None  # used when not multi-speaker
    script: Optional[str] = None  # multi-speaker script with "Speaker N:" lines
    multi_speaker: bool = False
    num_speakers: int = 1
    speakers: Dict[str, SpeakerConfig] = Field(default_factory=dict)
    params: GenParams = Field(default_factory=GenParams)
    title: Optional[str] = None
    prompt: Optional[str] = None  # originating AI idea, for history restore
    save: bool = True


class RegenSegmentRequest(BaseModel):
    # Optional edited dialogue for the segment; if set, it replaces the stored
    # line before regenerating (and is persisted to the session).
    text: Optional[str] = None


class ScriptRequest(BaseModel):
    prompt: str
    num_speakers: int = 2
    speakers: Optional[List[Dict[str, Any]]] = None
    existing_script: str = ""
    previous: Optional[Dict[str, str]] = None
    temperature: float = 0.7
    provider_id: Optional[str] = None


class ScriptAndSpeakRequest(BaseModel):
    """One-shot smart-script -> audio (for ComfyUI / external automation)."""

    prompt: str
    num_speakers: int = 2
    speakers: Dict[str, SpeakerConfig] = Field(default_factory=dict)
    params: GenParams = Field(default_factory=GenParams)
    temperature: float = 0.7
    save: bool = True
    provider_id: Optional[str] = None


class ProcessVoiceRequest(BaseModel):
    """Voice Lab: process a library voice or uploaded temp file and save it."""

    source: str  # voice id in library OR a temp upload id
    is_upload: bool = False
    isolate: bool = True
    normalize: bool = True
    trim: bool = True
    dereverb: bool = False
    dereverb_method: str = "roformer"  # roformer | deepfilternet
    gain_db: float = 0.0
    # Manual trim window (seconds) applied to the source before processing. A
    # trim_end of 0 (or <= trim_start) means "keep to the end".
    trim_start: float = 0.0
    trim_end: float = 0.0
    overwrite: bool = False  # overwrite the selected library voice in place
    save_as: str  # destination relative path in custom_voices/


class LoadModelRequest(BaseModel):
    model_id: Optional[str] = None
    load_on_demand: Optional[bool] = None
