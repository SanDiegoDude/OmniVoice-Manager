<#
  Build the isolated Essentia analyzer sidecar environment on Windows (+ models).

    1. uv venv (.venv)  -> plugin.json points 'python' at .venv/bin/python; the
       host auto-translates to .venv\Scripts\python.exe on Windows.
    2. audio-analysis deps: prefer 'essentia-tensorflow' (DSP + ML taggers), fall
       back to plain 'essentia' (DSP-only) if TF wheels are unavailable.
    3. if TF is available -> download Discogs-EffNet + MTG-Jamendo heads -> models\
  Re-runnable / idempotent. Pure CPU - this is a built-in *service* plug-in.

  Usage (normally invoked via bootstrap.bat):
    .\bootstrap.bat
    # or directly:
    powershell -ExecutionPolicy Bypass -File bootstrap.ps1

  Requires: uv (https://astral.sh/uv) on PATH.  Overrides (env): UV=<path>  PYVER=<3.11>

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads UTF-8-without-BOM
  scripts as the system code page, so non-ASCII bytes (em dashes, arrows) can be
  misread as smart quotes and break the parser.
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest)

$ErrorActionPreference = 'Stop'
$Here   = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here
$Venv   = Join-Path $Here '.venv'
$Models = Join-Path $Here 'models'
$PyExe  = Join-Path $Venv 'Scripts\python.exe'
$PyVer  = if ($env:PYVER) { $env:PYVER } else { '3.11' }

function Log  ($m) { Write-Host "`n[essentia-bootstrap] $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "`n[essentia-bootstrap] $m" -ForegroundColor Yellow }

Log "Target: Windows x64 -> essentia-tensorflow (full taggers; falls back to DSP-only essentia if unavailable)."

# --- uv ------------------------------------------------------------------------
$Uv = $null
$cands = @($env:UV, "$env:USERPROFILE\.local\bin\uv.exe", "$env:USERPROFILE\.cargo\bin\uv.exe")
$onPath = (Get-Command uv -ErrorAction SilentlyContinue)
if ($onPath) { $cands += $onPath.Source }
foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) {
        try { & $c --version *> $null; if ($LASTEXITCODE -eq 0) { $Uv = $c; break } } catch {}
    }
}
if (-not $Uv) { throw "uv not found. Install it from https://astral.sh/uv (or set UV=<path-to-uv.exe>)." }
Log "Using uv at $Uv"

# --- venv ----------------------------------------------------------------------
if (-not (Test-Path $PyExe)) {
    Log "Creating venv ($PyVer) -> $Venv"
    & $Uv venv --python $PyVer $Venv
}

# --- deps: prefer essentia-tensorflow, fall back to plain essentia -------------
Log "Installing audio-analysis deps (trying essentia-tensorflow first)..."
$env:VIRTUAL_ENV = $Venv
& $Uv pip install --python $PyExe "numpy<2" "essentia-tensorflow"
if ($LASTEXITCODE -ne 0) {
    Warn "essentia-tensorflow unavailable on this platform - falling back to DSP-only 'essentia'."
    & $Uv pip install --python $PyExe "numpy<2" "essentia"
}

# Authoritative check for the TensorFlow predict algorithms. The probe prints
# 1/0 (int of bool) to avoid nested-quote/ternary parsing surprises.
$probe = & $PyExe -c "import essentia.standard as es; print(int(hasattr(es,'TensorflowPredict2D')))" 2>$null
$hasTf = ("$probe").Trim()

# --- models (only meaningful when TF is present) -------------------------------
if ($hasTf -eq '1') {
    New-Item -ItemType Directory -Force -Path $Models | Out-Null
    $base = 'https://essentia.upf.edu/models'
    $files = @(
        'feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb',
        'classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb',
        'classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json',
        'classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.pb',
        'classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.json',
        'classification-heads/mtg_jamendo_instrument/mtg_jamendo_instrument-discogs-effnet-1.pb',
        'classification-heads/mtg_jamendo_instrument/mtg_jamendo_instrument-discogs-effnet-1.json',
        'classification-heads/voice_instrumental/voice_instrumental-discogs-effnet-1.pb',
        'classification-heads/voice_instrumental/voice_instrumental-discogs-effnet-1.json'
    )
    foreach ($rel in $files) {
        $leaf = Split-Path $rel -Leaf
        $out  = Join-Path $Models $leaf
        if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0)) { Log "have $leaf"; continue }
        Log "fetch $leaf"
        try { Invoke-WebRequest -Uri "$base/$rel" -OutFile $out -UseBasicParsing }
        catch { Warn "download failed: $base/$rel"; if (Test-Path $out) { Remove-Item $out } }
    }
} else {
    Warn "TensorFlow algorithms not available - skipping model download. DSP analysis (bpm/key/loudness/duration) still works; learned tags are disabled on this platform."
}

# --- smoke check ---------------------------------------------------------------
Log "Verifying essentia import..."
& $PyExe -c "import essentia, essentia.standard as es; print('essentia', essentia.__version__, 'ok; learned-tags (TensorFlow):', hasattr(es,'TensorflowPredict2D'))"

Log "Done. Essentia analyzer ready (built-in CPU service plug-in)."
