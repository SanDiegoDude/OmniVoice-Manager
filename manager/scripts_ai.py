"""Smart script generation via an OpenAI-compatible API (Gemini by default).

Turns a freeform user prompt into a clean, speaker-tagged dialogue script plus a
title. Designed to be callable from both the UI and the public API so a ComfyUI
connector can drive the full smart-script pipeline (not just raw TTS).
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional

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
    "You write a natural multi-speaker conversation for a text-to-speech engine. "
    "Every line MUST begin with a speaker label in the exact form 'Speaker 1:', "
    "'Speaker 2:', up to 'Speaker {n}:'. Use exactly {n} speakers, numbered from 1 "
    "(never 'Speaker 0'). Put each speaker's turn on its own line and never place two "
    "speakers on one line. The 'Speaker N:' labels are control markers that are removed "
    "before synthesis; everything after the label is spoken."
)

_COMMON_RULES = (
    " Write words exactly as they should be spoken. The user prompt is paramount and "
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


def _build_system(num_speakers: int, speakers: Optional[List[Dict[str, Any]]]) -> str:
    if num_speakers <= 1:
        base = _MONOLOGUE_RULES
    else:
        base = _DIALOGUE_RULES.format(n=num_speakers)
    base += _COMMON_RULES

    if speakers:
        descs = []
        for i, spk in enumerate(speakers):
            label = spk.get("name") or spk.get("instruct") or spk.get("voice")
            if not label:
                continue
            if num_speakers <= 1:
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


def _chat_create(client, model: str, messages: list, max_tokens: int, temperature: float):
    """Call chat.completions.create, adapting to per-model parameter quirks.

    Different providers reject different optional params (legacy 'max_tokens' vs
    'max_completion_tokens', non-default temperature/top_p, or 'response_format').
    We start with our preferred set and strip/swap unsupported params on 400s,
    retrying until the call succeeds."""
    kwargs: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "top_p": 0.9,
        "temperature": temperature,
        # Force well-formed JSON when the provider supports it (dropped below if not).
        "response_format": {"type": "json_object"},
    }
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
) -> Dict[str, Any]:
    provider = _resolve(provider_id)
    client = _client(provider)
    system_message = _build_system(num_speakers, speakers)
    user_message = _build_user(prompt, existing_script, previous)
    model = provider["model"]
    messages = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": user_message},
    ]

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
            resp = _chat_create(client, model, messages, cur_tokens, temperature)
            choice = resp.choices[0] if resp.choices else None
            content = (getattr(getattr(choice, "message", None), "content", None) or "") if choice else ""
            finish = getattr(choice, "finish_reason", None)
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
