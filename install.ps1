[CmdletBinding()]
param(
  [string]$AntigravityDir = "",
  [string]$PluginsDir = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$PluginName = "agy-file-actions"
if (-not $PluginsDir) {
  $PluginsDir = Join-Path $HOME ".gemini\config\plugins"
}
$TargetPluginDir = Join-Path $PluginsDir $PluginName

function Resolve-AntigravityDir {
  param([string]$ExplicitDir)
  $candidates = @()
  if ($ExplicitDir) { $candidates += $ExplicitDir }
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
    if ($dir -and (Test-Path (Join-Path $dir "resources\app.asar"))) {
      return (Resolve-Path $dir).Path
    }
  }
  return $null
}

$BeginMarker = "// BEGIN AGY_FILE_ACTIONS_LOADER"
$EndMarker = "// END AGY_FILE_ACTIONS_LOADER"
$LoaderJsPath = (Join-Path $TargetPluginDir "scripts\electron-overlay-loader.cjs") -replace '\\', '/'

function Remove-LoaderBlock {
  param([string]$IndexCjsPath)
  if (-not (Test-Path $IndexCjsPath)) { return }
  $content = Get-Content -Path $IndexCjsPath -Raw -Encoding UTF8
  $pattern = "(?s)\r?\n?$([regex]::Escape($BeginMarker)).*?$([regex]::Escape($EndMarker))\r?\n?"
  if ($content -match $pattern) {
    $updated = [regex]::Replace($content, $pattern, "`n")
    Set-Content -Path $IndexCjsPath -Value $updated -Encoding UTF8 -NoNewline
    Write-Output "[agy-file-actions] Removed loader block from $IndexCjsPath"
  }
}

function Ensure-LoaderBlock {
  param([string]$IndexCjsPath)
  $block = @"
$BeginMarker
try {
  const _agyFileActionsLoader = '$LoaderJsPath';
  if (fs.existsSync(_agyFileActionsLoader)) {
    require(_agyFileActionsLoader);
  }
} catch (err) {
  console.warn('[AGY File Actions] Direct Electron loader skipped:', err && err.message ? err.message : err);
}
$EndMarker
"@

  if (Test-Path $IndexCjsPath) {
    $content = Get-Content -Path $IndexCjsPath -Raw -Encoding UTF8
    $backup = "$IndexCjsPath.bak-file-actions"
    if (-not (Test-Path $backup)) {
      Copy-Item -Path $IndexCjsPath -Destination $backup -Force
    }
    $pattern = "(?s)$([regex]::Escape($BeginMarker)).*?$([regex]::Escape($EndMarker))"
    if ($content -match $pattern) {
      $updated = [regex]::Replace($content, $pattern, $block)
      Set-Content -Path $IndexCjsPath -Value $updated -Encoding UTF8 -NoNewline
      Write-Output "[agy-file-actions] Updated existing loader block in $IndexCjsPath"
      return
    }
    # Insert right before loading app.asar (after any existing plugin loaders such as agy-model-inspector)
    $anchorRegex = "const asarPath\s*="
    if ($content -match $anchorRegex) {
      $updated = [regex]::Replace($content, $anchorRegex, "$block`n`nconst asarPath =", 1)
    } else {
      $updated = "$block`n$content"
    }
    Set-Content -Path $IndexCjsPath -Value $updated -Encoding UTF8 -NoNewline
    Write-Output "[agy-file-actions] Registered loader in $IndexCjsPath (existing loaders preserved)"
    return
  }

  $appDir = Split-Path $IndexCjsPath -Parent
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null
  $fresh = @"
'use strict';
const fs = require('fs');
const path = require('path');

$block

const asarPath = path.resolve(__dirname, '..', 'app.asar');
let realPkg = { version: '2.34.0', main: 'dist/main.js' };
try {
  realPkg = JSON.parse(fs.readFileSync(path.join(asarPath, 'package.json'), 'utf8'));
} catch {}
try {
  const electron = require('electron');
  if (electron && electron.app) {
    if (realPkg && realPkg.version) electron.app.getVersion = () => realPkg.version;
    electron.app.getAppPath = () => asarPath;
  }
} catch {}
const mainRel = (realPkg && realPkg.main) ? realPkg.main : 'dist/main.js';
module.exports = require(path.join(asarPath, mainRel));
"@
  Set-Content -Path $IndexCjsPath -Value $fresh -Encoding UTF8 -NoNewline
  Write-Output "[agy-file-actions] Created bootstrap $IndexCjsPath"
}

$resolvedAgy = Resolve-AntigravityDir -ExplicitDir $AntigravityDir

if ($Uninstall) {
  if ($resolvedAgy) {
    $indexCjs = Join-Path $resolvedAgy "resources\app\index.cjs"
    Remove-LoaderBlock -IndexCjsPath $indexCjs
  }
  if (Test-Path $TargetPluginDir) {
    $item = Get-Item $TargetPluginDir -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      [IO.Directory]::Delete($TargetPluginDir)
    } else {
      Remove-Item -Path $TargetPluginDir -Recurse -Force
    }
    Write-Output "[agy-file-actions] Removed plugin link $TargetPluginDir"
  }
  Write-Output "[agy-file-actions] Uninstall complete. Restart Antigravity to unload."
  exit 0
}

# 1. Link workspace repo to ~/.gemini/config/plugins/agy-file-actions via NTFS Junction
New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
if (Test-Path $TargetPluginDir) {
  $item = Get-Item $TargetPluginDir -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    $currentTarget = ($item.Target | Select-Object -First 1)
    if ($currentTarget -ne $RepoRoot) {
      [IO.Directory]::Delete($TargetPluginDir)
      New-Item -ItemType Junction -Path $TargetPluginDir -Target $RepoRoot | Out-Null
    }
  } else {
    throw "Target plugin path already exists as a regular folder: $TargetPluginDir. Move or remove it first."
  }
} else {
  New-Item -ItemType Junction -Path $TargetPluginDir -Target $RepoRoot | Out-Null
}
Write-Output "[agy-file-actions] Linked plugin: $TargetPluginDir -> $RepoRoot"

# 2. Register loader in <Antigravity>/resources/app/index.cjs
if (-not $resolvedAgy) {
  Write-Warning "[agy-file-actions] Antigravity install directory not found. Pass -AntigravityDir '<path>' to register Electron loader."
  exit 0
}

$indexCjsPath = Join-Path $resolvedAgy "resources\app\index.cjs"
Ensure-LoaderBlock -IndexCjsPath $indexCjsPath

$dwritePath = Join-Path $resolvedAgy "DWrite.dll"
if (-not (Test-Path $dwritePath)) {
  Write-Warning "[agy-file-actions] DWrite.dll was not found in $resolvedAgy. If Antigravity ignores resources\app\index.cjs, install agy-model-inspector's DWrite.dll or launch with CDP."
}

Write-Output "[agy-file-actions] Install complete. Completely quit and reopen Antigravity to activate."
