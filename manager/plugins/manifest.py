"""Parse and validate a plug-in's ``plugin.json`` manifest.

JSON (not TOML) keeps the host dependency-free on Python 3.10, which has no
stdlib ``tomllib``. A manifest describes everything the host needs to run a
plug-in without importing any of its code:

```jsonc
{
  "id": "stable-audio-3",
  "name": "Stable Audio 3",
  "version": "0.1.0",
  "description": "Text-to-audio foley / SFX / music generation.",
  "author": "...",
  "homepage": "https://github.com/Stability-AI/stable-audio-3",
  "isolation": "sidecar",          // "sidecar" (own venv) | "inprocess"
  "entrypoint": "sidecar.py",       // run with the plug-in's python
  "python": ".venv/bin/python",     // venv interpreter, relative to plug-in dir
  "gpu": true,                       // touches the GPU (host frees TTS first)
  "vram_mb": 6500,                   // peak VRAM estimate (informational + LOD)
  "supports_low_vram": true,         // honors a low_vram payload flag
  "supports_cpu_offload": false,
  "capabilities": ["generate"],     // commands the host may invoke
  "needs": { "model": "stabilityai/stable-audio-3-medium" }
}
```
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class PluginManifest:
    id: str
    name: str
    root: Path
    version: str = "0.0.0"
    description: str = ""
    author: str = ""
    homepage: str = ""
    source: str = ""   # the plug-in's own repo (for install/update + provenance)
    license: str = ""  # plug-in license, often distinct from the host's
    isolation: str = "sidecar"
    entrypoint: str = "sidecar.py"
    python: str = ".venv/bin/python"
    gpu: bool = False
    vram_mb: Optional[int] = None
    supports_low_vram: bool = False
    supports_cpu_offload: bool = False
    capabilities: List[str] = field(default_factory=list)
    needs: Dict[str, Any] = field(default_factory=dict)
    ui: Dict[str, Any] = field(default_factory=dict)
    # Plug-in class: "tool" (default — has a UI / creative flow, shown in the
    # library launcher) or "service" (headless — no modal/button; exists only to
    # be brokered by the host via a capability). ``provides`` advertises the
    # capability names a service offers; ``consumes`` declares which capabilities
    # a plug-in expects to call (so the host can gate cross-plug-in use and the
    # installer can warn on a missing dependency).
    kind: str = "tool"
    provides: List[str] = field(default_factory=list)
    consumes: List[str] = field(default_factory=list)
    # First-party plug-in that ships with the host (tracked in the core repo,
    # bootstrapped as part of setup) rather than a third-party drop-in. Used to
    # badge it in the UI and to skip it from third-party update flows.
    official: bool = False

    @property
    def is_service(self) -> bool:
        return self.kind == "service"

    # ---- derived paths ----
    @property
    def entry_path(self) -> Path:
        return (self.root / self.entrypoint).resolve()

    def _venv_root(self) -> Path:
        """The venv directory implied by the declared ``python`` path (the part
        before ``bin/`` or ``Scripts/``)."""
        parts = Path(self.python).parts
        for marker in ("bin", "Scripts"):
            if marker in parts:
                return self.root.joinpath(*parts[: parts.index(marker)])
        return self.root / ".venv"

    @property
    def python_path(self) -> Path:
        # NB: do NOT resolve() — the venv interpreter is a symlink to the base
        # python, and following it defeats virtualenv site-packages detection
        # (pyvenv.cfg is found relative to the *unresolved* executable path).
        #
        # Manifests declare the POSIX path (".venv/bin/python"); translate to the
        # platform layout so one manifest works on Linux/macOS *and* Windows
        # (".venv\\Scripts\\python.exe"). Prefer the declared path if it exists.
        declared = self.root / self.python
        if declared.exists():
            return declared
        venv = self._venv_root()
        alt = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        return alt if alt.exists() else declared

    @property
    def installed(self) -> bool:
        """True once the isolated env exists (sidecar plug-ins). In-process
        plug-ins are always considered installed."""
        if self.isolation != "sidecar":
            return True
        return self.python_path.exists()

    def public(self) -> Dict[str, Any]:
        """Manifest view safe to expose over the API (no filesystem paths)."""
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "author": self.author,
            "homepage": self.homepage,
            "source": self.source,
            "license": self.license,
            "isolation": self.isolation,
            "gpu": self.gpu,
            "vram_mb": self.vram_mb,
            "supports_low_vram": self.supports_low_vram,
            "supports_cpu_offload": self.supports_cpu_offload,
            "capabilities": self.capabilities,
            "needs": self.needs,
            "ui": self.ui,
            "kind": self.kind,
            "provides": self.provides,
            "consumes": self.consumes,
            "official": self.official,
            "installed": self.installed,
        }


def load_manifest(plugin_dir: Path) -> Optional[PluginManifest]:
    """Load ``plugin_dir/plugin.json`` into a manifest, or None if absent/invalid."""
    mf = plugin_dir / "plugin.json"
    if not mf.exists():
        return None
    try:
        # Always UTF-8: manifests contain emoji/em-dash in UI labels, and the
        # platform default (cp1252 on Windows) would mojibake them in the UI.
        data = json.loads(mf.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    pid = str(data.get("id") or plugin_dir.name).strip()
    if not pid:
        return None
    known = {
        "version", "description", "author", "homepage", "source", "license",
        "isolation", "entrypoint", "python", "gpu", "vram_mb", "supports_low_vram",
        "supports_cpu_offload", "capabilities", "needs", "ui",
        "kind", "provides", "consumes", "official",
    }
    kwargs = {k: data[k] for k in known if k in data}
    return PluginManifest(
        id=pid,
        name=str(data.get("name") or pid),
        root=plugin_dir.resolve(),
        **kwargs,
    )
