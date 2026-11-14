#!/usr/bin/env bash
# Launch the Verity TUI from any cwd. Forwards args and the child's exit code.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for PY in python py python3; do
  if command -v "$PY" >/dev/null 2>&1; then
    "$PY" "$HERE/tui.py" "$@"
    exit $?
  fi
done

echo "tui.sh: no python interpreter found on PATH" >&2
exit 1
