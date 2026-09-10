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

printf '%s\n' \
  'Pi Outliner requires Bun 1.3 or newer. Install it from https://bun.sh and retry.' >&2
exit 127
