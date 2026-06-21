"""OmniVoice external plug-in SDK (sidecar side).

This is the *only* module a plug-in sidecar needs to talk to the OmniVoice host.
It is intentionally **pure standard library** so it imports cleanly inside a
plug-in's own isolated virtualenv (which may pin a completely different torch /
CUDA / dependency set than the host). The host adds this directory to the
sidecar's ``PYTHONPATH`` via the ``OMNIVOICE_PLUGIN_SDK`` environment variable.

Protocol (newline-delimited JSON over stdio):

* The host sends requests on the sidecar's **stdin**, one JSON object per line::

      {"cmd": "<name>", "rid": "<id>", "payload": {...}}

  Built-in commands: ``health``, ``load``, ``unload``, ``shutdown``. Every other
  command is dispatched to the matching method on your plug-in object (so a
  ``generate`` cmd calls ``plugin.generate(ctx, **payload)``).

* The sidecar replies on **stdout**, one JSON object per line::

      {"type": "ready",    "data": {...}}              # once, at startup
      {"type": "progress", "rid": "<id>", "data": {...}}
      {"type": "result",   "rid": "<id>", "data": {...}}
      {"type": "error",    "rid": "<id>", "error": "..."}

  **stdout is reserved for protocol JSON only.** Use ``ctx.log(...)`` (or print
  to ``sys.stderr``) for human-readable logging — the host captures stderr to a
  per-plugin log file.

Host call-backs ("API hooks available to the plug-in") let a sidecar reach back
into the host while handling a command — e.g. rewrite a prompt with the host's
configured Script-AI model, save generated audio into the shared sound library,
or persist state onto the open project. See ``Context`` below.

Write a plug-in in three lines::

    from omnivoice_plugin import run

    class MyPlugin:
        def load(self, ctx): ...
        def generate(self, ctx, **payload): return {"audio_path": ...}

    run(MyPlugin())
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import uuid
from typing import Any, Dict, Optional


class HostCallError(RuntimeError):
    """Raised when a host call-back (``ctx.host_call``) returns an error."""


class Context:
    """Handed to every plug-in handler. Bundles progress reporting, logging,
    temp-file allocation, and the host call-back hooks."""

    def __init__(self, plugin_id: str, tmp_dir: str, emit, host_call):
        self.plugin_id = plugin_id
        self.tmp_dir = tmp_dir
        self._emit = emit
        self._host_call = host_call
        self._rid: Optional[str] = None

    # ---- reporting ----
    def progress(self, **data: Any) -> None:
        """Emit an incremental progress event for the current command (surfaces
        in the job's progress polling on the host)."""
        self._emit("progress", {"rid": self._rid, "data": data})

    def log(self, message: str, level: str = "info") -> None:
        """Human-readable log line (goes to stderr → the plug-in's log file)."""
        print(f"[{level}] {message}", file=sys.stderr, flush=True)

    # ---- temp files ----
    def tmp_path(self, suffix: str = ".wav") -> str:
        """A unique path inside the host-provided per-plugin temp dir. The host
        owns cleanup of this directory."""
        os.makedirs(self.tmp_dir, exist_ok=True)
        return os.path.join(self.tmp_dir, f"{uuid.uuid4().hex}{suffix}")

    # ---- host call-backs (the plug-in API hooks) ----
    def host_call(self, method: str, **params: Any) -> Any:
        """Synchronously invoke a host-provided hook and return its result.

        Available methods (see docs/plugins.md):
          * ``reprompt(category, user_input, duration, ...)`` — rewrite a prompt
            using the host's configured Script-AI provider.
          * ``save_sound(rel_path, audio_path, sample_rate=None)`` — ingest a wav
            into the shared foley/SFX sound library; returns its descriptor.
          * ``set_project_data(session_id, data, merge=True)`` — persist arbitrary
            plug-in state onto a project (travels inside the .omvp bundle).
          * ``get_project_data(session_id)`` — read this plug-in's project state.
        """
        return self._host_call(method, params)


class _Runner:
    def __init__(self, plugin: Any):
        self.plugin = plugin
        self.plugin_id = os.environ.get("OMNIVOICE_PLUGIN_ID", "plugin")
        self.tmp_dir = os.environ.get(
            "OMNIVOICE_PLUGIN_TMP", os.path.join(os.getcwd(), ".plugin_tmp")
        )
        self._out = sys.stdout

    # ---- low-level IO ----
    def _emit(self, type_: str, fields: Dict[str, Any]) -> None:
        msg = {"type": type_, **fields}
        self._out.write(json.dumps(msg) + "\n")
        self._out.flush()

    def _host_call(self, method: str, params: Dict[str, Any]) -> Any:
        """Send a host_call and block until the matching host_response arrives.
        The host never interleaves new commands while a handler runs, so the only
        inbound traffic during this wait is our own response."""
        rid = uuid.uuid4().hex
        self._emit("host_call", {"rid": rid, "method": method, "params": params})
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "host_response" and msg.get("rid") == rid:
                if msg.get("error"):
                    raise HostCallError(str(msg["error"]))
                return msg.get("data")
        raise HostCallError("Host closed the connection during a host_call.")

    # ---- dispatch ----
    def _handle(self, ctx: Context, cmd: str, payload: Dict[str, Any]) -> Any:
        if cmd == "health":
            fn = getattr(self.plugin, "health", None)
            return fn(ctx) if callable(fn) else {"ok": True}
        if cmd == "load":
            fn = getattr(self.plugin, "load", None)
            if callable(fn):
                fn(ctx)
            return {"loaded": True}
        if cmd == "unload":
            fn = getattr(self.plugin, "unload", None)
            if callable(fn):
                fn(ctx)
            return {"loaded": False}
        fn = getattr(self.plugin, cmd, None)
        if not callable(fn):
            raise AttributeError(f"Plug-in has no handler for command '{cmd}'.")
        return fn(ctx, **(payload or {}))

    def run(self) -> None:
        ctx = Context(self.plugin_id, self.tmp_dir, self._emit, self._host_call)
        # Announce readiness + declared capabilities (every public method).
        caps = [
            name
            for name in dir(self.plugin)
            if not name.startswith("_") and callable(getattr(self.plugin, name))
        ]
        self._emit("ready", {"data": {"plugin_id": self.plugin_id, "capabilities": caps}})

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            cmd = msg.get("cmd")
            rid = msg.get("rid")
            if cmd == "shutdown":
                break
            ctx._rid = rid
            try:
                result = self._handle(ctx, cmd, msg.get("payload") or {})
                self._emit("result", {"rid": rid, "data": result})
            except Exception as e:  # noqa: BLE001
                self._emit(
                    "error",
                    {"rid": rid, "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}"},
                )
            finally:
                ctx._rid = None


def run(plugin: Any) -> None:
    """Start the sidecar event loop for ``plugin`` and block until shutdown."""
    _Runner(plugin).run()
