#!/bin/sh
set -eu

PLUGIN_ID="float.pi-outliner"
PLUGIN_SOURCE="${PI_OUTLINER_PLUGIN_SOURCE:-float-ritual-stack/pi-herdr-outliner}"
INSTALLER_SCHEMA="1"
MIN_BUN_VERSION="1.3.0"
MIN_HERDR_VERSION="0.9.0"
DEFAULT_OPEN_KEY="prefix+u"
DEFAULT_COMMENT_KEY="prefix+shift+c"
OPEN_ACTION="$PLUGIN_ID.open-here"
COMMENT_ACTION="$PLUGIN_ID.comment-selection"
SUPPORTED_EXTRA_OPEN_ACTION="$PLUGIN_ID.open"
SUPPORTED_ENSURE_DETAIL_ACTION="$PLUGIN_ID.ensure-detail"
CONFIG_PATH="${HERDR_CONFIG_PATH:-${XDG_CONFIG_HOME:-${HOME:-}/.config}/herdr/config.toml}"
PLUGIN_REF="main"
OPEN_KEY=""
COMMENT_KEY=""
ASSUME_YES=0
CONFIGURE_KEYS=1
TEMP_CONFIG=""

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'pi-herdr-outliner installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Options:
  --open-key CHORD       Herdr key for a new Tree + Detail (default: prefix+u)
  --comment-key CHORD    Herdr key for commenting on retained selection
                         (default: prefix+shift+c)
  --ref REF              Git ref to install (default: main)
  --config PATH          Herdr config.toml path
  --no-config            Install the plugin without changing Herdr keys
  -y, --yes              Install missing dependencies and accept defaults
  -h, --help             Show this help

Environment:
  HERDR_CONFIG_PATH              Herdr config path, when --config is omitted
  PI_OUTLINER_PLUGIN_SOURCE      GitHub owner/repo override for testing
USAGE
}

cleanup() {
  if [ -n "$TEMP_CONFIG" ] && [ -f "$TEMP_CONFIG" ]; then
    rm -f "$TEMP_CONFIG"
  fi
}
trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --open-key)
      [ "$#" -ge 2 ] || fail "--open-key requires a chord"
      OPEN_KEY=$2
      shift 2
      ;;
    --comment-key)
      [ "$#" -ge 2 ] || fail "--comment-key requires a chord"
      COMMENT_KEY=$2
      shift 2
      ;;
    --ref)
      [ "$#" -ge 2 ] || fail "--ref requires a Git ref"
      PLUGIN_REF=$2
      shift 2
      ;;
    --config)
      [ "$#" -ge 2 ] || fail "--config requires a path"
      CONFIG_PATH=$2
      shift 2
      ;;
    --no-config)
      CONFIGURE_KEYS=0
      shift
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ -n "${HOME:-}" ] || fail "HOME is required"
PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$HOME/.local/bin:$PATH"
export PATH

can_prompt() {
  [ "$ASSUME_YES" -eq 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ]
}

confirm() {
  if [ "$ASSUME_YES" -eq 1 ]; then
    return 0
  fi
  if ! can_prompt; then
    return 1
  fi
  printf '%s [y/N] ' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || return 1
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

command_version() {
  "$1" --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9.]*\).*/\1/p' | sed -n '1p'
}

version_at_least() {
  awk -v actual="$1" -v required="$2" 'BEGIN {
    split(actual, a, "."); split(required, r, ".");
    for (i = 1; i <= 3; i++) {
      av = (a[i] == "" ? 0 : a[i]) + 0;
      rv = (r[i] == "" ? 0 : r[i]) + 0;
      if (av > rv) exit 0;
      if (av < rv) exit 1;
    }
    exit 0;
  }'
}

install_bun() {
  command -v curl >/dev/null 2>&1 || fail "curl is required to install Bun"
  curl -fsSL https://bun.sh/install | sh
  PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
  export PATH
}

install_herdr() {
  command -v curl >/dev/null 2>&1 || fail "curl is required to install Herdr"
  curl -fsSL https://herdr.dev/install.sh | sh
  PATH="$HOME/.local/bin:$PATH"
  export PATH
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "install $1 as root, then rerun this installer"
  fi
}

