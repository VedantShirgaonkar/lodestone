#!/bin/sh
# Fake claude binary for testing
# Records arguments and environment variables to a file
# Supports scripted stdout and exit codes via env vars

# Answer version probes first (doctor uses this) — before any log gating
for arg in "$@"; do
  if [ "$arg" = "--version" ] || [ "$arg" = "-v" ]; then
    echo "${FAKE_CLAUDE_VERSION:-2.1.206 (Claude Code)}"
    exit 0
  fi
done

if [ -z "$LODESTONE_FAKE_CLAUDE_LOG" ]; then
  exit 0
fi

{
  echo "=== argv ==="
  for arg in "$@"; do
    echo "$arg"
  done
  echo "=== env ==="
  env | sort
  echo "=== time ==="
  date -u +%s
} >> "$LODESTONE_FAKE_CLAUDE_LOG"

# Output stdout if specified
if [ -n "$FAKE_CLAUDE_STDOUT" ]; then
  echo "$FAKE_CLAUDE_STDOUT"
fi

# Output stderr if specified
if [ -n "$FAKE_CLAUDE_STDERR" ]; then
  echo "$FAKE_CLAUDE_STDERR" >&2
fi

# Output file contents if specified
if [ -n "$FAKE_CLAUDE_STDOUT_FILE" ] && [ -f "$FAKE_CLAUDE_STDOUT_FILE" ]; then
  cat "$FAKE_CLAUDE_STDOUT_FILE"
fi

# Exit with specified code (default 0)
exit "${FAKE_CLAUDE_EXIT_CODE:-0}"
