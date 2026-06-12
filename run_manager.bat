@echo off
rem Launch the OmniVoice Manager on Windows (builds the web UI if needed, then serves it).
rem Uses the local .venv directly so `uv` does not need to be on your PATH.
rem Extra arguments are passed through, e.g.: run_manager.bat --lod --ssl
setlocal
cd /d "%~dp0"

if "%PORT%"=="" set "PORT=8200"

rem Build the SPA once if it hasn't been built yet.
if not exist "web\dist\index.html" (
    echo Building web UI ^(first run^)...
    pushd web
    call npm install
    if errorlevel 1 exit /b 1
    call npm run build
    if errorlevel 1 exit /b 1
    popd
)

rem Prefer the venv created by `uv sync`; fall back to `uv run` if present.
if exist ".venv\Scripts\omnivoice-manager.exe" (
    ".venv\Scripts\omnivoice-manager.exe" --port %PORT% %*
    exit /b %errorlevel%
)
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -m manager.server --port %PORT% %*
    exit /b %errorlevel%
)
where uv >nul 2>nul
if not errorlevel 1 (
    uv run omnivoice-manager --port %PORT% %*
    exit /b %errorlevel%
)

echo No .venv found and 'uv' is not on PATH. Run 'uv sync --python 3.10' first. 1>&2
exit /b 1
