#!/bin/sh
# Install, update or remove dsh-guard for the DeepSeek Harness desktop app (macOS).
#
# Downloads the prebuilt release zip from GitHub, unpacks it to a fixed
# per-user folder and registers that folder as a plugin of a dsh profile.
# Needs nothing but the system's sh, curl and unzip and the desktop app: no
# git, Node.js or build. Running it again updates the plugin in place.
#
# One-line form:
#   curl -fsSL https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.sh | sh -s --
# With options, for example:
#   curl -fsSL https://raw.githubusercontent.com/as3ert/dsh-guard/main/install.sh | sh -s -- --uninstall
set -eu

REPO=as3ert/dsh-guard
ASSET=dsh-guard.zip
PROFILE=desktop
UNINSTALL=0
VERSION=
DSH=
INSTALL_DIR=
SOURCE=
NO_REGISTER=0

usage() {
  cat <<'USAGE'
Usage: install.sh [options]
  --profile <name>      dsh profile to install into (default: desktop)
  --uninstall           remove the plugin from the profile and delete the install folder;
                        the rules in ~/.dsh-guard are kept
  --version <tag>       release tag to install, for example v0.1.1 (default: latest)
  --dsh <path>          dsh launcher (default: the desktop app's, else dsh on PATH)
  --install-dir <dir>   install folder (default: ~/Library/Application Support/dsh-guard)
  --source <zip>        zip to install instead of the GitHub release: a URL or a file (for tests)
  --no-register         download and unpack only; do not touch any dsh profile (for tests)
  --help                show this text
USAGE
}
fail() { echo "dsh-guard install: ERROR: $*" >&2; exit 1; }
say() { echo "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) [ $# -ge 2 ] || fail "--profile needs a value"; PROFILE=$2; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --version) [ $# -ge 2 ] || fail "--version needs a value"; VERSION=$2; shift 2 ;;
    --dsh) [ $# -ge 2 ] || fail "--dsh needs a value"; DSH=$2; shift 2 ;;
    --install-dir) [ $# -ge 2 ] || fail "--install-dir needs a value"; INSTALL_DIR=$2; shift 2 ;;
    --source) [ $# -ge 2 ] || fail "--source needs a value"; SOURCE=$2; shift 2 ;;
    --no-register) NO_REGISTER=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

# Absolute form of a path whose parent exists.
abspath() { (cd "$(dirname "$1")" && printf '%s/%s\n' "$(pwd)" "$(basename "$1")"); }
# Whether a folder holds a dsh-guard package (so it is safe to replace or delete).
is_guard_dir() { [ -f "$1/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"dsh-guard"' "$1/package.json"; }
pkg_version() { sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -n 1; }
# Linked folder of the profile's dsh-guard entry, empty when it has none.
profile_link() { [ -f "$PROFILE_PKG" ] && sed -n 's/.*"dsh-guard"[[:space:]]*:[[:space:]]*"link:\([^"]*\)".*/\1/p' "$PROFILE_PKG" | head -n 1 || true; }
# Whether the profile's package.json names dsh-guard at all (dependency or bundle).
profile_lists() { [ -f "$PROFILE_PKG" ] && grep -q '"dsh-guard"' "$PROFILE_PKG"; }

# 1. dsh launcher and profile
if [ -z "$DSH" ]; then
  for app in "/Applications/DeepSeek Harness.app" "$HOME/Applications/DeepSeek Harness.app"; do
    if [ -x "$app/Contents/Resources/runtime/cli/bin/dsh" ]; then DSH="$app/Contents/Resources/runtime/cli/bin/dsh"; break; fi
  done
  if [ -z "$DSH" ] && command -v dsh >/dev/null 2>&1; then DSH=$(command -v dsh); fi
fi
if [ "$NO_REGISTER" != 1 ] && { [ -z "$DSH" ] || [ ! -e "$DSH" ]; }; then
  fail "DeepSeek Harness was not found. Install the DeepSeek Harness desktop app first, or pass --dsh <path to dsh>."
fi
if [ -z "$INSTALL_DIR" ]; then
  case "$(uname -s)" in
    Darwin) INSTALL_DIR="$HOME/Library/Application Support/dsh-guard" ;;
    *) INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dsh-guard" ;;
  esac
fi
mkdir -p "$(dirname "$INSTALL_DIR")"
INSTALL_DIR=$(abspath "$INSTALL_DIR")
DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PROFILE_PKG="$PROFILE_DIR/package.json"
RULES_DIR=${DSH_GUARD_HOME:-$HOME/.dsh-guard}

# 2. uninstall
if [ "$UNINSTALL" = 1 ]; then
  if [ "$NO_REGISTER" != 1 ]; then
    if profile_lists; then
      out=$("$DSH" plugin --profile "$PROFILE" remove dsh-guard </dev/null 2>&1) || fail "dsh could not remove the plugin from profile '$PROFILE':
$out"
      profile_lists && fail "profile '$PROFILE' still lists dsh-guard after 'dsh plugin remove'."
      # pnpm can leave the link itself behind; delete the link only, never its target.
      [ -L "$PROFILE_DIR/node_modules/dsh-guard" ] && rm -f "$PROFILE_DIR/node_modules/dsh-guard"
      say "Removed dsh-guard from profile '$PROFILE'."
    else
      say "Profile '$PROFILE' does not load dsh-guard; nothing to remove there."
    fi
  fi
  if [ -e "$INSTALL_DIR" ]; then
    is_guard_dir "$INSTALL_DIR" || fail "$INSTALL_DIR is not a dsh-guard folder; it was left as it is."
    rm -rf "$INSTALL_DIR"
    say "Deleted $INSTALL_DIR."
  fi
  say "Your guard rules in $RULES_DIR were kept. Delete that folder by hand only if you no longer want them."
  say ""
  say "NEXT STEP: Quit DeepSeek Harness completely (Cmd+Q) and open it again."
  say "CHECK: After the restart, the agent no longer has the guard tools (guard_list and the others)."
  exit 0
fi

# 3. download
if [ "$NO_REGISTER" != 1 ] && [ ! -d "$PROFILE_DIR" ]; then
  [ "$PROFILE" = desktop ] && fail "the desktop profile does not exist yet ($PROFILE_DIR). Open DeepSeek Harness once, then run this again."
  fail "dsh profile '$PROFILE' does not exist ($PROFILE_DIR)."
fi
if [ -z "$SOURCE" ]; then
  if [ -n "$VERSION" ]; then SOURCE="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
  else SOURCE="https://github.com/$REPO/releases/latest/download/$ASSET"; fi
fi
PARENT=$(dirname "$INSTALL_DIR")
STAGING=$(mktemp -d "$PARENT/.dsh-guard-new-XXXXXX")
ASIDE="$STAGING.old"
trap 'rm -rf "$STAGING"' EXIT
ZIP="$STAGING/$ASSET"
case "$SOURCE" in
  http://*|https://*)
    say "Downloading $SOURCE"
    curl -fsSL -o "$ZIP" "$SOURCE" || fail "download failed ($SOURCE). Check the internet connection${VERSION:+ and that release $VERSION exists}."
    ;;
  *) [ -f "$SOURCE" ] || fail "zip not found: $SOURCE"; cp "$SOURCE" "$ZIP" ;;
