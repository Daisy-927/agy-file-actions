[CmdletBinding()]
param(
  [string]$AntigravityDir = "",
  [string]$CdpUrl = "",
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$InjectorScript = Join-Path $RepoRoot "scripts\runtime-injector.mjs"

function Resolve-NodeRunner {
  param([string]$ExplicitAgyDir)

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd -and $nodeCmd.Source) {
    try {
      $majorText = & $nodeCmd.Source -p "process.versions.node.split('.')[0]" 2>$null
      if ([int]$majorText -ge 22) {
        return @{ Exe = $nodeCmd.Source; UseElectronAsNode = $false }
      }
    } catch {}
  }

  $candidates = @()
  if ($ExplicitAgyDir) { $candidates += $ExplicitAgyDir }
  if ($env:ANTIGRAVITY_INSTALL_DIR) { $candidates += $env:ANTIGRAVITY_INSTALL_DIR }
  $running = Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running -and $running.Path) {
    $candidates += (Split-Path $running.Path -Parent)
  }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA "Programs\Antigravity"),
    (Join-Path $env:ProgramFiles "Antigravity"),
    "D:\Antigravity",
    "E:\Antigravity"
  )
  foreach ($dir in $candidates) {
    if (-not $dir) { continue }
    $exe = Join-Path $dir "Antigravity.exe"
    if (Test-Path $exe) {
      return @{ Exe = (Resolve-Path $exe).Path; UseElectronAsNode = $true }
    }
  }
  return $null
}

$runner = Resolve-NodeRunner -ExplicitAgyDir $AntigravityDir
if (-not $runner) {
  throw "Could not find Node.js >= 22 on PATH or Antigravity.exe for ELECTRON_RUN_AS_NODE fallback. Pass -AntigravityDir '<path>'."
}

$argsList = @("--no-warnings", $InjectorScript)
if ($Once) { $argsList += "--once" }

$prevCdpUrl = $env:AGY_CDP_URL
if ($CdpUrl) { $env:AGY_CDP_URL = $CdpUrl }

try {
  if ($runner.UseElectronAsNode) {
    Write-Host "[agy-file-actions] Host Node.js >= 22 not found; using $($runner.Exe) via ELECTRON_RUN_AS_NODE=1"
    $prevEnv = $env:ELECTRON_RUN_AS_NODE
    try {
      $env:ELECTRON_RUN_AS_NODE = "1"
      & $runner.Exe @argsList
    } finally {
      if ($null -eq $prevEnv) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
      else { $env:ELECTRON_RUN_AS_NODE = $prevEnv }
    }
  } else {
    & $runner.Exe @argsList
  }
} finally {
  if ($CdpUrl) {
    if ($null -eq $prevCdpUrl) { Remove-Item Env:AGY_CDP_URL -ErrorAction SilentlyContinue }
    else { $env:AGY_CDP_URL = $prevCdpUrl }
  }
}
