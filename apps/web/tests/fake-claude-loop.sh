#!/usr/bin/env bash
# Fake claude binary for loop integration tests.
#
# Protocol:
#   - Reads $FAKE_CLAUDE_OUTPUT_DIR/iteration-<N>.txt where N is a counter
#     stored in $FAKE_CLAUDE_OUTPUT_DIR/counter (starts at 0, auto-incremented).
#   - Prints the file contents to stdout and exits 0.
#   - If the per-iteration file does not exist, falls back to
#     $FAKE_CLAUDE_OUTPUT_DIR/default-output.txt.
#   - If $FAKE_CLAUDE_SLEEP is set, sleeps that many seconds before exiting
#     (useful for testing pause/stop mid-iteration).
#   - If $FAKE_CLAUDE_EXIT_CODE is set, exits with that code instead of 0.

set -euo pipefail

dir="${FAKE_CLAUDE_OUTPUT_DIR:?FAKE_CLAUDE_OUTPUT_DIR must be set}"

# Atomically read-and-increment the counter
counter_file="${dir}/counter"
if [ ! -f "$counter_file" ]; then
  echo "0" > "$counter_file"
fi

# Use flock for safe concurrent access (macOS has flock via Homebrew, but
# for CI we fall back to a simple read-increment-write which is fine because
# loop iterations are sequential).
n=$(cat "$counter_file")
echo $(( n + 1 )) > "$counter_file"

iter_file="${dir}/iteration-${n}.txt"
default_file="${dir}/default-output.txt"

if [ -f "$iter_file" ]; then
  cat "$iter_file"
elif [ -f "$default_file" ]; then
  cat "$default_file"
else
  echo "fake claude iteration ${n}"
fi

if [ -n "${FAKE_CLAUDE_SLEEP:-}" ]; then
  sleep "$FAKE_CLAUDE_SLEEP"
fi

exit "${FAKE_CLAUDE_EXIT_CODE:-0}"
