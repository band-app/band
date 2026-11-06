#!/usr/bin/env bash
# Decides which macOS CI jobs a change needs. Prints `name=value` lines, which
# the `macos-changes` job appends to $GITHUB_OUTPUT.
#
# Inputs (environment):
#   EVENT_NAME  pull_request | merge_group | push | schedule | workflow_dispatch
#   BASE, HEAD  commits to diff (three-dot, so only this branch's changes count)
#   CHANGED_FILES  optional path to a file listing changed paths, one per line.
#                  Tests use it. When set, BASE and HEAD are not read.
#
# Outputs: cli, macos-machine, desktop, desktop-package, mobile,
# docker, full-suite.
#   - A push to main starts no macOS job: the merge queue tested that commit.
#   - A scheduled or manual run starts every job in full.
#   - A change to the workflow file starts every job. It runs the heavy
#     jobs too (`full-suite`), because an edit there can break any of them.
#   - Any doubt about the diff base starts every job (fail open).
set -euo pipefail

OUTPUTS=(cli macos-machine desktop desktop-package mobile docker full-suite)

emit_all() {
  local value="$1" name
  for name in "${OUTPUTS[@]}"; do echo "$name=$value"; done
  exit 0
}

EVENT_NAME="${EVENT_NAME:-}"
case "$EVENT_NAME" in
  push) emit_all false ;;
  schedule | workflow_dispatch) emit_all true ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -n "${CHANGED_FILES:-}" ]; then
  CHANGED="$(cat "$CHANGED_FILES")"
else
  BASE="${BASE:-}"
  HEAD="${HEAD:-}"
  if [ -z "$BASE" ] || [ -z "$HEAD" ] || [ "$BASE" = "0000000000000000000000000000000000000000" ]; then
    emit_all true
  fi
  # `fetch-depth: 0` normally has $BASE already. This covers a force-pushed base.
  git fetch --no-tags --depth=1 origin "$BASE" 2>/dev/null || true
  if ! CHANGED="$(git diff --name-only "$BASE...$HEAD" 2>/dev/null)"; then
    emit_all true
  fi
fi

if [ -z "$CHANGED" ]; then
  emit_all true
fi

WORKFLOW='\.github/workflows/ci\.yml$|scripts/ci/macos-changes\.sh$'

# Here-strings, not pipes: under pipefail, `grep -q` exiting early would fail
# the pipe on a big diff.
matches() { grep -qE "$1" <<< "$CHANGED"; }

emit() {
  if matches "$2"; then echo "$1=true"; else echo "$1=false"; fi
}

if matches "^($WORKFLOW)"; then
  # Nothing but the full-suite flag differs from a scheduled run.
  emit_all true
fi

# CLI: the CLI and its tests, plus the two server files behind the macOS-only
# worktree path reconciliation bug (/var/folders vs /private/var/folders).
emit cli '^(apps/cli/|apps/hub/src/server/services/(sync-service|worktree-service)\.ts$|apps/hub/src/server/infra/db/queries/worktrees\.ts$)'

# Desktop: the Electron app, the bundled worker, the direct path and the UI
# files that talk to Electron.
emit desktop '^(apps/desktop/|electron-builder\.yml$|apps/worker/scripts/build-desktop\.mjs$|apps/worker/src/(direct|service)|apps/worker/src/chats/|packages/worktree-ops/|apps/web/src/lib/(direct-|desktop-ipc|hub-config)|apps/web/e2e-desktop/|apps/web/playwright\.desktop\.config|pnpm-lock\.yaml$)'

# Packaging: what electron-builder and the bundled worker are built from.
emit desktop-package '^(apps/desktop/|electron-builder\.yml$|apps/worker/scripts/|pnpm-lock\.yaml$)'

# Mobile: the Expo app and the packages it imports.
emit mobile '^(apps/mobile/|packages/client/|packages/shared/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.nvmrc$)'

# Docker (Linux, but gated here): the image builds every app.
emit docker '^(docker/|deploy/|runners/|\.dockerignore$|apps/|packages/|plugins/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.nvmrc$)'

# Machine: code whose behaviour differs on macOS (terminals, PTYs, daemons,
# the worker's service, agents and update code), and the hub tests that cover
# it, listed in macos-hub-tests.txt.
HUB_TESTS="$(grep -vE '^(#|$)' "$ROOT/scripts/ci/macos-hub-tests.txt" | sed 's|^|apps/hub/|' | sed 's|\.|\\.|g' | paste -sd'|' -)"
emit macos-machine "^(packages/host-local/|packages/worker-local/|packages/link/|apps/worker/src/(service|terminals|agents|update|lease|terminal-daemon|agent-daemon)|scripts/ci/macos-hub-tests\.txt$|pnpm-lock\.yaml$|\.nvmrc$|$HUB_TESTS)"

echo "full-suite=false"
