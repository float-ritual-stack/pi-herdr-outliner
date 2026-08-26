#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${HOME}/Applications/Pi Outliner Link.app"
CONFIG_PATH="${HOME}/Library/Application Support/PiOutlinerLink/config.json"
PURGE_CONFIG=0
BUNDLE_ID="dev.floatritual.pi-outliner-link"

usage() {
  cat <<'USAGE'
Usage: ./uninstall.sh [--app-dir PATH] [--purge-config]

Remove the Pi Outliner Link application. The installed bundle records its
configuration path, which is preserved unless --purge-config is supplied.
USAGE
}

while (($#)); do
  case "$1" in
    --app-dir) APP_DIR="${2:?--app-dir requires a value}"; shift 2 ;;
    --purge-config) PURGE_CONFIG=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$APP_DIR" != /* ]]; then
  APP_DIR="${PWD}/${APP_DIR}"
fi
if [[ "$APP_DIR" != *.app ]]; then
  printf 'App installation path must end in .app: %s\n' "$APP_DIR" >&2
  exit 2
fi

if [[ -e "$APP_DIR" ]]; then
  if [[ -L "$APP_DIR" ]]; then
    printf 'Refusing to remove a symbolic-link app path: %s\n' "$APP_DIR" >&2
    exit 2
  fi
  if ! command -v plutil >/dev/null 2>&1; then
    printf 'Required command not found: plutil\n' >&2
    exit 1
  fi
  EXISTING_PLIST="${APP_DIR}/Contents/Info.plist"
  EXISTING_ID="$(plutil -extract CFBundleIdentifier raw -o - "$EXISTING_PLIST" 2>/dev/null || true)"
  if [[ "$EXISTING_ID" != "$BUNDLE_ID" ]]; then
    printf 'Refusing to remove app with bundle id %s: %s\n' "${EXISTING_ID:-<missing>}" "$APP_DIR" >&2
    exit 2
  fi
fi

BUNDLE_PLIST="${APP_DIR}/Contents/Info.plist"
if [[ -f "$BUNDLE_PLIST" ]] && command -v plutil >/dev/null 2>&1; then
  BUNDLED_CONFIG_PATH="$(plutil -extract PiOutlinerLinkConfigPath raw -o - "$BUNDLE_PLIST" 2>/dev/null || true)"
  if [[ -n "$BUNDLED_CONFIG_PATH" ]]; then
    CONFIG_PATH="$BUNDLED_CONFIG_PATH"
  fi
fi

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" && -d "$APP_DIR" ]]; then
  "$LSREGISTER" -u "$APP_DIR" >/dev/null 2>&1 || true
fi
rm -rf -- "$APP_DIR"
if [[ "$PURGE_CONFIG" == 1 ]]; then
  rm -f -- "$CONFIG_PATH"
  rmdir -- "$(dirname -- "$CONFIG_PATH")" >/dev/null 2>&1 || true
fi
printf 'Removed: %s\n' "$APP_DIR"
if [[ "$PURGE_CONFIG" == 0 ]]; then
  printf 'Preserved configuration: %s\n' "$CONFIG_PATH"
fi
