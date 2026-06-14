"""Owns the GPU worker process and brokers requests to it.

- Persistent mode: the worker is spawned once and kept alive.
- LOD mode: the worker is terminated after every job to free all VRAM.

All public methods are serialized with a lock (one GPU job at a time).
"""

from __future__ import annotations

import atexit
import multiprocessing as mp
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional

from .config import Settings
from .worker import gpu_worker

ProgressCb = Optional[Callable[[Dict[str, Any]], None]]


def query_gpu_memory() -> Dict[str, Any]:
    """Return GPU memory usage without importing torch in the server process.

    NVIDIA boxes use nvidia-smi; Apple Silicon reports unified memory (the GPU
    shares system RAM, so process-wide RAM pressure is the meaningful number).
    """
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.total,name",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.DEVNULL,
            timeout=5,
        ).decode()
        line = out.strip().splitlines()[0]
        used, total, name = [p.strip() for p in line.split(",")]
        return {"used_mb": int(used), "total_mb": int(total), "name": name, "available": True}
    except Exception:  # noqa: BLE001
        pass
    if sys.platform == "darwin":
        try:
            total_b = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], timeout=5).decode().strip())
            chip = subprocess.check_output(
                ["sysctl", "-n", "machdep.cpu.brand_string"], timeout=5
            ).decode().strip()
            # Approximate "used" as active + wired + compressed pages.
            vm = subprocess.check_output(["vm_stat"], timeout=5).decode()
            page_size = 16384
            stats: Dict[str, int] = {}
            for ln in vm.splitlines():
                if ln.startswith("Mach Virtual Memory Statistics"):
                    if "page size of" in ln:
                        page_size = int(ln.split("page size of")[1].split("bytes")[0].strip())
                    continue
                if ":" in ln:
                    k, v = ln.split(":", 1)
                    stats[k.strip()] = int(v.strip().rstrip("."))
            used_pages = (
                stats.get("Pages active", 0)
                + stats.get("Pages wired down", 0)
                + stats.get("Pages occupied by compressor", 0)
            )
            return {
                "used_mb": used_pages * page_size // (1024 * 1024),
                "total_mb": total_b // (1024 * 1024),
                "name": f"{chip} (unified memory)",
                "available": True,
            }
        except Exception:  # noqa: BLE001
            pass
    return {"used_mb": None, "total_mb": None, "name": None, "available": False}


class ModelManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._ctx = mp.get_context("spawn")
        self._proc: Optional[mp.process.BaseProcess] = None
        self._req_q = None
        self._res_q = None
        self._lock = threading.Lock()
        self._loaded = False
        self._started_at: Optional[float] = None
        self._current_model = settings.model_id
        # Actual device/dtype the worker resolved (e.g. "auto" -> "mps").
        self._resolved_device: Optional[str] = None
        self._resolved_dtype: Optional[str] = None
        # Ensure the worker is torn down on graceful interpreter exit.
        atexit.register(self.shutdown_worker)

    # ---- lifecycle ----
    def _worker_cfg(self) -> Dict[str, Any]:
        return {
            "model_id": self._current_model,
            "device": self.settings.device,
            "dtype": self.settings.dtype,
            "load_asr": self.settings.load_asr,
            "asr_model": self.settings.asr_model,
            "debug": self.settings.debug,
        }

    def _ensure_started(self) -> None:
        if self._proc is not None and self._proc.is_alive():
            return
        self._req_q = self._ctx.Queue()
        self._res_q = self._ctx.Queue()
        self._proc = self._ctx.Process(
            target=gpu_worker,
            args=(self._req_q, self._res_q, self._worker_cfg()),
            daemon=True,
        )
        self._proc.start()
        # Wait for the worker's ready signal.
        kind, _rid, _payload = self._res_q.get()
        if kind != "ready":
            raise RuntimeError(f"Worker failed to start: {kind} {_payload}")
        if isinstance(_payload, dict):
            self._resolved_device = _payload.get("device") or self._resolved_device
            self._resolved_dtype = _payload.get("dtype") or self._resolved_dtype
        self._started_at = time.time()

    def shutdown_worker(self) -> None:
        if self._proc is not None and self._proc.is_alive():
            try:
                self._req_q.put({"cmd": "shutdown"})
                self._proc.join(timeout=8)
            except Exception:  # noqa: BLE001
                pass
            if self._proc.is_alive():
                self._proc.terminate()
                self._proc.join(timeout=5)
        self._proc = None
        self._req_q = None
        self._res_q = None
        self._loaded = False
        self._started_at = None

    def _request(self, cmd: str, payload: Dict[str, Any], progress_cb: ProgressCb = None, kill_after: bool = False) -> Dict[str, Any]:
        with self._lock:
            self._ensure_started()
            rid = uuid.uuid4().hex
            self._req_q.put({"cmd": cmd, "rid": rid, "payload": payload})
            try:
                while True:
                    kind, msg_rid, data = self._res_q.get()
                    if kind == "progress":
                        if progress_cb:
                            progress_cb(data)
                        continue
                    if msg_rid != rid:
                        continue
                    if kind == "result":
                        self._loaded = True
                        return data
                    if kind == "error":
                        raise RuntimeError(data)
            finally:
                if kill_after:
                    self.shutdown_worker()

    # ---- public API ----
    def warmup(self, progress_cb: ProgressCb = None) -> Dict[str, Any]:
        return self._request("warmup", {}, progress_cb=progress_cb, kill_after=False)

    def unload(self) -> None:
        with self._lock:
            self.shutdown_worker()

    def switch_model(self, model_id: str) -> None:
        with self._lock:
            self.shutdown_worker()
            self._current_model = model_id

    def generate(self, payload: Dict[str, Any], progress_cb: ProgressCb = None) -> Dict[str, Any]:
        return self._request(
            "generate", payload, progress_cb=progress_cb, kill_after=self.settings.load_on_demand
        )

    def isolate(self, payload: Dict[str, Any], progress_cb: ProgressCb = None) -> Dict[str, Any]:
        return self._request(
            "isolate", payload, progress_cb=progress_cb, kill_after=self.settings.load_on_demand
        )

    def dereverb(self, payload: Dict[str, Any], progress_cb: ProgressCb = None) -> Dict[str, Any]:
        return self._request(
            "dereverb", payload, progress_cb=progress_cb, kill_after=self.settings.load_on_demand
        )

    def transcribe(self, payload: Dict[str, Any], progress_cb: ProgressCb = None) -> Dict[str, Any]:
        return self._request(
            "transcribe", payload, progress_cb=progress_cb, kill_after=self.settings.load_on_demand
        )

    def info(self) -> Dict[str, Any]:
        alive = self._proc is not None and self._proc.is_alive()
        return {
            "model_id": self._current_model,
            "loaded": bool(alive and self._loaded),
            "worker_alive": alive,
            "load_on_demand": self.settings.load_on_demand,
            "low_vram": self.settings.low_vram,
            "trim_silence": self.settings.trim_silence,
            "output_format": self.settings.output_format,
            "device": self._resolved_device or self.settings.device,
            "dtype": self._resolved_dtype or self.settings.dtype,
            "uptime_s": round(time.time() - self._started_at, 1) if self._started_at else None,
            "gpu": query_gpu_memory(),
        }
