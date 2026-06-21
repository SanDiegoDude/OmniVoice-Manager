"""``omnivoice-plugin`` — manage external OmniVoice plug-ins from the CLI.

Thin wrapper over :mod:`manager.plugins.install`. The host discovers any
correctly-shaped folder under ``plugins/``; this just automates the common
"clone a plug-in repo and build its isolated env" flow.

    omnivoice-plugin install <git-url> [--name NAME] [--no-bootstrap] [--force]
    omnivoice-plugin list
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional, Sequence

from .config import PLUGINS_DIR
from .plugins.install import InstallError, install_from_git
from .plugins.manifest import load_manifest


def _install(args: argparse.Namespace) -> int:
    def progress(p: dict) -> None:
        msg = p.get("message") or p.get("stage")
        if msg:
            print(msg, flush=True)

    try:
        res = install_from_git(
            args.git_url, PLUGINS_DIR,
            name=args.name, bootstrap=not args.no_bootstrap, force=args.force,
            progress=progress,
        )
    except InstallError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    print(f"\n✓ Installed '{res['id']}' → {res['path']}")
    if res.get("needs_bootstrap") and not res["bootstrapped"]:
        print(f"  Finish the install by building its env: (cd '{res['path']}' && ./bootstrap.sh)")
    return 0


def _list(_args: argparse.Namespace) -> int:
    found = False
    for d in sorted(PLUGINS_DIR.iterdir()):
        if d.name == "_sdk" or not d.is_dir():
            continue
        mf = load_manifest(d)
        if not mf:
            continue
        found = True
        state = "ready" if mf.installed else "needs bootstrap"
        print(f"{mf.id:28} v{mf.version:8} [{state:14}] {d.name}")
    if not found:
        print("No plug-ins installed. Install one with: omnivoice-plugin install <git-url>")
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="omnivoice-plugin", description="Manage OmniVoice plug-ins.")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("install", help="Install a plug-in from a git URL into plugins/.")
    pi.add_argument("git_url", help="Git URL of the plug-in repository.")
    pi.add_argument("--name", default=None, help="Folder name under plugins/ (default: derived from the URL).")
    pi.add_argument("--no-bootstrap", action="store_true", help="Clone only; skip building the isolated venv.")
    pi.add_argument("--force", action="store_true", help="Overwrite an existing folder of the same name.")
    pi.set_defaults(func=_install)

    pl = sub.add_parser("list", help="List installed plug-ins.")
    pl.set_defaults(func=_list)

    args = p.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
