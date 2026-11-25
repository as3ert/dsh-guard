<#
.SYNOPSIS
  Build dsh-guard from this checkout and install it into a DeepSeek Harness profile.
.PARAMETER Profile
  dsh profile to install into (default: desktop, the desktop app's profile).
.PARAMETER Dsh
  Path to the dsh launcher. Default: the desktop app's bundled one, else dsh on PATH.
.PARAMETER NoHook
  Do not install the git post-merge / post-checkout hooks.
.PARAMETER BuildOnly
  Only rebuild (used by the git hooks); skip plugin registration and hooks.
#>
param(
  [string]$Profile = 'desktop',
  [string]$Dsh = '',
  [switch]$NoHook,
  [switch]$BuildOnly
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Fail($m) { [Console]::Error.WriteLine("setup: $m"); exit 1 }
function Say($m) { if (-not $BuildOnly) { Write-Host $m } }

# 1. dsh launcher
if (-not $Dsh) {
  $app = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path $app) { $Dsh = $app }
  else {
    $c = Get-Command dsh -ErrorAction SilentlyContinue
    if ($c) { $Dsh = $c.Source }
  }
}
if (-not $BuildOnly) {
  if (-not $Dsh -or -not (Test-Path $Dsh)) {
    Fail 'dsh launcher not found. Install the DeepSeek Harness desktop app, or pass -Dsh <path>.'
  }
}

# 2. Node >= 24.9 and a package manager (system npm, else the app's bundled node + pnpm)
function NodeOk($node) {
  try { $v = & $node -p 'process.versions.node' 2>$null } catch { return $false }
  if (-not $v) { return $false }
  $p = $v.Trim().Split('.') | ForEach-Object { [int]$_ }
  return ($p[0] -gt 24) -or ($p[0] -eq 24 -and $p[1] -ge 9)
}
$node = $null; $pm = $null
$sysNode = Get-Command node -ErrorAction SilentlyContinue
$sysNpm = Get-Command npm -ErrorAction SilentlyContinue
if ($sysNode -and $sysNpm -and (NodeOk $sysNode.Source)) {
  $node = $sysNode.Source; $pm = 'npm'
} else {
  $deps = $null
  if ($Dsh) {
    $rt = Split-Path (Split-Path (Split-Path $Dsh -Parent) -Parent) -Parent
    $deps = Join-Path $rt 'primary-runtime\dependencies'
  }
  if ($deps) {
    $bn = Join-Path $deps 'node\bin\node.exe'
    $bp = Join-Path $deps 'pnpm\bin\pnpm.cjs'
    if ((Test-Path $bn) -and (Test-Path $bp) -and (NodeOk $bn)) {
      $node = $bn; $pm = 'pnpm'; $pnpmCjs = $bp
    }
  }
}
if (-not $node) {
  Fail 'Node.js 24.9 or later with npm is required, and the desktop app bundles no usable one. Install Node.js from https://nodejs.org and re-run.'
}
$env:PATH = (Split-Path $node -Parent) + [IO.Path]::PathSeparator + $env:PATH
function RunPm([string[]]$a) {
  if ($pm -eq 'npm') { & npm @a } else { & $node $pnpmCjs @a }
  if ($LASTEXITCODE -ne 0) { Fail "package manager failed: $pm $($a -join ' ')" }
}

# 3. install dependencies and build
Push-Location $Root
try {
  Say "Using node $(& $node -p 'process.versions.node') with $pm"
  $q = if ($BuildOnly) { @('--silent') } else { @() }
  if ($pm -eq 'npm') { RunPm (@('ci') + $q) } else { RunPm (@('install', '--silent', '--ignore-scripts', '--config.node-linker=hoisted')) }
  RunPm (@('run', 'build') + $q)
} finally { Pop-Location }

if ($BuildOnly) { Write-Host 'dsh-guard rebuilt; restart the DeepSeek Harness app'; exit 0 }

# 4. register the plugin (idempotent: skip when the profile already lists this checkout)
$added = $false
$dump = & $Dsh --profile $Profile --dump-config 2>&1 | Out-String
if ($dump -match '(?m)^\s*-\s*id:\s*dsh-guard\s*$') {
  Write-Host "Profile '$Profile' already loads dsh-guard; nothing to register."
} else {
  & $Dsh plugin --profile $Profile add $Root
  if ($LASTEXITCODE -ne 0) { Fail "dsh plugin add failed for profile '$Profile' (does the profile exist?)." }
  $added = $true
}

# 5. git hooks
$hookNote = 'skipped (-NoHook)'
if (-not $NoHook) {
  $hookNote = & {
    $hdir = (& git -C $Root rev-parse --git-path hooks).Trim()
    if ($LASTEXITCODE -ne 0) { return 'skipped (not a git checkout)' }
    if (-not [IO.Path]::IsPathRooted($hdir)) { $hdir = Join-Path $Root $hdir }
    New-Item -ItemType Directory -Force $hdir | Out-Null
    $begin = '# >>> dsh-guard rebuild'; $end = '# <<< dsh-guard rebuild'
    $out = @()
    foreach ($name in 'post-merge', 'post-checkout') {
      $guard = if ($name -eq 'post-checkout') { 'if [ "$3" != 1 ] || [ "$1" = "$2" ]; then exit 0; fi' } else { '' }
      $block = @($begin, 'ROOT="$(git rev-parse --show-toplevel)"') + @($guard | Where-Object { $_ }) + @(
        'if command -v powershell.exe >/dev/null 2>&1; then',
        '  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ROOT/scripts/setup.ps1" -BuildOnly',
        'else',
        '  sh "$ROOT/scripts/setup.sh" --build-only',
        'fi', $end)
      $text = ($block -join "`n") + "`n"
      $path = Join-Path $hdir $name
      if (Test-Path $path) {
        $old = [IO.File]::ReadAllText($path)
        if ($old.Contains($begin)) { $out += "$name already set"; continue }
        if ($old -notmatch '^#!\s*/(usr/)?bin/(env )?(ba)?sh') { $out += "$name skipped (foreign non-sh hook)"; continue }
        [IO.File]::WriteAllText($path, $old.TrimEnd() + "`n`n" + $text.Replace("`r", ''))
        $out += "$name appended"
      } else {
        [IO.File]::WriteAllText($path, "#!/bin/sh`n" + $text)
        $out += "$name installed"
      }
    }
    return ($out -join '; ')
  }
}

Write-Host ''
Write-Host "dsh-guard built in $Root"
Write-Host "Plugin: $(if ($added) { "added to profile '$Profile'" } else { "already in profile '$Profile'" })"
Write-Host "Git hooks: $hookNote"
Write-Host 'Restart the DeepSeek Harness app to load it.'
