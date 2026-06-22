@echo off
rem Windows launcher for the built-in Audio Analyzer bootstrap.
rem
rem Delegates to bootstrap.ps1 (PowerShell gives us robust quoting that batch
rem can't do cleanly). Builds the isolated .venv (CPU PyTorch + librosa + PANNs)
rem and downloads the CNN14 AudioSet checkpoint.
rem
rem Requires uv on PATH. Overrides via env, e.g.:  set PYVER=3.11 & bootstrap.bat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" %*
exit /b %errorlevel%
