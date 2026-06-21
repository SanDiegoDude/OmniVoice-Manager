"""OmniVoice plug-in host.

Discovers external plug-ins under the repo ``plugins/`` directory, runs the
isolated ones as sidecar subprocesses (each in its own virtualenv so a plug-in's
dependencies can never destabilize the core app), serializes GPU access against
the main TTS worker, and brokers the host call-back hooks plug-ins use to reach
back into the app (sound library, project data, Script-AI reprompt).

Public surface:
  * ``PluginHost`` — discovery + lifecycle + invocation.
  * ``PluginManifest`` — a parsed ``plugin.json`` descriptor.
"""

from __future__ import annotations

from .host import PluginHost
from .install import InstallError, install_from_git
from .manifest import PluginManifest

__all__ = ["PluginHost", "PluginManifest", "install_from_git", "InstallError"]
