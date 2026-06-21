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


class PluginInvokeRequest(BaseModel):
    """Generic plug-in command invocation (advanced / for custom plug-ins)."""
    cmd: str
    payload: Dict[str, Any] = Field(default_factory=dict)


class PluginInstallRequest(BaseModel):
    """Install a plug-in from a git URL into the host's plugins/ directory."""
    git_url: str
    name: Optional[str] = None       # folder under plugins/ (default: from URL)
    bootstrap: bool = True           # also run its bootstrap to build the venv
    force: bool = False              # overwrite an existing folder


class PluginGenerateRequest(BaseModel):
    """Generic audio-generator plug-in request. `fields` is the plug-in's own
    UI-schema payload (prompt, duration, etc.) passed through to its sidecar."""
    fields: Dict[str, Any] = Field(default_factory=dict)
    reprompt: bool = True
    provider_id: Optional[str] = None
    save: bool = True
    save_path: Optional[str] = None
    session_id: Optional[str] = None
    # Which library an eager save (save=True) lands in: "sound" (default, foley)
    # or "voice". Deferred Lab saves choose at save time via the import-temp routes.
    library: Optional[str] = None


class ImportTempSoundRequest(BaseModel):
    """Save a previously-generated temp preview into the sound library."""
    temp: str  # the temp filename returned by a generate job (result.temp)
    path: str  # library rel path/folder + filename to save under


class RegenSegmentRequest(BaseModel):
    # Optional edited dialogue for the segment; if set, it replaces the stored
    # line before regenerating (and is persisted to the session).
    text: Optional[str] = None
    # Ignore any attached vocal performance and render plain TTS with the
    # channel voice (Capture Performance toggled off).
    plain: bool = False


class EditSegmentRequest(BaseModel):
    """Non-generative timeline edits to a single segment."""
    start_s: Optional[float] = None
    trim_start_s: Optional[float] = None
    trim_end_s: Optional[float] = None
    speed: Optional[float] = None
    gain_db: Optional[float] = None
    fade_in_s: Optional[float] = None
    fade_out_s: Optional[float] = None
    # Dialogue + provenance. `text` sets the segment's dialogue plainly (e.g. a
    # placed foley clip carries its source prompt). `kind` tags the clip
    # ("foley" / "upload"); `meta` is an open bag (merged) for first-party and
    # plug-in segment metadata.
    text: Optional[str] = None
    kind: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None


class MoveSegmentRequest(BaseModel):
    """Re-home a clip onto another track (audio untouched)."""
    speaker_id: str
    start_s: Optional[float] = None


class TrackOrderRequest(BaseModel):
    """New top-to-bottom track order (every current track id exactly once)."""
    order: List[str]


class SetChannelRequest(BaseModel):
    """Channel-level (track) controls: custom name, output gain and/or mute."""
    name: Optional[str] = None
    gain_db: Optional[float] = None
    muted: Optional[bool] = None


class MergeSegmentsRequest(BaseModel):
    """Flatten 2+ segments on the same track into one continuous clip."""
    indices: List[int]


class InpaintRequest(BaseModel):
    """Toggle per-segment Vocal Inpaint (lock the clip's own audio as its voice)."""
    enabled: bool


class PromoteChannelRequest(BaseModel):
    """Promote an uploaded audio segment into a new clone speaker channel."""
    name: Optional[str] = None


class ReflowRequest(BaseModel):
    """Global tidy-up: re-arrange sequentially with a gap / global speed."""
    gap_ms: Optional[int] = None
    speed: Optional[float] = None


class InsertSegmentRequest(BaseModel):
    speaker_id: str
    text: str
    start_s: float = 0.0
    ripple: bool = False


class ImportClipRequest(BaseModel):
    # Existing output file (in the outputs dir) to drop onto a track as a segment.
    filename: str
    speaker_id: str
    text: str = ""
    start_s: float = 0.0


class EmptySessionRequest(BaseModel):
    """Spin up a blank multitrack timeline to compose by hand."""
    title: Optional[str] = None
    speakers: Dict[str, SpeakerConfig] = Field(default_factory=dict)
    params: GenParams = Field(default_factory=GenParams)


class DeleteSegmentRequest(BaseModel):
    ripple: bool = False


class SplitSegmentRequest(BaseModel):
    at_s: float


class SegmentTransformRequest(BaseModel):
    """Bake creative vocal transforms onto a segment's own audio (a no-op
    transform restores the clip's original audio)."""
    transforms: Dict[str, float] = Field(default_factory=dict)


class SegmentIsolateRequest(BaseModel):
    """Replace a segment's audio with an isolated stem from the RoFormer
    separator — "vocals" (the voice) or "instrumental" (the backing/music)."""
    stem: str = "vocals"  # vocals | instrumental


class DeleteSpaceRequest(BaseModel):
    start_s: float
    amount: float


class AddSpaceRequest(BaseModel):
    start_s: float
    amount: float = 3.0


class DuplicateSegmentRequest(BaseModel):
    start_s: float
    ripple: bool = False
    # Optional target track: re-home the copy onto another lane (alt-drag drop).
    speaker_id: Optional[str] = None


class TranscribeSegmentRequest(BaseModel):
    # Optional unsaved trim draft to transcribe instead of the stored values.
    trim_start_s: Optional[float] = None
    trim_end_s: Optional[float] = None
    speed: Optional[float] = None


class SetSegmentTextRequest(BaseModel):
    text: str


class ScriptRequest(BaseModel):
    prompt: str
    num_speakers: int = 2
    speakers: Optional[List[Dict[str, Any]]] = None
    existing_script: str = ""
    previous: Optional[Dict[str, str]] = None
    temperature: float = 0.7
    provider_id: Optional[str] = None
    # Voice Clone tab writes an unlabelled monologue; ADR Studio always writes
    # labelled dialogue. None = legacy fallback (monologue iff num_speakers <= 1).
    monologue: Optional[bool] = None


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
    # Pitch-preserving speed (1.0 = unchanged). Sample editor's speed knob.
    speed: float = 1.0
    # Manual trim window (seconds) applied to the source before processing. A
    # trim_end of 0 (or <= trim_start) means "keep to the end".
    trim_start: float = 0.0
    trim_end: float = 0.0
    overwrite: bool = False  # overwrite the selected library voice in place
    save_as: str  # destination relative path in custom_voices/
    # Creative vocal/audio transforms baked onto the processed audio (Sample
    # editor). Same free-form dict the segment transform uses.
    transforms: Optional[Dict[str, float]] = None


class SoundTransformRequest(BaseModel):
    """Sample editor (sound library side): clean up and/or bake vocal/audio
    transforms onto an existing library sound, then save a copy or overwrite it
    in place. Shares the cleanup pipeline with the Voice Lab (the editor just
    hides the vocal-only toggles for sounds)."""

    id: str  # sound id (relative path) in custom_sounds/
    transforms: Dict[str, float] = Field(default_factory=dict)
    # Cleanup pipeline (parallels ProcessVoiceRequest). Default off so an edit
    # only changes what the user explicitly turns on.
    isolate: bool = False
    trim: bool = False
    normalize: bool = False
    dereverb: bool = False
    dereverb_method: str = "roformer"
    gain_db: float = 0.0
    speed: float = 1.0
    trim_start: float = 0.0
    trim_end: float = 0.0
    overwrite: bool = False  # replace the source sound in place
    save_as: Optional[str] = None  # destination rel path when saving a copy


class LoadModelRequest(BaseModel):
    model_id: Optional[str] = None
    load_on_demand: Optional[bool] = None
