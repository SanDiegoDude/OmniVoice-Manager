@echo off
rem Windows launcher for the built-in Essentia analyzer bootstrap.
rem
rem Delegates to bootstrap.ps1 (PowerShell gives us robust quoting + here-docs
rem that batch can't do cleanly). Builds the isolated .venv and, when TensorFlow
rem is available, downloads the analysis models.
rem
rem Requires uv on PATH. Overrides via env, e.g.:  set PYVER=3.11 & bootstrap.bat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" %*
exit /b %errorlevel%