install_git() {
  if command -v brew >/dev/null 2>&1; then
    brew install git
  elif command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update
    run_privileged apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y git
  elif command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y git
  elif command -v apk >/dev/null 2>&1; then
    run_privileged apk add git
  elif command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --needed git
  else
    fail "Git is missing and no supported package manager was found"
  fi
}

ensure_command() {
  dependency_name=$1
  command_name=$2
  minimum_version=$3
  installer_function=$4
  if command -v "$command_name" >/dev/null 2>&1; then
    installed_version=$(command_version "$command_name")
    if [ -n "$installed_version" ] && version_at_least "$installed_version" "$minimum_version"; then
      say "$dependency_name $installed_version found"
      return
    fi
    reason="$dependency_name $installed_version is older than $minimum_version"
  else
    reason="$dependency_name is not installed"
  fi
  if confirm "$reason. Install or update it now?"; then
    "$installer_function"
  else
    fail "$reason"
  fi
  command -v "$command_name" >/dev/null 2>&1 || fail "$dependency_name installation did not expose $command_name on PATH"
  installed_version=$(command_version "$command_name")
  [ -n "$installed_version" ] || fail "could not read the installed $dependency_name version"
  version_at_least "$installed_version" "$minimum_version" ||
    fail "$dependency_name $installed_version is older than required $minimum_version"
  say "$dependency_name $installed_version installed"
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    say "Git found"
    return
  fi
  if confirm "Git is not installed. Install it now?"; then
    install_git
  else
    fail "Git is required for a Herdr GitHub plugin install"
  fi
  command -v git >/dev/null 2>&1 || fail "Git installation did not expose git on PATH"
  say "Git installed"
}

validate_key() {
  key_name=$1
  key_value=$2
  if [ -z "$key_value" ] ||
    ! printf '%s\n' "$key_value" |
      awk '$0 !~ /[[:space:]"\\]/ && $0 ~ /^[[:print:]]+$/ { valid = 1 } END { exit !valid }'
  then
    fail "$key_name must be one printable Herdr chord without spaces, quotes, or backslashes: $key_value"
  fi
}

