<#
  Build the isolated Audio Analyzer sidecar environment on Windows (+ PANNs model).

    1. uv venv (.venv)  -> plugin.json python path (host maps to Scripts\python.exe)
    2. CPU PyTorch (official CPU index), then librosa + pyloudnorm + soundfile +
       panns-inference.
    3. download the CNN14 AudioSet checkpoint -> models\
  Re-runnable / idempotent. Pure CPU - this is a built-in *service* plug-in.

  Usage (normally invoked via bootstrap.bat):
    .\bootstrap.bat
    # or: powershell -ExecutionPolicy Bypass -File bootstrap.ps1

  Requires: uv (https://astral.sh/uv) on PATH.  Overrides (env): UV=<path>  PYVER=<3.11>

  NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads UTF-8-without-BOM
  as the system code page, so non-ASCII bytes can break the parser).
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
$TorchIndex = if ($env:TORCH_CPU_INDEX) { $env:TORCH_CPU_INDEX } else { 'https://download.pytorch.org/whl/cpu' }
$CkptUrl = 'https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1'
$Ckpt    = Join-Path $Models 'Cnn14_mAP=0.431.pth'

function Log  ($m) { Write-Host "`n[audio-analyzer-bootstrap] $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "`n[audio-analyzer-bootstrap] $m" -ForegroundColor Yellow }

Log "Target: Windows - librosa + pyloudnorm + PANNs (CPU PyTorch). Universal."

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
$env:VIRTUAL_ENV = $Venv

# --- CPU PyTorch first (own index), then the rest ------------------------------
Log "Installing CPU PyTorch (from $TorchIndex)..."
& $Uv pip install --python $PyExe --index-url $TorchIndex "torch"

Log "Installing librosa + pyloudnorm + soundfile + panns-inference..."
& $Uv pip install --python $PyExe "numpy<2" "librosa>=0.10" "soundfile>=0.12" "pyloudnorm>=0.1.1" "panns-inference>=0.1.1"

# --- model (CNN14 AudioSet checkpoint, ~315 MB) --------------------------------
New-Item -ItemType Directory -Force -Path $Models | Out-Null
if ((Test-Path $Ckpt) -and ((Get-Item $Ckpt).Length -gt 0)) {
    Log "have Cnn14_mAP=0.431.pth"
} else {
    Log "fetch Cnn14_mAP=0.431.pth (~315 MB)..."
    try { Invoke-WebRequest -Uri $CkptUrl -OutFile $Ckpt -UseBasicParsing }
    catch { Warn "checkpoint download failed - DSP still works; learned tags disabled until present."; if (Test-Path $Ckpt) { Remove-Item $Ckpt } }
}

# --- smoke check ---------------------------------------------------------------
Log "Verifying imports..."
& $PyExe -c "import numpy, librosa, pyloudnorm; print('DSP ok: librosa', librosa.__version__, 'numpy', numpy.__version__)"
& $PyExe -c "import torch, panns_inference; print('tags ok: torch', torch.__version__)"
if ($LASTEXITCODE -ne 0) { Warn "PANNs not importable here - DSP works, learned tags disabled." }

Log "Done. Audio Analyzer ready (built-in universal CPU service plug-in)."
