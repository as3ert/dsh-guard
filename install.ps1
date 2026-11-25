<#
.SYNOPSIS
  Install, update or remove dsh-guard for the DeepSeek Harness desktop app.
.DESCRIPTION
  Downloads the prebuilt release zip from GitHub, unpacks it to a fixed
  per-user folder and registers that folder as a plugin of a dsh profile.
  Needs nothing but Windows PowerShell 5.1 (or later) and the desktop app:
  no git, Node.js or build. Running it again updates the plugin in place.

  One-line form (new PowerShell process, default options):
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.ps1 | iex"
  With options:
    powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.ps1))) -Uninstall"
.PARAMETER Profile
  dsh profile to install into (default: desktop, the desktop app's profile).
.PARAMETER Uninstall
  Remove the plugin from the profile and delete the install folder. The user's
  rules in ~/.dsh-guard are kept.
.PARAMETER Version
  Release tag to install, for example v0.1.1 (default: the latest release).
.PARAMETER Dsh
  Path to the dsh launcher. Default: the desktop app's bundled one, else dsh on PATH.
.PARAMETER InstallDir
  Install folder (default: %LOCALAPPDATA%\dsh-guard).
.PARAMETER Source
  Zip to install instead of the GitHub release: a URL or a local file (for tests).
#>
param(
  [string]$Profile = 'desktop',
  [switch]$Uninstall,
  [string]$Version = '',
  [string]$Dsh = '',
  [string]$InstallDir = '',
  [string]$Source = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'as3ert/dsh-guard'
$Asset = 'dsh-guard.zip'

function Fail([string]$m) {
  [Console]::Error.WriteLine("dsh-guard install: ERROR: $m")
  exit 1
}
function Say([string]$m) { Write-Host $m }

# Path comparison: absolute, forward slashes, no trailing slash, lower case.
function Norm([string]$p) {
  return ([IO.Path]::GetFullPath($p) -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
}

# Whether a folder holds a dsh-guard package (so it is safe to replace or delete).
function IsGuardDir([string]$dir) {
  $pkg = Join-Path $dir 'package.json'
  if (-not (Test-Path -LiteralPath $pkg)) { return $false }
  try { return ((Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).name -eq 'dsh-guard') } catch { return $false }
}

# Run the dsh launcher; returns @{ Code; Text } without letting stderr abort the script.
function RunDsh([string[]]$a) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = & $Dsh @a 2>&1 | ForEach-Object { "$_" } | Out-String
    return @{ Code = $LASTEXITCODE; Text = $text.Trim() }
  } finally { $ErrorActionPreference = $old }
}

# dsh-guard entry of a profile: @{ Listed; Link; Bundled } from its package.json.
function ProfileState([string]$pkgFile) {
  $state = @{ Listed = $false; Link = ''; Bundled = $false }
  if (-not (Test-Path -LiteralPath $pkgFile)) { return $state }
  $pkg = Get-Content -LiteralPath $pkgFile -Raw | ConvertFrom-Json
  if ($pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains 'dsh-guard')) {
    $state.Listed = $true
    $spec = [string]$pkg.dependencies.'dsh-guard'
    if ($spec.StartsWith('link:')) {
      $p = $spec.Substring(5)
      if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Split-Path $pkgFile -Parent) $p }
      $state.Link = $p
    }
  }
  if ($pkg.dsh -and $pkg.dsh.profile -and ($pkg.dsh.profile.bundles -contains 'dsh-guard')) { $state.Bundled = $true }
  return $state
}

# 1. dsh launcher and profile
if (-not $Dsh) {
  $app = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path -LiteralPath $app) { $Dsh = $app }
  else {
    $c = Get-Command dsh -ErrorAction SilentlyContinue
    if ($c) { $Dsh = $c.Source }
  }
}
if (-not $Dsh -or -not (Test-Path -LiteralPath $Dsh)) {
  Fail 'DeepSeek Harness was not found. Install the DeepSeek Harness desktop app first, or pass -Dsh <path to dsh>.'
}
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'dsh-guard' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$DshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$ProfilePkg = Join-Path $ProfileDir 'package.json'
$RulesDir = if ($env:DSH_GUARD_HOME -and $env:DSH_GUARD_HOME.Trim()) { $env:DSH_GUARD_HOME } else { Join-Path $HOME '.dsh-guard' }

# 2. uninstall
if ($Uninstall) {
  $state = ProfileState $ProfilePkg
  if ($state.Listed -or $state.Bundled) {
    $r = RunDsh @('plugin', '--profile', $Profile, 'remove', 'dsh-guard')
    if ($r.Code -ne 0) { Fail "dsh could not remove the plugin from profile '$Profile':`n$($r.Text)" }
    $state = ProfileState $ProfilePkg
    if ($state.Listed -or $state.Bundled) { Fail "profile '$Profile' still lists dsh-guard after 'dsh plugin remove'." }
    # pnpm can leave the link itself behind; delete the link only, never its target.
    $link = Get-Item -LiteralPath (Join-Path $ProfileDir 'node_modules\dsh-guard') -Force -ErrorAction SilentlyContinue
    if ($link -and $link.LinkType) { try { [IO.Directory]::Delete($link.FullName, $false) } catch { } }
    Say "Removed dsh-guard from profile '$Profile'."
  } else {
    Say "Profile '$Profile' does not load dsh-guard; nothing to remove there."
  }
  if (Test-Path -LiteralPath $InstallDir) {
    if (-not (IsGuardDir $InstallDir)) { Fail "$InstallDir is not a dsh-guard folder; it was left as it is." }
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Say "Deleted $InstallDir."
  }
  Say "Your guard rules in $RulesDir were kept. Delete that folder by hand only if you no longer want them."
  Say ''
  Say 'NEXT STEP: Quit DeepSeek Harness completely and open it again.'
  Say 'CHECK: After the restart, the agent no longer has the guard tools (guard_list and the others).'
  exit 0
}

