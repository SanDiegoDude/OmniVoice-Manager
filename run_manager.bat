@echo off
rem Launch the OmniVoice Manager on Windows (keeps the install current, then serves).
rem Uses the local .venv directly so uv does not need to be on your PATH.
rem
rem By default every launch KEEPS THE INSTALL CURRENT - frees the port, syncs Python
rem deps/CLI (uv sync), bootstraps any new/changed built-in plug-ins, and rebuilds
rem the web UI if its sources changed. Cheap when nothing changed.
rem
rem Script-level flags (consumed here, NOT passed to the server):
rem   --norebuild  Fast launch: skip uv sync + web staleness check + built-in update
rem                checks. Only builds/bootstraps things missing outright.
rem   --rebuild    (deprecated; now default) Force a fresh web build + re-bootstrap.
rem   --forceup    (deprecated; now always done) The port is always freed first.
rem Everything else is passed through, e.g.: run_manager.bat --ssl --lod
setlocal enabledelayedexpansion
cd /d "%~dp0"

if "%PORT%"=="" set "PORT=8200"

rem --- Parse our own flags; collect the rest to forward to the server ---
set "FAST=0"
set "FORCE=0"
set "PASS="
:parse
if "%~1"=="" goto :after_parse
if /i "%~1"=="--norebuild" (set "FAST=1" & shift & goto :parse)
if /i "%~1"=="--rebuild" (set "FORCE=1" & shift & goto :parse)
if /i "%~1"=="--forceup" (shift & goto :parse)
if /i "%~1"=="--force-up" (shift & goto :parse)
set "PASS=!PASS! %~1"
shift
goto :parse
:after_parse

rem --- Always free the port (only ever one manager per host) ---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr LISTENING') do (
    echo Freeing port %PORT% - stopping process %%p
    taskkill /F /PID %%p >nul 2>nul
)

rem --- Locate uv (PATH + the usual install locations) ---
set "UVBIN="
for /f "delims=" %%u in ('where uv 2^>nul') do if not defined UVBIN set "UVBIN=%%u"
if not defined UVBIN if exist "%USERPROFILE%\.local\bin\uv.exe" set "UVBIN=%USERPROFILE%\.local\bin\uv.exe"
if not defined UVBIN if exist "%USERPROFILE%\.cargo\bin\uv.exe" set "UVBIN=%USERPROFILE%\.cargo\bin\uv.exe"
if not defined UVBIN if exist ".venv\Scripts\uv.exe" set "UVBIN=.venv\Scripts\uv.exe"

rem --- Sync Python deps + CLI commands (default; skipped on --norebuild) ---
if "%FAST%"=="0" (
    if defined UVBIN (
        echo Syncing Python deps + CLI commands ^(uv sync^) ...
        "!UVBIN!" sync
        if errorlevel 1 echo uv sync failed - continuing with the existing environment. 1>&2
    ) else (
        echo 'uv' not found - skipping dependency sync. 1>&2
        echo   Install uv or run 'uv sync' yourself if deps/CLI commands changed. 1>&2
    )
)

rem --- Bootstrap built-in plug-ins (plugins\built-in-*) ---
rem Fingerprint each plug-in's bootstrap inputs and only (re)bootstrap when the env
rem is missing, the fingerprint changed (plug-in updated), or --rebuild forces it.
for /d %%D in (plugins\built-in-*) do (
    if exist "%%D\bootstrap.bat" (
        set "PDIR=%%D"
        call :platform_check
        if "!SUPPORTED!"=="0" (
            echo Skipping built-in %%D - not supported on this platform.
        ) else (
            call :bootstrap_builtin
        )
    )
)

rem --- Decide whether the SPA needs (re)building ---
set "NEEDBUILD=0"
if not exist "web\dist\index.html" set "NEEDBUILD=1"
if "%FORCE%"=="1" set "NEEDBUILD=1"
if "!NEEDBUILD!"=="1" goto :build_decided
if "%FAST%"=="1" goto :build_decided

rem Auto-detect: rebuild if any web source file is newer than the last build.
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
rem Prefer the venv created by uv sync; fall back to uv run if present.
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

rem --- subroutine: is this built-in supported on this platform? (sets SUPPORTED) ---
rem A plugin.json "platforms" allow-list (os-arch tokens) gates the install so we
rem never attempt a doomed bootstrap. No list, or no parse, means supported.
:platform_check
set "SUPPORTED=1"
if not exist "!PDIR!\plugin.json" goto :eof
powershell -NoProfile -Command "try { $d = Get-Content -Raw '!PDIR!\plugin.json' | ConvertFrom-Json } catch { exit 0 }; $pf = $d.platforms; if (-not $pf) { exit 0 }; $a = $env:PROCESSOR_ARCHITECTURE; if ($a -eq 'AMD64') { $a = 'x86_64' } elseif ($a -eq 'ARM64') { $a = 'arm64' } else { $a = $a.ToLower() }; $allow = @($pf | ForEach-Object { $_.ToString().Trim().ToLower() }); if (($allow -contains ('windows-' + $a)) -or ($allow -contains 'windows') -or ($allow -contains 'windows-*') -or ($allow -contains '*')) { exit 0 } else { exit 1 }"
if errorlevel 1 set "SUPPORTED=0"
goto :eof

rem --- subroutine: (re)bootstrap one built-in plug-in (PDIR set by caller) ---
:bootstrap_builtin
set "MARKER=!PDIR!\.venv\.ov-bootstrap-ok"
rem Fingerprint via a temp file (a for/f with inline PowerShell parens fights cmd).
set "FP="
powershell -NoProfile -Command "$f=@('!PDIR!\bootstrap.ps1','!PDIR!\plugin.json') | Where-Object { Test-Path $_ }; ((Get-FileHash -Algorithm MD5 $f -ErrorAction SilentlyContinue | ForEach-Object Hash) -join '-')" > "%TEMP%\ov_fp.txt" 2>nul
if exist "%TEMP%\ov_fp.txt" set /p FP=<"%TEMP%\ov_fp.txt"
del "%TEMP%\ov_fp.txt" >nul 2>nul
set "CUR="
if exist "!MARKER!" set /p CUR=<"!MARKER!"
rem Bootstrap when the venv is missing, the success marker is absent (no confirmed
rem install yet), --rebuild forces it, or the fingerprint changed. We never adopt an
rem unmarked venv - a half-built env must keep retrying instead of being masked good.
set "NEED=0"
if not exist "!PDIR!\.venv\Scripts\python.exe" set "NEED=1" & goto :bb_decided
if "%FAST%"=="1" goto :bb_decided
if "%FORCE%"=="1" set "NEED=1"
if not exist "!MARKER!" set "NEED=1"
if exist "!MARKER!" if not "!CUR!"=="!FP!" set "NEED=1"
:bb_decided
if "!NEED!"=="1" (
    echo Bootstrapping built-in plug-in: !PDIR!
    if defined UVBIN set "UV=!UVBIN!"
    call "!PDIR!\bootstrap.bat"
    if errorlevel 1 (
        if exist "!MARKER!" del "!MARKER!" >nul 2>nul
        echo   bootstrap failed for !PDIR! - continuing; tool may be unavailable. 1>&2
    ) else (
        >"!MARKER!" echo !FP!
    )
)
goto :eof