config_key_for_action() {
  config_file=$1
  wanted_action=$2
  [ -f "$config_file" ] || return 0
  awk -v wanted="$wanted_action" '
    function value_of(line, value, quote) {
      value = line;
      sub(/^[^=]*=[[:space:]]*/, "", value);
      quote = substr(value, 1, 1);
      if (quote == "\"") {
        value = substr(value, 2); sub(/".*/, "", value);
      } else if (quote == sprintf("%c", 39)) {
        value = substr(value, 2);
        closing = index(value, sprintf("%c", 39));
        if (closing > 0) value = substr(value, 1, closing - 1);
      }
      return value;
    }
    BEGIN { RS = "\\[\\[keys\\.command\\]\\]" }
    NR == 1 { next }
    {
      key = ""; command = "";
      count = split($0, lines, "\n");
      for (i = 1; i <= count; i++) {
        if (lines[i] ~ /^[[:space:]]*key[[:space:]]*=/) {
          key = value_of(lines[i]);
        } else if (lines[i] ~ /^[[:space:]]*command[[:space:]]*=/) {
          command = value_of(lines[i]);
        }
      }
      if (command == wanted && key != "") { print key; exit }
    }
  ' "$config_file"
}

config_owner_for_key() {
  config_file=$1
  wanted_key=$2
  [ -f "$config_file" ] || return 0
  awk \
    -v wanted="$wanted_key" \
    -v plugin="$PLUGIN_ID." \
    -v supported_open="$SUPPORTED_EXTRA_OPEN_ACTION" \
    -v supported_detail="$SUPPORTED_ENSURE_DETAIL_ACTION" '
    function value_of(line, value, quote) {
      value = line;
      sub(/^[^=]*=[[:space:]]*/, "", value);
      quote = substr(value, 1, 1);
      if (quote == "\"") {
        value = substr(value, 2); sub(/".*/, "", value);
      } else if (quote == sprintf("%c", 39)) {
        value = substr(value, 2);
        closing = index(value, sprintf("%c", 39));
        if (closing > 0) value = substr(value, 1, closing - 1);
      }
      return value;
    }
    BEGIN { RS = "\\[\\[keys\\.command\\]\\]" }
    NR == 1 { next }
    {
      key = ""; command = "";
      count = split($0, lines, "\n");
      for (i = 1; i <= count; i++) {
        if (lines[i] ~ /^[[:space:]]*key[[:space:]]*=/) {
          key = value_of(lines[i]);
        } else if (lines[i] ~ /^[[:space:]]*command[[:space:]]*=/) {
          command = value_of(lines[i]);
        }
      }
      preserved_outliner = command == supported_open || command == supported_detail;
      if (key == wanted &&
          (index(command, plugin) != 1 || preserved_outliner)) {
        print command; exit;
      }
    }
  ' "$config_file"
}

prompt_key() {
  prompt_label=$1
  prompt_default=$2
  if ! can_prompt; then
    printf '%s\n' "$prompt_default"
    return
  fi
  printf '%s [%s]: ' "$prompt_label" "$prompt_default" >/dev/tty
  IFS= read -r chosen_key </dev/tty || chosen_key=""
  printf '%s\n' "${chosen_key:-$prompt_default}"
}

choose_available_key() {
  choice_label=$1
  choice_value=$2
  while :; do
    validate_key "$choice_label" "$choice_value"
    owner=$(config_owner_for_key "$CONFIG_PATH" "$choice_value")
    if [ -z "$owner" ]; then
      printf '%s\n' "$choice_value"
      return
    fi
    if ! can_prompt; then
      fail "$choice_label $choice_value is already used by $owner; pass an alternative"
    fi
    printf '%s\n' "$choice_value is already used by $owner" >/dev/tty
    choice_value=$(prompt_key "$choice_label" "")
  done
}

rewrite_config() {
  source_file=$1
  destination_file=$2
  awk \
    -v begin="# BEGIN pi-herdr-outliner installer" \
    -v end="# END pi-herdr-outliner installer" \
    -v open_action="$OPEN_ACTION" \
    -v comment_action="$COMMENT_ACTION" \
    -v supported_open="$SUPPORTED_EXTRA_OPEN_ACTION" \
    -v supported_detail="$SUPPORTED_ENSURE_DETAIL_ACTION" '
    function command_value(line, value, quote, closing) {
      value = line;
      sub(/^[^=]*=[[:space:]]*/, "", value);
      quote = substr(value, 1, 1);
      if (quote == "\"") {
        value = substr(value, 2); sub(/".*/, "", value);
      } else if (quote == sprintf("%c", 39)) {
        value = substr(value, 2);
        closing = index(value, sprintf("%c", 39));
        if (closing > 0) value = substr(value, 1, closing - 1);
      }
      return value;
    }
    function flush_command() {
      if (!in_command) return;
      drop = command == open_action || command == comment_action;
      obsolete = index(command, "float.pi-outliner.") == 1 &&
        command != open_action && command != comment_action &&
        command != supported_open && command != supported_detail;
      if (!drop && !obsolete) printf "%s", block;
      block = ""; command = ""; in_command = 0;
    }
    index($0, begin) == 1 { flush_command(); managed = 1; next }
    managed && index($0, end) == 1 { managed = 0; next }
    managed { next }
    $0 ~ /^\[\[keys\.command\]\][[:space:]]*$/ {
      flush_command(); in_command = 1; block = $0 ORS; next;
    }
    in_command && $0 ~ /^\[/ {
      flush_command(); print; next;
    }
    in_command {
      block = block $0 ORS;
      if ($0 ~ /^[[:space:]]*command[[:space:]]*=/) command = command_value($0);
      next;
    }
    { print }
    END { flush_command() }
  ' "$source_file" > "$destination_file"
}

ensure_command "Bun" bun "$MIN_BUN_VERSION" install_bun
ensure_command "Herdr" herdr "$MIN_HERDR_VERSION" install_herdr
ensure_git

if [ "$CONFIGURE_KEYS" -eq 1 ]; then

  existing_open_key=$(config_key_for_action "$CONFIG_PATH" "$OPEN_ACTION")
  existing_comment_key=$(config_key_for_action "$CONFIG_PATH" "$COMMENT_ACTION")
  open_default=${existing_open_key:-$DEFAULT_OPEN_KEY}
  comment_default=${existing_comment_key:-$DEFAULT_COMMENT_KEY}

  if [ -z "$OPEN_KEY" ]; then
    OPEN_KEY=$(prompt_key "Open Tree + Detail key" "$open_default")
  fi
  if [ -z "$COMMENT_KEY" ]; then
    COMMENT_KEY=$(prompt_key "Comment on retained selection key" "$comment_default")
  fi
  OPEN_KEY=$(choose_available_key "Open key" "$OPEN_KEY")
  COMMENT_KEY=$(choose_available_key "Comment key" "$COMMENT_KEY")
  [ "$OPEN_KEY" != "$COMMENT_KEY" ] || fail "open and comment keys must be different"
fi

plugin_metadata=$(herdr plugin list --plugin "$PLUGIN_ID" --json 2>/dev/null || true)
compact_plugin_metadata=$(printf '%s' "$plugin_metadata" | tr -d '[:space:]')
case "$compact_plugin_metadata" in
  *'"kind":"local"'*)
    fail "$PLUGIN_ID is linked to a local checkout; run 'herdr plugin unlink $PLUGIN_ID' before replacing it with a managed install"
    ;;
  *'"version":'*)
    say "Refreshing $PLUGIN_ID from $PLUGIN_SOURCE@$PLUGIN_REF"
    ;;
  *)
    say "Installing $PLUGIN_ID from $PLUGIN_SOURCE@$PLUGIN_REF"
    ;;
esac
if ! confirm "Proceed with the managed plugin install?"; then
  fail "plugin installation cancelled"
fi
herdr plugin install "$PLUGIN_SOURCE" --ref "$PLUGIN_REF" --yes
herdr plugin action list --plugin "$PLUGIN_ID" >/dev/null

if [ "$CONFIGURE_KEYS" -eq 1 ]; then
  config_directory=$(dirname "$CONFIG_PATH")
  mkdir -p "$config_directory"
  [ -f "$CONFIG_PATH" ] || : > "$CONFIG_PATH"

  TEMP_CONFIG=$(mktemp "$CONFIG_PATH.pi-outliner.XXXXXX")
  rewrite_config "$CONFIG_PATH" "$TEMP_CONFIG"
  cat >> "$TEMP_CONFIG" <<EOF
# BEGIN pi-herdr-outliner installer v$INSTALLER_SCHEMA
[[keys.command]]
key = "$OPEN_KEY"
type = "plugin_action"
command = "$OPEN_ACTION"
description = "Open a new Outliner Tree and Detail here"

[[keys.command]]
key = "$COMMENT_KEY"
type = "plugin_action"
command = "$COMMENT_ACTION"
description = "Comment on retained Outliner Detail selection"
# END pi-herdr-outliner installer
EOF

  if cmp -s "$CONFIG_PATH" "$TEMP_CONFIG"; then
    say "Herdr key configuration is already current"
  else
    backup=$(mktemp "$CONFIG_PATH.bak.$(date +%Y%m%d%H%M%S).XXXXXX")
    cp -p "$CONFIG_PATH" "$backup"
    chmod 600 "$TEMP_CONFIG"
    mv "$TEMP_CONFIG" "$CONFIG_PATH"
    TEMP_CONFIG=""
    say "Updated $CONFIG_PATH (backup: $backup)"
    if herdr status server >/dev/null 2>&1; then
      if ! herdr server reload-config; then
        cp -p "$backup" "$CONFIG_PATH"
        herdr server reload-config >/dev/null 2>&1 || true
        fail "Herdr rejected the new config; restored $backup"
      fi
      say "Reloaded the running Herdr server configuration"
    fi
  fi
  say "Open Tree + Detail: $OPEN_KEY"
  say "Comment on retained selection: $COMMENT_KEY"
fi

say "Pi Outliner is installed. Inside Herdr, invoke $OPEN_ACTION or use the configured open key."
