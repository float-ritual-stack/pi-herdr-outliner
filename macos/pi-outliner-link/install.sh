#!/usr/bin/env bash
set -euo pipefail

HOST="evan@float-box"
WORKSPACE="/home/evan/test"
REMOTE_BUN="/home/evan/.bun/bin/bun"
APP_DIR="${HOME}/Applications/Pi Outliner Link.app"
CONFIG_PATH="${HOME}/Library/Application Support/PiOutlinerLink/config.json"
FORCE_CONFIG=0

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Build and register the pi-outliner:// macOS URL handler.

Options:
  --host HOST             SSH destination (default: evan@float-box)
  --workspace PATH        Remote outliner repository (default: /home/evan/test)
  --remote-bun PATH       Remote Bun executable (default: /home/evan/.bun/bin/bun)
  --app-dir PATH          App installation path
  --config PATH           Local JSON configuration path
  --force-config          Replace an existing configuration
  -h, --help              Show this help

After installation, test with:
  open 'pi-outliner://goto/PIE-130'

Warp uses Command-click. Ghostty with mouse capture uses Shift-Command-click.
USAGE
}

while (($#)); do
  case "$1" in
    --host) HOST="${2:?--host requires a value}"; shift 2 ;;
    --workspace) WORKSPACE="${2:?--workspace requires a value}"; shift 2 ;;
    --remote-bun) REMOTE_BUN="${2:?--remote-bun requires a value}"; shift 2 ;;
    --app-dir) APP_DIR="${2:?--app-dir requires a value}"; shift 2 ;;
    --config) CONFIG_PATH="${2:?--config requires a value}"; shift 2 ;;
    --force-config) FORCE_CONFIG=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Pi Outliner Link can only be installed on macOS.\n' >&2
  exit 1
fi

for command in xcrun plutil codesign ditto; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

if [[ "$APP_DIR" != /* ]]; then
  APP_DIR="${PWD}/${APP_DIR}"
fi
if [[ "$APP_DIR" != *.app ]]; then
  printf 'App installation path must end in .app: %s\n' "$APP_DIR" >&2
  exit 2
fi
if [[ "$CONFIG_PATH" != /* ]]; then
  CONFIG_PATH="${PWD}/${CONFIG_PATH}"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SCRIPT_DIR}/PiOutlinerLink.swift"
PLIST="${SCRIPT_DIR}/Info.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
APP_PARENT="$(dirname -- "$APP_DIR")"
APP_NAME="$(basename -- "$APP_DIR")"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-outliner-link.XXXXXX")"
BUILD_APP="${TMP_DIR}/Pi Outliner Link.app"
INSTALL_APP="${APP_PARENT}/.${APP_NAME}.installing.$$"
trap 'rm -rf -- "$TMP_DIR" "$INSTALL_APP"' EXIT

xcrun swiftc -O -framework AppKit "$SOURCE" -o "${TMP_DIR}/PiOutlinerLink"
"${TMP_DIR}/PiOutlinerLink" --self-test

mkdir -p -- "${BUILD_APP}/Contents/MacOS"
cp -- "$PLIST" "${BUILD_APP}/Contents/Info.plist"
plutil -replace PiOutlinerLinkConfigPath -string "$CONFIG_PATH" "${BUILD_APP}/Contents/Info.plist"
plutil -lint "${BUILD_APP}/Contents/Info.plist" >/dev/null
cp -- "${TMP_DIR}/PiOutlinerLink" "${BUILD_APP}/Contents/MacOS/PiOutlinerLink"
chmod 755 "${BUILD_APP}/Contents/MacOS/PiOutlinerLink"
codesign --force --sign - "$BUILD_APP" >/dev/null

mkdir -p -- "$APP_PARENT"
rm -rf -- "$INSTALL_APP"
ditto "$BUILD_APP" "$INSTALL_APP"
rm -rf -- "$APP_DIR"
mv -- "$INSTALL_APP" "$APP_DIR"

CONFIG_WRITTEN=0
if [[ ! -f "$CONFIG_PATH" || "$FORCE_CONFIG" == 1 ]]; then
  "${APP_DIR}/Contents/MacOS/PiOutlinerLink" \
    --write-config "$CONFIG_PATH" "$HOST" "$WORKSPACE" "$REMOTE_BUN"
  chmod 600 "$CONFIG_PATH"
  CONFIG_WRITTEN=1
else
  printf 'Preserving existing configuration: %s\n' "$CONFIG_PATH"
fi

if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP_DIR"
fi

printf 'Installed: %s\n' "$APP_DIR"
printf 'Configured: %s\n' "$CONFIG_PATH"
if [[ "$CONFIG_WRITTEN" == 1 ]]; then
  printf 'Remote: %s:%s\n' "$HOST" "$WORKSPACE"
fi
printf "Test: open 'pi-outliner://goto/PIE-130'\n"
