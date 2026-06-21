"""Install external plug-ins into the host's ``plugins/`` directory.

A plug-in is just a correctly-shaped folder (a ``plugin.json`` + entrypoint).
This module is a convenience path for the most common case: installing one
straight from a git URL — clone into ``plugins/<name>``, then optionally run its
bootstrap to build the isolated venv. A plain copy or a platform installer that
drops a correctly-shaped folder here works exactly the same; discovery doesn't
care how the files arrived.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .manifest import load_manifest

ProgressCb = Optional[Callable[[Dict[str, Any]], None]]

_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]")
_URL_RE = re.compile(r"^(https?://|git://|ssh://|git@)")


class InstallError(RuntimeError):
    pass


def _emit(progress: ProgressCb, **kw: Any) -> None:
    if progress:
        try:
            progress(kw)
        except Exception:  # noqa: BLE001
            pass


def _safe_folder(name: str) -> str:
    folder = _NAME_RE.sub("-", name).strip("-.")
    if not folder or folder == "_sdk":
        raise InstallError(f"Invalid plug-in folder name: {name!r}")
    return folder


def derive_name(git_url: str) -> str:
    """Folder name from a git URL: last path segment, sans ``.git``."""
    base = git_url.rstrip("/").split("/")[-1]
    if base.endswith(".git"):
        base = base[:-4]
    return _safe_folder(base)


def _bootstrap_command(dest: Path, mf) -> Optional[List[str]]:
    """Pick the platform-appropriate bootstrap runner for a plug-in.

    Windows prefers ``bootstrap.bat`` / ``.cmd`` / ``.ps1``; everywhere else runs
    the manifest's ``needs.bootstrap`` (default ``bootstrap.sh``) via bash. Returns
    None when no runnable script is present (caller bootstraps manually). Guards
    against a script path escaping the plug-in directory.
    """
    def _inside(p: Path) -> Path:
        rp = p.resolve()
        if dest.resolve() != rp and dest.resolve() not in rp.parents:
            raise InstallError("bootstrap path escapes the plug-in directory.")
        return rp

    if os.name == "nt":
        for name in ("bootstrap.bat", "bootstrap.cmd"):
            p = dest / name
            if p.is_file():
                return ["cmd", "/c", str(_inside(p))]
        ps1 = dest / "bootstrap.ps1"
        if ps1.is_file():
            return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                    "-File", str(_inside(ps1))]
        # fall through: maybe a .sh runnable via git-bash on PATH

    script = str((mf.needs or {}).get("bootstrap") or "bootstrap.sh").lstrip("./")
    sp = dest / script
    if not sp.is_file():
        return None
    return ["bash", str(_inside(sp))]


def install_from_git(
    git_url: str,
    plugins_dir: Path,
    *,
    name: Optional[str] = None,
    bootstrap: bool = True,
    force: bool = False,
    progress: ProgressCb = None,
) -> Dict[str, Any]:
    """Clone ``git_url`` into ``plugins_dir`` and optionally run its bootstrap.

    Returns a descriptor: ``{id, name, folder, path, bootstrapped,
    needs_bootstrap}``. Raises :class:`InstallError` on any failure.
    """
    git_url = (git_url or "").strip()
    if not _URL_RE.match(git_url):
        raise InstallError("Only http(s) / git / ssh git URLs are supported.")

    plugins_dir = Path(plugins_dir)
    plugins_dir.mkdir(parents=True, exist_ok=True)
    folder = _safe_folder(name) if name else derive_name(git_url)

    dest = (plugins_dir / folder).resolve()
    if dest.parent != plugins_dir.resolve():
        raise InstallError("Refusing to install outside the plugins directory.")
    if dest.exists():
        if not force:
            raise InstallError(
                f"'{folder}' already exists in plugins/. Pass force to overwrite."
            )
        shutil.rmtree(dest)

    _emit(progress, stage="clone", message=f"Cloning {git_url} …")
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", git_url, str(dest)],
            check=True, capture_output=True, text=True,
        )
    except FileNotFoundError as e:
        raise InstallError("git is not installed on the host.") from e
    except subprocess.CalledProcessError as e:
        raise InstallError(f"git clone failed: {(e.stderr or e.stdout or '').strip()}") from e

    mf = load_manifest(dest)
    if mf is None:
        shutil.rmtree(dest, ignore_errors=True)
        raise InstallError("Cloned repo has no valid plugin.json — not a plug-in.")

    needs_bootstrap = mf.isolation == "sidecar"
    result: Dict[str, Any] = {
        "id": mf.id, "name": mf.name, "folder": folder, "path": str(dest),
        "bootstrapped": False, "needs_bootstrap": needs_bootstrap,
    }

    if bootstrap and needs_bootstrap:
        cmd = _bootstrap_command(dest, mf)
        if cmd is None:
            result["needs_bootstrap"] = True
            return result  # no runnable script found; caller can bootstrap manually
        _emit(progress, stage="bootstrap", message="Building plug-in environment (this can take a while)…")
        proc = subprocess.Popen(
            cmd, cwd=str(dest),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            _emit(progress, stage="bootstrap", message=line.rstrip())
        code = proc.wait()
        if code != 0:
            raise InstallError(f"bootstrap failed (exit {code}). See the output above.")
        result["bootstrapped"] = True

    _emit(progress, stage="done", message=f"Installed '{mf.id}'")
    return result