# 3. download
if (-not (Test-Path -LiteralPath $ProfileDir)) {
  if ($Profile -eq 'desktop') { Fail "the desktop profile does not exist yet ($ProfileDir). Open DeepSeek Harness once, then run this again." }
  Fail "dsh profile '$Profile' does not exist ($ProfileDir)."
}
if (-not $Source) {
  $Source = if ($Version) { "https://github.com/$Repo/releases/download/$Version/$Asset" } else { "https://github.com/$Repo/releases/latest/download/$Asset" }
}
$parent = Split-Path $InstallDir -Parent
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$tag = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$staging = Join-Path $parent ".dsh-guard-new-$tag"
$aside = Join-Path $parent ".dsh-guard-old-$tag"
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  $zip = Join-Path $staging $Asset
  if ($Source -match '^https?://') {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    Say "Downloading $Source"
    try { Invoke-WebRequest -Uri $Source -OutFile $zip -UseBasicParsing }
    catch { Fail "download failed ($Source): $($_.Exception.Message). Check the internet connection$(if ($Version) { " and that release $Version exists" })." }
  } else {
    if (-not (Test-Path -LiteralPath $Source)) { Fail "zip not found: $Source" }
    Copy-Item -LiteralPath $Source -Destination $zip
  }

  # 4. unpack into the staging folder and check the package
  $unpacked = Join-Path $staging 'unpacked'
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
  } catch { Fail "the downloaded file is not a valid zip: $($_.Exception.Message)" }
  $top = @(Get-ChildItem -LiteralPath $unpacked -Directory)
  if ($top.Count -ne 1 -or -not (IsGuardDir $top[0].FullName) -or -not (Test-Path -LiteralPath (Join-Path $top[0].FullName 'dist\index.js'))) {
    Fail 'the downloaded zip does not contain a dsh-guard package.'
  }
  $newVersion = (Get-Content -LiteralPath (Join-Path $top[0].FullName 'package.json') -Raw | ConvertFrom-Json).version

  # 5. swap: old folder aside, new folder in place, old folder deleted
  $oldVersion = ''
  if (Test-Path -LiteralPath $InstallDir) {
    if (-not (IsGuardDir $InstallDir)) { Fail "$InstallDir exists and is not a dsh-guard folder; it was left as it is. Pass -InstallDir to use another folder." }
    $oldVersion = (Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version
    try { Rename-Item -LiteralPath $InstallDir -NewName (Split-Path $aside -Leaf) }
    catch { Fail "could not replace $InstallDir (a file in it is in use): quit DeepSeek Harness completely, then run this again." }
  }
  try { Move-Item -LiteralPath $top[0].FullName -Destination $InstallDir }
  catch {
    if (Test-Path -LiteralPath $aside) { Rename-Item -LiteralPath $aside -NewName (Split-Path $InstallDir -Leaf) }
    Fail "could not move the new version into $InstallDir`: $($_.Exception.Message)"
  }
  if (Test-Path -LiteralPath $aside) { Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction SilentlyContinue }
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
$what = if (-not $oldVersion) { "Installed dsh-guard $newVersion in $InstallDir." }
  elseif ($oldVersion -eq $newVersion) { "Reinstalled dsh-guard $newVersion in $InstallDir." }
  else { "Updated dsh-guard from $oldVersion to $newVersion in $InstallDir." }
Say $what

# 6. register the folder with the profile (idempotent)
$state = ProfileState $ProfilePkg
$linked = $state.Listed -and $state.Bundled -and $state.Link -and ((Norm $state.Link) -eq (Norm $InstallDir))
if ($linked) {
  Say "Profile '$Profile' already loads dsh-guard from this folder."
} else {
  if ($state.Listed -or $state.Bundled) {
    $r = RunDsh @('plugin', '--profile', $Profile, 'remove', 'dsh-guard')
    if ($r.Code -ne 0) { Fail "dsh could not remove the earlier dsh-guard entry from profile '$Profile':`n$($r.Text)" }
    if ($state.Link) { Say "Replaced the earlier dsh-guard entry, which pointed at $($state.Link)." }
  }
  $r = RunDsh @('plugin', '--profile', $Profile, 'add', $InstallDir)
  if ($r.Code -ne 0) { Fail "dsh could not add the plugin to profile '$Profile':`n$($r.Text)" }
  $state = ProfileState $ProfilePkg
  if (-not ($state.Listed -and $state.Bundled)) { Fail "'dsh plugin add' finished, but profile '$Profile' does not list dsh-guard." }
  Say "Added dsh-guard to profile '$Profile'."
}
Say ''
Say 'NEXT STEP: Quit DeepSeek Harness completely and open it again.'
Say 'CHECK: After the restart, ask the agent: "What guard rules do I have?" It should answer that no rules exist yet and name only the built-in rule dsh-guard.self-protect.'
exit 0