esac

# 4. unpack into the staging folder and check the package
UNPACKED="$STAGING/unpacked"
mkdir -p "$UNPACKED"
if command -v unzip >/dev/null 2>&1; then unzip -q "$ZIP" -d "$UNPACKED" || fail "the downloaded file is not a valid zip."
elif command -v ditto >/dev/null 2>&1; then ditto -x -k "$ZIP" "$UNPACKED" || fail "the downloaded file is not a valid zip."
else (cd "$UNPACKED" && tar -xf "$ZIP") || fail "the downloaded file is not a valid zip (or no unzip tool was found)."
fi
TOP=
count=0
for entry in "$UNPACKED"/*; do [ -d "$entry" ] && { TOP=$entry; count=$((count + 1)); }; done
if [ "$count" -ne 1 ] || ! is_guard_dir "$TOP" || [ ! -f "$TOP/dist/index.js" ]; then
  fail "the downloaded zip does not contain a dsh-guard package."
fi
NEW_VERSION=$(pkg_version "$TOP")

# 5. swap: old folder aside, new folder in place, old folder deleted
OLD_VERSION=
if [ -e "$INSTALL_DIR" ]; then
  is_guard_dir "$INSTALL_DIR" || fail "$INSTALL_DIR exists and is not a dsh-guard folder; it was left as it is. Pass --install-dir to use another folder."
  OLD_VERSION=$(pkg_version "$INSTALL_DIR")
  mv "$INSTALL_DIR" "$ASIDE" || fail "could not replace $INSTALL_DIR: quit DeepSeek Harness completely, then run this again."
fi
if ! mv "$TOP" "$INSTALL_DIR"; then
  [ -e "$ASIDE" ] && mv "$ASIDE" "$INSTALL_DIR"
  fail "could not move the new version into $INSTALL_DIR."
fi
rm -rf "$ASIDE"
if [ -z "$OLD_VERSION" ]; then say "Installed dsh-guard $NEW_VERSION in $INSTALL_DIR."
elif [ "$OLD_VERSION" = "$NEW_VERSION" ]; then say "Reinstalled dsh-guard $NEW_VERSION in $INSTALL_DIR."
else say "Updated dsh-guard from $OLD_VERSION to $NEW_VERSION in $INSTALL_DIR."
fi
if [ "$NO_REGISTER" = 1 ]; then
  say "Skipped the dsh profile (--no-register)."
  exit 0
fi

# 6. register the folder with the profile (idempotent)
LINK=$(profile_link)
if [ -n "$LINK" ] && [ "${LINK%/}" = "$INSTALL_DIR" ] && grep -q '^[[:space:]]*"dsh-guard"[[:space:]]*,\{0,1\}[[:space:]]*$' "$PROFILE_PKG"; then
  say "Profile '$PROFILE' already loads dsh-guard from this folder."
else
  if profile_lists; then
    out=$("$DSH" plugin --profile "$PROFILE" remove dsh-guard </dev/null 2>&1) || fail "dsh could not remove the earlier dsh-guard entry from profile '$PROFILE':
$out"
    [ -n "$LINK" ] && say "Replaced the earlier dsh-guard entry, which pointed at $LINK."
  fi
  out=$("$DSH" plugin --profile "$PROFILE" add "$INSTALL_DIR" </dev/null 2>&1) || fail "dsh could not add the plugin to profile '$PROFILE':
$out"
  [ -n "$(profile_link)" ] || fail "'dsh plugin add' finished, but profile '$PROFILE' does not list dsh-guard."
  say "Added dsh-guard to profile '$PROFILE'."
fi
say ""
say "NEXT STEP: Quit DeepSeek Harness completely (Cmd+Q) and open it again."
say "CHECK: After the restart, ask the agent: \"What guard rules do I have?\" It should answer that no rules exist yet and name only the built-in rule dsh-guard.self-protect."
exit 0
