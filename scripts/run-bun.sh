#!/bin/sh
set -eu

if [ -n "${BUN_INSTALL:-}" ] && [ -x "$BUN_INSTALL/bin/bun" ]; then
  exec "$BUN_INSTALL/bin/bun" "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec "$(command -v bun)" "$@"
fi

if [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  exec "$HOME/.bun/bin/bun" "$@"
fi

# A GUI/launchd-started Herdr may have only the system PATH. Homebrew's
# standard Apple Silicon and Intel prefixes are still valid Bun installs.
for bun_candidate in /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [ -x "$bun_candidate" ]; then
    exec "$bun_candidate" "$@"
  fi
done

printf '%s\n' \
  'Pi Outliner could not find Bun. Install Bun 1.3 or newer from https://bun.sh, or set BUN_INSTALL to its installation directory.' >&2
exit 127
