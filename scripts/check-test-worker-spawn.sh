#!/usr/bin/env bash
# Tests get the band-worker entry point from one module per package, so every
# worker a test starts is covered by the process guard (scripts/test-process-guard.mjs).
# Fails on any other test file that spells out the path.
set -euo pipefail
cd "$(dirname "$0")/.."

allowed='^(apps/hub/tests/helpers/worker-bin\.ts|apps/worker/tests/helpers\.ts)$'
# Fixtures that only mention the file name: a plist, a copied source tree.
fixtures='^(apps/desktop/tests/this-computer-worker\.test\.ts|apps/hub/tests/remote-relay\.test\.ts|apps/hub/tests/runner-vm-hooks\.test\.ts|apps/hub/tests/environment-build-docker\.test\.ts|apps/worker/tests/service\.test\.ts)$'

bad=$(grep -rl "bin/band-worker\.mjs" apps/*/tests packages/*/tests 2>/dev/null | grep -Ev "$allowed|$fixtures" || true)
if [ -n "$bad" ]; then
  echo "These tests name band-worker.mjs directly. Import WORKER_BIN from tests/helpers/worker-bin (hub) or tests/helpers (worker):" >&2
  echo "$bad" >&2
  exit 1
fi
