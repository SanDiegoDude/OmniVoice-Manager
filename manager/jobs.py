"""Background job manager for generation (progress via polling)."""

from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional


class JobManager:
    def __init__(self) -> None:
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        # Single worker => generation jobs run one at a time.
        self._pool = ThreadPoolExecutor(max_workers=1)

    def submit(self, fn: Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]], meta: Optional[Dict[str, Any]] = None) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = {
                "id": job_id,
                "status": "queued",
                "progress": {},
                "result": None,
                "error": None,
                "created": time.time(),
                "meta": meta or {},
            }
        self._pool.submit(self._run, job_id, fn)
        return job_id

    def _run(self, job_id: str, fn: Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]) -> None:
        self._update(job_id, status="running")

        def progress_cb(data: Dict[str, Any]) -> None:
            self._update(job_id, progress=data)

        try:
            result = fn(progress_cb)
            self._update(job_id, status="done", result=result)
        except Exception as e:  # noqa: BLE001
            self._update(job_id, status="error", error=str(e))

    def _update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.update(fields)

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None
