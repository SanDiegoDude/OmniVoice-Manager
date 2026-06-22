@echo off
rem Launch the OmniVoice Manager on Windows (builds the web UI if needed, then serves it).
rem Uses the local .venv directly so `uv` does not need to be on your PATH.
rem
rem Script-level flags (consumed here, NOT passed to the server):
rem   --rebuild    Sync Python deps + CLI commands (uv sync) AND force a fresh web
rem                UI build, even if a build already exists. Catches libraries and
rem                console scripts (e.g. omnivoice-plugin) added during active dev.
rem   --forceup    Kill any process already listening on the port first.
rem Everything else is passed through, e.g.: run_manager.bat --ssl --lod
setlocal enabledelayedexpansion
cd /d "%~dp0"

if "%PORT%"=="" set "PORT=8200"

rem --- Parse our own flags; collect the rest to forward to the server ---
set "REBUILD=0"
set "FORCEUP=0"
set "PASS="
:parse
if "%~1"=="" goto :after_parse
if /i "%~1"=="--rebuild" (set "REBUILD=1" & shift & goto :parse)
if /i "%~1"=="--forceup" (set "FORCEUP=1" & shift & goto :parse)
if /i "%~1"=="--force-up" (set "FORCEUP=1" & shift & goto :parse)
set "PASS=!PASS! %~1"
shift
goto :parse
:after_parse

rem --- Free the port if asked (kills a stale/orphaned server holding it) ---
if "%FORCEUP%"=="1" (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr LISTENING') do (
        echo Killing process %%p holding port %PORT% ...
        taskkill /F /PID %%p >nul 2>nul
    )
)

rem --- Locate uv (PATH + the usual install locations) ---
rem The launcher runs off .venv without uv on PATH, so look around before giving up.
set "UVBIN="
for /f "delims=" %%u in ('where uv 2^>nul') do if not defined UVBIN set "UVBIN=%%u"
if not defined UVBIN if exist "%USERPROFILE%\.local\bin\uv.exe" set "UVBIN=%USERPROFILE%\.local\bin\uv.exe"
if not defined UVBIN if exist "%USERPROFILE%\.cargo\bin\uv.exe" set "UVBIN=%USERPROFILE%\.cargo\bin\uv.exe"
if not defined UVBIN if exist ".venv\Scripts\uv.exe" set "UVBIN=.venv\Scripts\uv.exe"

rem --- Sync Python deps + CLI commands on --rebuild ---
rem `uv sync` re-syncs dependencies AND regenerates the project's console scripts
rem (omnivoice-manager, omnivoice-plugin, ...).
if "%REBUILD%"=="1" (
    if defined UVBIN (
        echo Syncing Python deps + CLI commands ^(uv sync^) ...
        "!UVBIN!" sync
        if errorlevel 1 echo uv sync failed - continuing with the existing environment. 1>&2
    ) else (
        echo --rebuild: 'uv' not found - skipping dependency sync. 1>&2
        echo   Install uv or run 'uv sync' yourself if deps/CLI commands changed. 1>&2
    )
)

rem --- Bootstrap built-in plug-ins (plugins\built-in-*) ---
rem First-party plug-ins ship with the host and each need their own isolated
rem sidecar env. Bootstrap any whose env is missing (first run after a pull) and
rem re-run all of them on --rebuild. Best-effort: a failure never blocks startup.
for /d %%D in (plugins\built-in-*) do (
    if exist "%%D\bootstrap.bat" (
        set "NEEDBS=0"
        if "%REBUILD%"=="1" set "NEEDBS=1"
        if not exist "%%D\.venv\Scripts\python.exe" set "NEEDBS=1"
        if "!NEEDBS!"=="1" (
            echo Bootstrapping built-in plug-in: %%D
            if defined UVBIN set "UV=!UVBIN!"
            call "%%D\bootstrap.bat"
            if errorlevel 1 echo   bootstrap failed for %%D - continuing ^(tool may be unavailable^). 1>&2
        )
    )
)

rem --- Decide whether the SPA needs (re)building ---
rem Rebuild when: no build exists, --rebuild was passed, or any web source file
rem is newer than the last build. We never install Node/npm for you — bring your
rem own (https://nodejs.org, 18+). Node is only needed for this build step.
set "NEEDBUILD=0"
if not exist "web\dist\index.html" set "NEEDBUILD=1"
if "%REBUILD%"=="1" set "NEEDBUILD=1"
if "!NEEDBUILD!"=="1" goto :build_decided

rem Auto-detect: rebuild if any web source file is newer than the last build.
rem Run PowerShell on a normal (quoted) line so cmd ignores the pipes/parens
rem inside the quotes; stash the answer in a temp file and read it back.
powershell -NoProfile -Command "$b=(Get-Item web\dist\index.html).LastWriteTime; $s=Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue web\src,web\index.html,web\package.json,web\vite.config.ts,web\tsconfig.json,web\tsconfig.app.json,web\tsconfig.node.json; if ($s | Where-Object { $_.LastWriteTime -gt $b } | Select-Object -First 1) { 'yes' } else { 'no' }" > "%TEMP%\ov_stale.txt" 2>nul
set "STALE="
set /p STALE=<"%TEMP%\ov_stale.txt"
del "%TEMP%\ov_stale.txt" >nul 2>nul
if "!STALE!"=="yes" (
    echo Web UI is older than its source - rebuilding.
    set "NEEDBUILD=1"
)
:build_decided

if "!NEEDBUILD!"=="1" (
    where npm >nul 2>nul
    if errorlevel 1 goto :no_npm
    echo Building web UI ...
    pushd web
    call npm install
    if errorlevel 1 (popd & exit /b 1)
    call npm run build
    if errorlevel 1 (popd & exit /b 1)
    popd
)

:serve
rem Prefer the venv created by `uv sync`; fall back to `uv run` if present.
if exist ".venv\Scripts\omnivoice-manager.exe" (
    ".venv\Scripts\omnivoice-manager.exe" --port %PORT%!PASS!
    exit /b %errorlevel%
)
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -m manager.server --port %PORT%!PASS!
    exit /b %errorlevel%
)
where uv >nul 2>nul
if not errorlevel 1 (
    uv run omnivoice-manager --port %PORT%!PASS!
    exit /b %errorlevel%
)

echo No .venv found and 'uv' is not on PATH. Run 'uv sync --python 3.10' first. 1>&2
exit /b 1

:no_npm
echo The web UI needs building, but 'npm' was not found on your PATH. 1>&2
echo Install Node.js 18+ from https://nodejs.org, then re-run this script. 1>&2
echo Node is only needed for the build step. 1>&2
exit /b 1
