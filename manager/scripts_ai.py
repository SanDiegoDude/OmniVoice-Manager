"""Smart script generation via an OpenAI-compatible API (Gemini by default).

Turns a freeform user prompt into a clean, speaker-tagged dialogue script plus a
title. Designed to be callable from both the UI and the public API so a ComfyUI
connector can drive the full smart-script pipeline (not just raw TTS).
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from typing import Optional as _Optional

from .config import active_provider, get_provider

# The exact non-verbal tags OmniVoice recognizes (anything else in brackets is
# spoken verbatim). Source: omnivoice/models/omnivoice.py `_NONVERBAL_PATTERN`.
_NONVERBAL_TAGS = (
    "[laughter], [sigh], [confirmation-en], [question-en], [question-ah], "
    "[question-oh], [question-ei], [question-yi], [surprise-ah], [surprise-oh], "
    "[surprise-wa], [surprise-yo], [dissatisfaction-hnn]"
)

_MONOLOGUE_RULES = (
    "You write a natural spoken MONOLOGUE for a single voice in a text-to-speech engine. "
    "Output plain spoken sentences only. Do NOT add any speaker label or name prefix "
    "(no 'Speaker 1:', no character-name colons): every character you write is spoken "
    "aloud, so a label would be read out by the voice."
)

_DIALOGUE_RULES = (
    "You write a natural, speaker-labelled script for a text-to-speech engine. "
    "Every line MUST begin with a speaker label in the exact form 'Speaker 1:', "
    "'Speaker 2:', up to 'Speaker {n}:'. Use exactly {n} speaker(s), numbered from 1 "
    "(never 'Speaker 0'). Put each speaker's turn on its own line and never place two "
    "speakers on one line. The 'Speaker N:' labels are control markers that are removed "
    "before synthesis; everything after the label is spoken."
)

# With single speaker, keep the labelled format but ask for connected delivery
# (one person speaking) rather than a back-and-forth conversation.
_DIALOGUE_SOLO_NOTE = (
    " There is only one speaker: label every line 'Speaker 1:' and write it as one "
    "person speaking continuously, not a conversation with themselves."
)

# Round-robin turn order (1,2,3,4,1,2,3,4 …) is a strong failure mode for big
# casts, especially on smaller models. Demand organic, non-sequential turns.
_VARIETY_NOTE = (
    " IMPORTANT — vary the turn order: do NOT cycle through the speakers in numeric "
    "order (no predictable 1,2,3,4,5 round-robin). Real conversations jump around — "
    "let speakers interrupt, react out of order, hold back-and-forth exchanges between "
    "just two of them, and speak different amounts. Decide who speaks next by what the "
    "scene needs, not by their number, while still giving every speaker a real presence."
)

_COMMON_RULES = (
    " Write words exactly as they should be spoken. Write the way people actually talk: "
    "use natural contractions by default (can't, won't, don't, it's, I'm, you're, "
    "we'll, they're, that's) rather than stiff, formal full forms — UNLESS the user "
    "explicitly asks for a formal tone or for contractions to be avoided, in which case "
    "honor that. The user prompt is paramount and "
    "guides the entire scene; follow it creatively and do not censor satire of public "
    "figures or rough language if requested. Expand abbreviations to full words unless "
    "the acronym is normally spoken letter-by-letter (FBI, AI, NASA). "
    "You MAY add expressive non-verbal cues, but ONLY using these exact bracketed tags, "
    "placed inline where natural and used sparingly: " + _NONVERBAL_TAGS + ". "
    "Do NOT use any other bracketed text, stage directions, narration, emotion labels, "
    "sound effects, or action descriptions; any bracket that is not one of those listed "
    "tags will be read aloud verbatim. "
    "CRITICAL OUTPUT FORMAT: respond with VALID JSON only, containing two string fields "
    '"title" and "script", in the form {"title": "...", "script": "..."}. '
    "No prose, no markdown fences, nothing outside the JSON."
)


class ScriptAIError(RuntimeError):
    pass


def _resolve(provider_id: _Optional[str]):
    provider = get_provider(provider_id) if provider_id else active_provider()
    if not provider:
        raise ScriptAIError(
            "No AI provider is configured, so the AI script writer is unavailable "
            "(writing your script by hand works fine!). To enable it: copy "
            ".env_sample to .env, add an AI_PROVIDER_* line with your API key, "
            "then click the refresh button next to the provider picker."
        )
    return provider


def _client(provider: dict):
    try:
        from openai import OpenAI
    except ImportError as e:  # noqa: BLE001
        raise ScriptAIError("The 'openai' package is required for script generation.") from e

    base_url = provider.get("url") or ""
    api_key = provider.get("key") or ""

    if base_url:
        if "generativelanguage.googleapis.com" in base_url:
            base_url = base_url.rstrip("/")
        elif not base_url.endswith("/v1"):
            base_url = base_url.rstrip("/") + "/v1"
        return OpenAI(api_key=api_key or "", base_url=base_url)

    if not api_key:
        raise ScriptAIError(
            f"Provider '{provider.get('label')}' has no API key configured in .env."
        )
    return OpenAI(api_key=api_key)


def _build_system(
    num_speakers: int,
    speakers: Optional[List[Dict[str, Any]]],
    monologue: Optional[bool] = None,
) -> str:
    # Monologue is a Voice Clone–only format. When the caller doesn't say (older
    # API clients), fall back to the legacy "monologue iff a single speaker" rule.
    mono = (num_speakers <= 1) if monologue is None else bool(monologue)
    n = max(1, num_speakers)
    if mono:
        base = _MONOLOGUE_RULES
    else:
        base = _DIALOGUE_RULES.format(n=n)
        if n == 1:
            base += _DIALOGUE_SOLO_NOTE
        elif n >= 4:
            base += _VARIETY_NOTE
    base += _COMMON_RULES

    if speakers:
        descs = []
        for i, spk in enumerate(speakers):
            label = spk.get("name") or spk.get("instruct") or spk.get("voice")
            if not label:
                continue
            if mono:
                descs.append(f"the voice is {label}")
            else:
                descs.append(f"Speaker {i + 1} is {label}")
        if descs:
            base += (
                "\n\nCharacter guidance — capture their known mannerisms, vocal style and "
                "character where recognizable: " + "; ".join(descs) + "."
            )
    base += (
        "\n\nIf a 'Previous turn' section is included, treat it as context only and do not "
        "repeat it. If the user repeats the same request, produce a fresh remix."
    )
    return base


def _build_user(prompt: str, existing_script: str, previous: Optional[Dict[str, str]]) -> str:
    parts: List[str] = []
    if existing_script and existing_script.strip():
        parts.append(f"Current Conversation Script contents:\n{existing_script.strip()}")
    parts.append(f"User Input prompt:\n{(prompt or 'Generate an engaging scene.').strip()}")
    if previous:
        prev_bits = []
        if previous.get("script"):
            prev_bits.append(f"Previous Script: {previous['script'][:1200]}")
        if previous.get("prompt"):
            prev_bits.append(f"Previous User Input: {previous['prompt']}")
        if prev_bits:
            parts.append("Previous turn (for reference):\n" + "\n".join(prev_bits))
        if previous.get("prompt") and previous.get("prompt", "").strip() == (prompt or "").strip():
            parts.append("Remix request: produce a varied alternative, not a verbatim repeat.")
    return "\n\n".join(parts)


_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f"}


def _extract_json_string_field(text: str, field: str) -> Optional[str]:
    """Pull a JSON string value out of (possibly truncated/invalid) text.

    Reads the value of "field": "..." character-by-character, honoring escapes,
    and stops at the closing quote OR the end of the string. This lets us
    recover the script from a response that was cut off mid-string (the model
    hit its token cap) instead of failing to parse entirely."""
    m = re.search(r'"' + re.escape(field) + r'"\s*:\s*"', text)
    if not m:
        return None
    i = m.end()
    out: List[str] = []
    esc = False
    while i < len(text):
        c = text[i]
        if esc:
            if c == "u" and i + 4 < len(text):
                try:
                    out.append(chr(int(text[i + 1 : i + 5], 16)))
                    i += 5
                    esc = False
                    continue
                except ValueError:
                    out.append(c)
            else:
                out.append(_ESCAPES.get(c, c))
            esc = False
        elif c == "\\":
            esc = True
        elif c == '"':
            break
        else:
            out.append(c)
        i += 1
    return "".join(out)


def _parse_response(text: str) -> Dict[str, str]:
    """Extract {title, script} from a (possibly messy/truncated) model response."""
    if not text or not text.strip():
        raise ScriptAIError("Empty response from script AI.")
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned).strip()

    # 1) Strict JSON: direct, then the first {...} block.
    candidates = [cleaned]
    brace = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if brace:
        candidates.append(brace.group(0))
    for cand in candidates:
        try:
            data = json.loads(cand)
            if isinstance(data, dict) and "script" in data:
                return {
                    "title": str(data.get("title") or "Untitled Scene").strip(),
                    "script": str(data["script"]).strip(),
                }
        except (json.JSONDecodeError, TypeError):
            continue

    # 2) Salvage from truncated/invalid JSON: grab the script (and title) string
    #    values even when the closing quote/brace is missing.
    script = _extract_json_string_field(cleaned, "script")
    if script and script.strip():
        title = (_extract_json_string_field(cleaned, "title") or "").strip()
        return {"title": title or "Untitled Scene", "script": script.strip()}

    # 3) A JSON-looking wrapper we couldn't salvage — don't dump raw braces.
    if cleaned.lstrip().startswith("{"):
        raise ScriptAIError("Could not parse a script from the model's JSON response.")

    # 4) Plain text (model ignored the JSON instruction) — treat it as the script.
    return {"title": "Untitled Scene", "script": cleaned}


def _uses_completion_tokens(model: str) -> bool:
    """Newer OpenAI models (GPT-5 family, o-series reasoning) require
    'max_completion_tokens' and reject the legacy 'max_tokens'."""
    m = (model or "").lower()
    return m.startswith("gpt-5") or m.startswith("o1") or m.startswith("o3") or m.startswith("o4")


def _chat_create(client, model: str, messages: list, max_tokens: int, temperature: float, json_mode: bool = True):
    """Call chat.completions.create, adapting to per-model parameter quirks.

    Different providers reject different optional params (legacy 'max_tokens' vs
    'max_completion_tokens', non-default temperature/top_p, or 'response_format').
    We start with our preferred set and strip/swap unsupported params on 400s,
    retrying until the call succeeds. ``json_mode`` requests a JSON object back
    (used by the script writer); plain-text callers (e.g. prompt rewriting) pass
    False."""
    kwargs: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "top_p": 0.9,
        "temperature": temperature,
    }
    if json_mode:
        # Force well-formed JSON when the provider supports it (dropped below if not).
        kwargs["response_format"] = {"type": "json_object"}
    if _uses_completion_tokens(model):
        kwargs["max_completion_tokens"] = max_tokens
    else:
        kwargs["max_tokens"] = max_tokens

    for _ in range(6):  # bounded param-adaptation loop
        try:
            return client.chat.completions.create(**kwargs)
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            changed = False
            if "response_format" in msg and "response_format" in kwargs:
                kwargs.pop("response_format")
                changed = True
            elif "unsupported" in msg or "not supported" in msg or "unrecognized" in msg or "invalid" in msg:
                if "max_completion_tokens" in msg and "max_tokens" in kwargs:
                    kwargs["max_completion_tokens"] = kwargs.pop("max_tokens")
                    changed = True
                elif "max_completion_tokens" in kwargs and "max_completion_tokens" in msg:
                    kwargs["max_tokens"] = kwargs.pop("max_completion_tokens")
                    changed = True
                else:
                    for param in ("temperature", "top_p", "response_format"):
                        if param in msg and param in kwargs:
                            kwargs.pop(param)
                            changed = True
            if not changed:
                raise
    return client.chat.completions.create(**kwargs)


def _openai_complete(
    provider: dict, system_message: str, user_message: str, max_tokens: int, temperature: float, json_mode: bool = True
) -> Tuple[str, Optional[str]]:
    """Run one completion against an OpenAI-compatible endpoint."""
    client = _client(provider)
    messages = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": user_message},
    ]
    resp = _chat_create(client, provider["model"], messages, max_tokens, temperature, json_mode=json_mode)
    choice = resp.choices[0] if resp.choices else None
    content = (getattr(getattr(choice, "message", None), "content", None) or "") if choice else ""
    finish = getattr(choice, "finish_reason", None)
    return content, finish


def _vertex_complete(
    provider: dict, system_message: str, user_message: str, max_tokens: int, temperature: float, json_mode: bool = True
) -> Tuple[str, Optional[str]]:
    """Run one completion against Google Vertex AI (Gemini) via the google-genai
    SDK. Auth is Application Default Credentials, or a service-account JSON when
    the provider's key field points at one. The actual generate_content call is
    left to raise normally so the caller's retry/grow-budget loop can handle
    transient errors and truncation just like the OpenAI path."""
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:  # noqa: BLE001
        raise ScriptAIError(
            "The 'google-genai' package is required for Vertex AI script generation. "
            "Run `uv sync` (or pip install google-genai) and try again."
        ) from e

    project = (provider.get("project") or "").strip()
    location = (provider.get("location") or "global").strip() or "global"
    if not project:
        raise ScriptAIError(
            "Vertex provider is missing a Google Cloud project — set it via "
            "vertex://PROJECT/LOCATION in the provider line or GOOGLE_CLOUD_PROJECT in .env."
        )

    # Optional service-account credentials file (otherwise Application Default
    # Credentials — e.g. `gcloud auth application-default login` — are used).
    key = (provider.get("key") or "").strip()
    if key and os.path.isfile(key):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key

    client = genai.Client(vertexai=True, project=project, location=location)
    resp = client.models.generate_content(
        model=provider["model"],
        contents=user_message,
        config=types.GenerateContentConfig(
            system_instruction=system_message,
            temperature=temperature,
            top_p=0.9,
            max_output_tokens=max_tokens,
            response_mime_type="application/json" if json_mode else "text/plain",
        ),
    )

    content = getattr(resp, "text", None) or ""
    finish: Optional[str] = None
    cands = getattr(resp, "candidates", None) or []
    if cands:
        fr = getattr(cands[0], "finish_reason", None)
        name = (getattr(fr, "name", None) or str(fr or "")).upper()
        # Normalize the truncation signal so the caller's grow-budget retry fires.
        finish = "length" if name in ("MAX_TOKENS", "MAX_TOKEN") else name.lower() or None
    return content, finish


def _complete(
    provider: dict, system_message: str, user_message: str, max_tokens: int, temperature: float, json_mode: bool = True
) -> Tuple[str, Optional[str]]:
    """Dispatch one completion to the right backend, returning (content,
    finish_reason). finish_reason == 'length' means the output was truncated."""
    if provider.get("endpoint") == "vertex":
        return _vertex_complete(provider, system_message, user_message, max_tokens, temperature, json_mode=json_mode)
    return _openai_complete(provider, system_message, user_message, max_tokens, temperature, json_mode=json_mode)


def rewrite_prompt(
    system_message: str,
    user_message: str,
    temperature: float = 0.7,
    max_tokens: int = 400,
    provider_id: Optional[str] = None,
) -> str:
    """Single plain-text completion against the configured Script-AI provider.

    Used to turn a short user description into a detailed, model-ready prompt
    (e.g. the Stable Audio 3 plug-in's category-driven reprompt step). Reuses the
    same provider plumbing as the script writer but returns raw text, not JSON.
    Raises ``ScriptAIError`` when no provider is configured so callers can fall
    back to the user's raw text."""
    provider = _resolve(provider_id)
    content, _finish = _complete(
        provider, system_message, user_message, max(64, max_tokens), temperature, json_mode=False
    )
    text = (content or "").strip()
    # Strip accidental markdown fences / surrounding quotes some models add.
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    return text


# Token ceiling for the grow-on-truncation retry. Reasoning models (GPT-5 /
# Gemini flash) spend hidden reasoning tokens from this same budget, so we start
# generous and double up to this cap if the response is cut off.
_MAX_TOKEN_CAP = 32000


def generate_script(
    prompt: str,
    num_speakers: int = 2,
    speakers: Optional[List[Dict[str, Any]]] = None,
    existing_script: str = "",
    previous: Optional[Dict[str, str]] = None,
    temperature: float = 0.7,
    max_tokens: int = 16000,
    max_retries: int = 4,
    provider_id: Optional[str] = None,
    monologue: Optional[bool] = None,
) -> Dict[str, Any]:
    provider = _resolve(provider_id)
    system_message = _build_system(num_speakers, speakers, monologue)
    user_message = _build_user(prompt, existing_script, previous)
    model = provider["model"]

    def _result(parsed: Dict[str, str]) -> Dict[str, Any]:
        return {
            "title": parsed["title"],
            "script": parsed["script"],
            "model": model,
            "provider": provider["id"],
            "num_speakers": num_speakers,
        }

    last_err: Optional[Exception] = None
    best: Optional[Dict[str, str]] = None  # best partial we managed to salvage
    delay = 1.0
    cur_tokens = max(1024, max_tokens)
    for attempt in range(max_retries):
        try:
            content, finish = _complete(provider, system_message, user_message, cur_tokens, temperature)
        except ScriptAIError:
            raise
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(delay)
                delay *= 2
            continue

        # Truncated by the token cap (often reasoning overhead): keep any salvage,
        # then retry with a bigger budget before giving up.
        if finish == "length" and cur_tokens < _MAX_TOKEN_CAP:
            if content.strip():
                try:
                    best = _parse_response(content)
                except ScriptAIError:
                    pass
            cur_tokens = min(cur_tokens * 2, _MAX_TOKEN_CAP)
            last_err = ScriptAIError("Model output was truncated (finish_reason=length).")
            continue

        if not content.strip():
            last_err = ScriptAIError("Model returned an empty response.")
            continue

        return _result(_parse_response(content))

    # Exhausted retries — return the best partial script if we have one.
    if best is not None:
        return _result(best)
    raise ScriptAIError(f"Script AI request failed after {max_retries} attempts: {last_err}")
