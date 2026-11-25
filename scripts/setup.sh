#!/bin/sh
# Build dsh-guard from this checkout and install it into a DeepSeek Harness profile.
# Usage: scripts/setup.sh [--profile <name>] [--dsh <path>] [--no-hook] [--build-only] [--help]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROFILE=desktop
DSH=
NOHOOK=0
BUILDONLY=0

usage() {
  cat <<'USAGE'
Usage: scripts/setup.sh [options]
  --profile <name>  dsh profile to install into (default: desktop)
  --dsh <path>      dsh launcher (default: the desktop app's, else dsh on PATH)
  --no-hook         do not install the git post-merge / post-checkout hooks
  --build-only      only rebuild (used by the git hooks)
  --help            show this text
USAGE
}
fail() { echo "setup: $*" >&2; exit 1; }
say() { [ "$BUILDONLY" = 1 ] || echo "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) [ $# -ge 2 ] || fail "--profile needs a value"; PROFILE=$2; shift 2 ;;
    --dsh) [ $# -ge 2 ] || fail "--dsh needs a value"; DSH=$2; shift 2 ;;
    --no-hook) NOHOOK=1; shift ;;
    --build-only) BUILDONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

# 1. dsh launcher
if [ -z "$DSH" ]; then
  APP="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  if [ -x "$APP" ]; then DSH=$APP
  elif command -v dsh >/dev/null 2>&1; then DSH=$(command -v dsh)
  fi
fi
if [ "$BUILDONLY" != 1 ] && { [ -z "$DSH" ] || [ ! -e "$DSH" ]; }; then
  fail "dsh launcher not found. Install the DeepSeek Harness desktop app, or pass --dsh <path>."
fi

# 2. Node >= 24.9 and a package manager (system npm, else the app's bundled node + pnpm)
node_ok() {
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ "$major" -gt 24 ] || { [ "$major" -eq 24 ] && [ "$minor" -ge 9 ]; }
}
NODE=; PM=; PNPM_CJS=
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node_ok node; then
  NODE=$(command -v node); PM=npm
elif [ -n "$DSH" ]; then
  RT=$(dirname "$(dirname "$(dirname "$DSH")")")
  BN="$RT/primary-runtime/dependencies/node/bin/node"
  BP="$RT/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
  if [ -x "$BN" ] && [ -f "$BP" ] && node_ok "$BN"; then NODE=$BN; PM=pnpm; PNPM_CJS=$BP; fi
fi
[ -n "$NODE" ] || fail "Node.js 24.9 or later with npm is required, and the desktop app bundles no usable one. Install Node.js from https://nodejs.org and re-run."
PATH="$(dirname "$NODE"):$PATH"; export PATH

# 3. install dependencies and build
cd "$ROOT"
say "Using node $("$NODE" -p 'process.versions.node') with $PM"
Q=; [ "$BUILDONLY" = 1 ] && Q=--silent
if [ "$PM" = npm ]; then
  npm ci $Q
  npm run build $Q
else
  "$NODE" "$PNPM_CJS" install --silent --ignore-scripts --config.node-linker=hoisted
  "$NODE" "$PNPM_CJS" run build $Q --config.verify-deps-before-run=false
fi

if [ "$BUILDONLY" = 1 ]; then echo "dsh-guard rebuilt; restart the DeepSeek Harness app"; exit 0; fi

# 4. register the plugin (idempotent: skip when the profile already lists dsh-guard)
ADDED=0
if "$DSH" --profile "$PROFILE" --dump-config 2>&1 | grep -Eq '^[[:space:]]*-[[:space:]]*id:[[:space:]]*dsh-guard[[:space:]]*$'; then
  echo "Profile '$PROFILE' already loads dsh-guard; nothing to register."
else
  "$DSH" plugin --profile "$PROFILE" add "$ROOT" || fail "dsh plugin add failed for profile '$PROFILE' (does the profile exist?)."
  ADDED=1
fi

# 5. git hooks
HOOKNOTE="skipped (--no-hook)"
if [ "$NOHOOK" = 0 ]; then
  HDIR=$(git -C "$ROOT" rev-parse --git-path hooks 2>/dev/null) || HDIR=
  if [ -z "$HDIR" ]; then
    HOOKNOTE="skipped (not a git checkout)"
  else
    case "$HDIR" in /*) ;; *) HDIR="$ROOT/$HDIR" ;; esac
    mkdir -p "$HDIR"
    BEGIN='# >>> dsh-guard rebuild'; END='# <<< dsh-guard rebuild'
    HOOKNOTE=
    for NAME in post-merge post-checkout; do
      BLOCK="$BEGIN
ROOT=\"\$(git rev-parse --show-toplevel)\""
      if [ "$NAME" = post-checkout ]; then
        BLOCK="$BLOCK
if [ \"\$3\" != 1 ] || [ \"\$1\" = \"\$2\" ]; then exit 0; fi"
      fi
      BLOCK="$BLOCK
if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"\$ROOT/scripts/setup.ps1\" -BuildOnly
else
  sh \"\$ROOT/scripts/setup.sh\" --build-only
fi
$END"
      F="$HDIR/$NAME"
      if [ -f "$F" ]; then
        if grep -qF "$BEGIN" "$F"; then R="$NAME already set"
        elif ! head -n 1 "$F" | grep -Eq '^#!.*(ba|da)?sh'; then R="$NAME skipped (foreign non-sh hook)"
        else printf '\n%s\n' "$BLOCK" >> "$F"; R="$NAME appended"; fi
      else
        printf '#!/bin/sh\n%s\n' "$BLOCK" > "$F"; chmod +x "$F"; R="$NAME installed"
      fi
      HOOKNOTE="${HOOKNOTE:+$HOOKNOTE; }$R"
    done
  fi
fi

echo
echo "dsh-guard built in $ROOT"
if [ "$ADDED" = 1 ]; then echo "Plugin: added to profile '$PROFILE'"; else echo "Plugin: already in profile '$PROFILE'"; fi
echo "Git hooks: $HOOKNOTE"
echo "Restart the DeepSeek Harness app to load it."
