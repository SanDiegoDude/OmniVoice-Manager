"""Plug-in host: discovery, sidecar lifecycle, GPU serialization, host hooks.

A *sidecar* plug-in runs as a subprocess launched with its own virtualenv's
python, talking newline-delimited JSON over stdio (see ``plugins/_sdk``). The
host:

* discovers plug-ins under the repo ``plugins/`` dir,
* spawns/keeps/tears down sidecars (LOD tears them down after each GPU job),
* **serializes the GPU**: before any GPU plug-in job it frees the main TTS
  worker, so a plug-in never shares VRAM with the core model — the same peak-VRAM
  discipline the worker already uses for its secondary models, extended to
  plug-ins so the home-GPU crowd never OOMs,
* services **host call-backs** so a sidecar can reach back into the app
  (reprompt via Script-AI, save into the sound library, persist project data).
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .manifest import PluginManifest, current_platform, load_manifest

ProgressCb = Optional[Callable[[Dict[str, Any]], None]]
# A host hook: (plugin_id, params) -> json-serializable result.
HostHook = Callable[[str, Dict[str, Any]], Any]

_SDK_DIR = (Path(__file__).resolve().parents[2] / "plugins" / "_sdk")

_WEIGHT_EXTS = (".safetensors", ".ckpt", ".bin", ".pt", ".pth", ".gguf", ".onnx")


def _hf_cache_dirs() -> List[Path]:
    """Candidate Hugging Face hub cache roots, honoring the same env the sidecars
    inherit from us (sidecars are spawned with our ``os.environ``)."""
    dirs: List[Path] = []
    for var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        v = os.environ.get(var)
        if v:
            dirs.append(Path(v))
    home = os.environ.get("HF_HOME")
    if home:
        dirs.append(Path(home) / "hub")
    dirs.append(Path.home() / ".cache" / "huggingface" / "hub")
    # de-dup while preserving order
    seen: set[str] = set()
    out: List[Path] = []
    for d in dirs:
        key = str(d)
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def model_in_hf_cache(repo_id: str) -> bool:
    """True when ``repo_id`` is fully present in a local HF hub cache — i.e. at
    least one weight file is downloaded (its blob resolves), not just a stub or a
    half-finished ``.incomplete`` transfer. Pure filesystem inspection: no model
    load, no network, no sidecar spawn, so it's cheap enough to call per
    ``/api/plugins`` poll."""
    if not repo_id:
        return False
    folder = "models--" + str(repo_id).replace("/", "--")
    for base in _hf_cache_dirs():
        snaps = base / folder / "snapshots"
        if not snaps.is_dir():
            continue
        try:
            snap_iter = list(snaps.iterdir())
        except OSError:
            continue
        for snap in snap_iter:
            if not snap.is_dir():
                continue
            try:
                for f in snap.rglob("*"):
                    name = f.name
                    if name.endswith(".incomplete") or not name.endswith(_WEIGHT_EXTS):
                        continue
                    try:
                        # follows the symlink into blobs/ — True only if downloaded
                        if f.exists():
                            return True
                    except OSError:
                        continue
            except OSError:
                continue
    return False


class PluginError(RuntimeError):
    pass


class _Sidecar:
    """One running sidecar subprocess for a plug-in."""

    def __init__(self, manifest: PluginManifest, sdk_dir: Path, tmp_dir: Path, log_path: Path):
        self.manifest = manifest
        self._sdk_dir = sdk_dir
        self._tmp_dir = tmp_dir
        self._log_path = log_path
        self._proc: Optional[subprocess.Popen] = None
        self._log_fh = None
        self.capabilities: List[str] = list(manifest.capabilities)

    def start(self, ready_timeout_s: float = 60.0) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        m = self.manifest
        if not m.python_path.exists():
            raise PluginError(
                f"Plug-in '{m.id}' is not installed (missing {m.python_path}). "
                f"Run its bootstrap/install first."
            )
        if not m.entry_path.exists():
            raise PluginError(f"Plug-in '{m.id}' entrypoint not found: {m.entry_path}")

        self._tmp_dir.mkdir(parents=True, exist_ok=True)
        self._log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_fh = open(self._log_path, "a", buffering=1)

        # Isolated environment: the venv's own site-packages are always on the
        # child's path; we only add the pure-stdlib SDK dir, and deliberately do
        # NOT leak the host's PYTHONPATH/VIRTUAL_ENV into the child.
        env = dict(os.environ)
        env.pop("VIRTUAL_ENV", None)
        env.pop("PYTHONHOME", None)
        env["PYTHONPATH"] = str(self._sdk_dir)
        env["OMNIVOICE_PLUGIN_SDK"] = str(self._sdk_dir)
        env["OMNIVOICE_PLUGIN_ID"] = m.id
        env["OMNIVOICE_PLUGIN_TMP"] = str(self._tmp_dir)
        env["PYTHONUNBUFFERED"] = "1"

        self._proc = subprocess.Popen(
            [str(m.python_path), str(m.entry_path)],
            cwd=str(m.root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._log_fh,
            text=True,
            bufsize=1,
            env=env,
        )

        # Bound the handshake so a broken plug-in can't hang the server thread.
        killer = threading.Timer(ready_timeout_s, self._kill)
        killer.start()
        try:
            msg = self._read_msg()
        finally:
            killer.cancel()
        if not msg or msg.get("type") != "ready":
            self.stop()
            raise PluginError(
                f"Plug-in '{m.id}' failed to start (see {self._log_path})."
            )
        caps = (msg.get("data") or {}).get("capabilities")
        if caps:
            self.capabilities = caps

    def _kill(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.kill()

    def _read_msg(self) -> Optional[Dict[str, Any]]:
        assert self._proc and self._proc.stdout
        while True:
            line = self._proc.stdout.readline()
            if line == "":  # EOF — the sidecar exited
                return None
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue  # ignore stray non-protocol stdout

    def _write_msg(self, obj: Dict[str, Any]) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write(json.dumps(obj) + "\n")
        self._proc.stdin.flush()

    def request(
        self,
        cmd: str,
        payload: Dict[str, Any],
        progress_cb: ProgressCb,
        host_hooks: Dict[str, HostHook],
        plugin_id: str,
    ) -> Dict[str, Any]:
        import uuid

        rid = uuid.uuid4().hex
        self._write_msg({"cmd": cmd, "rid": rid, "payload": payload})
        while True:
            msg = self._read_msg()
            if msg is None:
                raise PluginError(
                    f"Plug-in '{self.manifest.id}' crashed during '{cmd}' "
                    f"(see {self._log_path})."
                )
            mtype = msg.get("type")
            if mtype == "progress" and msg.get("rid") == rid:
                if progress_cb:
                    progress_cb(msg.get("data") or {})
                continue
            if mtype == "host_call":
                self._service_host_call(msg, host_hooks, plugin_id)
                continue
            if msg.get("rid") != rid:
                continue
            if mtype == "result":
                return msg.get("data") or {}
            if mtype == "error":
                raise PluginError(msg.get("error") or "Unknown plug-in error.")

    def _service_host_call(
        self, msg: Dict[str, Any], host_hooks: Dict[str, HostHook], plugin_id: str
    ) -> None:
        rid = msg.get("rid")
        method = msg.get("method")
        params = msg.get("params") or {}
        hook = host_hooks.get(method)
        try:
            if hook is None:
                raise PluginError(f"No host hook named '{method}'.")
            data = hook(plugin_id, params)
            self._write_msg({"type": "host_response", "rid": rid, "data": data})
        except Exception as e:  # noqa: BLE001
            self._write_msg({"type": "host_response", "rid": rid, "error": f"{type(e).__name__}: {e}"})

    def health(self, host_hooks: Dict[str, HostHook], plugin_id: str) -> Dict[str, Any]:
        return self.request("health", {}, None, host_hooks, plugin_id)

    def stop(self) -> None:
        p = self._proc
        if p is not None:
            try:
                if p.poll() is None:
                    self._write_msg({"cmd": "shutdown"})
                    try:
                        p.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        p.terminate()
                        try:
                            p.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            p.kill()
            except Exception:  # noqa: BLE001
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
        self._proc = None
        if self._log_fh is not None:
            try:
                self._log_fh.close()
            except Exception:  # noqa: BLE001
                pass
            self._log_fh = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None


class PluginHost:
    def __init__(
        self,
        plugins_dir: Path,
        tmp_root: Path,
        log_root: Path,
        host_hooks: Optional[Dict[str, HostHook]] = None,
        is_lod: Optional[Callable[[], bool]] = None,
        free_host_gpu: Optional[Callable[[], None]] = None,
    ):
        self.plugins_dir = Path(plugins_dir)
        self.tmp_root = Path(tmp_root)
        self.log_root = Path(log_root)
        self._host_hooks = dict(host_hooks or {})
        self._is_lod = is_lod or (lambda: False)
        self._free_host_gpu = free_host_gpu
        self._manifests: Dict[str, PluginManifest] = {}
        self._sidecars: Dict[str, _Sidecar] = {}
        self._lock = threading.Lock()
        # ---- service lane ----
        # Service (headless, CPU) plug-ins run OUTSIDE the GPU-serialization lock
        # so enrichment never disturbs a resident GPU plug-in or the creative
        # flow. They live in their own sidecar dict, are kept warm, and are
        # serialized among themselves by `_svc_lock`. `_providers` maps a
        # capability name → the plug-in that provides it. `_svc_local` is a
        # thread-local re-entrancy/cycle guard: v1 is depth-1 (a service can be
        # called, but can't itself call a capability), which also makes cycles
        # impossible without touching the GPU lock.
        self._providers: Dict[str, str] = {}
        self._svc_sidecars: Dict[str, _Sidecar] = {}
        self._svc_lock = threading.Lock()
        self._svc_local = threading.local()
        # Built-in host hook: let core or a plug-in request a capability and have
        # the host broker it to the registered provider (never peer-to-peer).
        self._host_hooks.setdefault("invoke_capability", self._hook_invoke_capability)
        # Single-instance enforcement: a plug-in may only have ONE task in flight
        # at a time (one process, one job). `_active` tracks plug-ins currently
        # running a command; it's guarded by the fast `_active_lock` so a second
        # invocation can be rejected up-front instead of silently queueing behind
        # a long generation on the big `_lock`.
        self._active: set[str] = set()
        self._active_lock = threading.Lock()
        self.discover()
        # A previous manager that was SIGKILL'd (e.g. `run_manager --forceup`)
        # can't run its atexit shutdown, orphaning sidecars that keep holding
        # GPU VRAM forever. Reap any strays from prior runs before we start.
        self._reap_orphan_sidecars()

    # ---- discovery ----
    def discover(self) -> None:
        found: Dict[str, PluginManifest] = {}
        if self.plugins_dir.exists():
            for child in sorted(self.plugins_dir.iterdir()):
                if not child.is_dir() or child.name.startswith((".", "_")):
                    continue
                m = load_manifest(child)
                if m is not None:
                    found[m.id] = m
        self._manifests = found
        # Capability registry: capability name → provider plug-in id. Service
        # plug-ins win over tools when both advertise the same capability; within
        # a class, first by sorted id (deterministic). A provider must list the
        # capability in BOTH `provides` (the contract) and `capabilities` (the
        # invokable command) — the command name equals the capability name.
        providers: Dict[str, str] = {}
        for m in sorted(found.values(), key=lambda x: (not x.is_service, x.id)):
            for cap in m.provides:
                if cap in m.capabilities and cap not in providers:
                    providers[cap] = m.id
        self._providers = providers

    def _reap_orphan_sidecars(self) -> None:
        """Kill leftover sidecar processes from a prior manager instance.

        Identified by their exact entrypoint path in the process cmdline — only
        our own plug-in sidecars match, and at startup none are ours yet, so any
        match is an orphan still pinning VRAM. Linux-only (uses /proc); a no-op
        elsewhere."""
        if os.name != "posix":
            return
        proc_root = Path("/proc")
        if not proc_root.exists():
            return
        import signal

        entries = []
        for m in self._manifests.values():
            try:
                entries.append(str(m.entry_path))
            except Exception:  # noqa: BLE001
                continue
        if not entries:
            return
        me = os.getpid()
        for pdir in proc_root.iterdir():
            if not pdir.name.isdigit():
                continue
            pid = int(pdir.name)
            if pid == me:
                continue
            try:
                raw = (pdir / "cmdline").read_bytes()
            except (OSError, ValueError):
                continue
            cmd = raw.replace(b"\x00", b" ").decode("utf-8", "ignore")
            if any(e in cmd for e in entries):
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass

    @staticmethod
    def _model_present(m: PluginManifest) -> Optional[bool]:
        """Whether the plug-in's declared HF model is downloaded locally, or None
        when the plug-in doesn't declare one (nothing to gate on)."""
        repo = (m.needs or {}).get("model")
        if not repo:
            return None
        return model_in_hf_cache(str(repo))

    def list(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for m in self._manifests.values():
            d = m.public()
            d["model_present"] = self._model_present(m)
            out.append(d)
        return out

    def get(self, plugin_id: str) -> PluginManifest:
        m = self._manifests.get(plugin_id)
        if m is None:
            raise PluginError(f"Unknown plug-in: {plugin_id}")
        return m

    # ---- lifecycle ----
    def _ensure_sidecar(self, m: PluginManifest) -> _Sidecar:
        sc = self._sidecars.get(m.id)
        if sc is not None and sc.alive:
            return sc
        sc = _Sidecar(
            m,
            sdk_dir=_SDK_DIR,
            tmp_dir=self.tmp_root / m.id,
            log_path=self.log_root / f"{m.id}.log",
        )
        sc.start()
        self._sidecars[m.id] = sc
        return sc

    def _stop_sidecar(self, plugin_id: str) -> None:
        sc = self._sidecars.pop(plugin_id, None)
        if sc is not None:
            sc.stop()

    def unload(self, plugin_id: Optional[str] = None) -> None:
        with self._lock:
            if plugin_id is None:
                for pid in list(self._sidecars):
                    self._stop_sidecar(pid)
            else:
                self._stop_sidecar(plugin_id)
        # Service sidecars live in their own lane / lock.
        with self._svc_lock:
            if plugin_id is None:
                for pid in list(self._svc_sidecars):
                    sc = self._svc_sidecars.pop(pid, None)
                    if sc is not None:
                        sc.stop()
            else:
                sc = self._svc_sidecars.pop(plugin_id, None)
                if sc is not None:
                    sc.stop()

    def free_gpu(self) -> None:
        """Release VRAM held by GPU plug-in sidecars — the symmetric counterpart
        to ``free_host_gpu``. The TTS worker calls this before it (re)acquires the
        GPU so a resident plug-in (e.g. a warm SA3 sidecar) never coexists with
        the core model. Tearing the sidecar down fully reclaims its VRAM (a warm
        sidecar respawns on the next plug-in job — same one-model-at-a-time
        discipline as the worker)."""
        with self._lock:
            for pid in list(self._sidecars):
                sc = self._sidecars.get(pid)
                if sc is not None and sc.manifest.gpu:
                    self._stop_sidecar(pid)

    def shutdown(self) -> None:
        self.unload()

    # ---- invocation ----
    def invoke(
        self,
        plugin_id: str,
        cmd: str,
        payload: Optional[Dict[str, Any]] = None,
        progress_cb: ProgressCb = None,
    ) -> Dict[str, Any]:
        """Run a single command on a plug-in, GPU-serialized against the host."""
        m = self.get(plugin_id)
        if cmd not in (m.capabilities + ["health", "load", "unload"]):
            raise PluginError(f"Plug-in '{plugin_id}' does not support '{cmd}'.")
        if not m.installed:
            raise PluginError(
                f"Plug-in '{plugin_id}' is not installed yet. Run its bootstrap script."
            )
        # Single-instance gate (cheap, non-blocking): refuse a second concurrent
        # task for the same plug-in rather than queueing it behind the first on the
        # big lock. Health/load/unload are bookkeeping and exempt. The atomic
        # check-and-add closes the race where two requests both see it idle.
        gate = cmd not in ("health", "load", "unload")
        if gate:
            with self._active_lock:
                if plugin_id in self._active:
                    raise PluginError(
                        f"'{m.name}' is already running a task — a plug-in only runs "
                        f"one instance at a time. Wait for it to finish."
                    )
                self._active.add(plugin_id)
        try:
            with self._lock:
                # GPU discipline: free the main TTS worker before a GPU plug-in job so
                # the two never share VRAM (critical for low-VRAM / consumer GPUs).
                if m.gpu and self._free_host_gpu is not None:
                    try:
                        self._free_host_gpu()
                    except Exception:  # noqa: BLE001
                        pass
                sc = self._ensure_sidecar(m)
                try:
                    return sc.request(cmd, payload or {}, progress_cb, self._host_hooks, plugin_id)
                finally:
                    # LOD: tear the sidecar down after a GPU job to reclaim all VRAM,
                    # exactly like the TTS worker under --lod.
                    if m.gpu and self._is_lod():
                        self._stop_sidecar(plugin_id)
        finally:
            if gate:
                with self._active_lock:
                    self._active.discard(plugin_id)

    # ---- capability brokering (service lane) ----
    def resolve_capability(self, capability: str) -> Optional[str]:
        """The plug-in id registered to provide ``capability``, or None."""
        return self._providers.get(capability)

    def _ensure_svc_sidecar(self, m: PluginManifest) -> _Sidecar:
        sc = self._svc_sidecars.get(m.id)
        if sc is not None and sc.alive:
            return sc
        sc = _Sidecar(
            m,
            sdk_dir=_SDK_DIR,
            tmp_dir=self.tmp_root / m.id,
            log_path=self.log_root / f"{m.id}.log",
        )
        sc.start()
        self._svc_sidecars[m.id] = sc
        return sc

    def call_capability(
        self,
        capability: str,
        payload: Optional[Dict[str, Any]] = None,
        progress_cb: ProgressCb = None,
    ) -> Dict[str, Any]:
        """Broker a capability to its registered provider — usable by core code
        and (via the ``invoke_capability`` hook) by other plug-ins.

        Runs in the **service lane**: it does NOT take the GPU-serialization lock
        and does NOT free the host GPU, so a CPU service (e.g. the Essentia
        analyzer) can run concurrently with a resident GPU plug-in. v1 constraints
        keep this provably safe: the provider must be a non-GPU plug-in, and calls
        cannot nest (depth-1) — which also rules out cycles."""
        provider_id = self._providers.get(capability)
        if not provider_id:
            raise PluginError(f"No plug-in provides capability '{capability}'.")
        m = self.get(provider_id)
        if not m.supported_here:
            osn, arch = current_platform()
            raise PluginError(
                f"'{m.name}' isn't available on this platform ({osn}-{arch}); "
                f"'{capability}' is unsupported here."
            )
        if not m.installed:
            raise PluginError(
                f"Provider '{m.name}' for '{capability}' is not installed. Run its bootstrap script."
            )
        if m.gpu:
            # v1: GPU providers would need the GPU mutex (model churn). Deferred —
            # GPU analyzers belong in ingest/idle enrichment, not this live lane.
            raise PluginError(
                f"Capability '{capability}' is provided by a GPU plug-in; live brokering is CPU-only in v1."
            )
        if getattr(self._svc_local, "active", False):
            raise PluginError(
                "Capability calls cannot nest (v1 is depth-1): a service plug-in "
                "may be called but cannot itself call a capability."
            )
        with self._svc_lock:
            self._svc_local.active = True
            try:
                sc = self._ensure_svc_sidecar(m)
                return sc.request(capability, payload or {}, progress_cb, self._host_hooks, provider_id)
            finally:
                self._svc_local.active = False

    def _hook_invoke_capability(self, caller_id: str, params: Dict[str, Any]) -> Any:
        """Host hook backing ``ctx.host_call('invoke_capability', capability=…,
        payload=…)`` so one plug-in can request another's capability, brokered by
        the host."""
        capability = str(params.get("capability") or "").strip()
        if not capability:
            raise PluginError("invoke_capability requires a 'capability' name.")
        return self.call_capability(capability, params.get("payload") or {})

    def is_busy(self, plugin_id: str) -> bool:
        """True while the plug-in has a task in flight (single-instance gate)."""
        with self._active_lock:
            return plugin_id in self._active

    def info(self, plugin_id: str) -> Dict[str, Any]:
        m = self.get(plugin_id)
        sc = self._sidecars.get(plugin_id)
        return {
            **m.public(),
            "model_present": self._model_present(m),
            "running": bool(sc and sc.alive),
            "busy": self.is_busy(plugin_id),
        }
