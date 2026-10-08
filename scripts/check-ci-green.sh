#!/usr/bin/env bash
# Release gate: succeeds only when ci.yml has a completed, successful run on
# the exact commit being released. A re-run that succeeded counts, because the
# run's conclusion is the one of its latest attempt. A conclusion of success
# means every job in the run succeeded or was skipped.
#
# Usage: scripts/check-ci-green.sh <sha> [owner/repo]
# Needs `gh` with GH_TOKEN (or a login) that can read Actions runs.
set -euo pipefail

SHA="${1:?usage: check-ci-green.sh <sha> [owner/repo]}"
REPO="${2:-${GITHUB_REPOSITORY:-band-app/band}}"

# pull_request runs test a merge ref, not this commit, so they never count.
RUNS=$(gh api --paginate \
  "repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100" \
  --jq '.workflow_runs[] | select(.event != "pull_request") | [.id, .event, .status, (.conclusion // "none"), .html_url] | @tsv')

if [ -n "$RUNS" ]; then
  while IFS=$'\t' read -r id event status conclusion url; do
    if [ "$status" = "completed" ] && [ "$conclusion" = "success" ]; then
      echo "CI passed on ${SHA}: ci.yml run ${id} (${event}), ${url}"
      exit 0
    fi
  done <<< "$RUNS"
fi

echo "Refusing to release ${SHA}: no successful ci.yml run on this commit." >&2
if [ -z "$RUNS" ]; then
  echo "ci.yml has no push or merge_group run for it." >&2
else
  echo "ci.yml runs on this commit:" >&2
  while IFS=$'\t' read -r id event status conclusion url; do
    echo "  run ${id} (${event}): status=${status}, conclusion=${conclusion}, ${url}" >&2
  done <<< "$RUNS"
fi
echo "Wait for CI to pass, or re-run the release with force_tests=true to run the tests here." >&2
exit 1
