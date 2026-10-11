#!/bin/sh
# Fails when production code builds a worktree id by hand. A worktree id names a host as well as a
# repo and a branch, and `toWorktreeId` (packages/shared/src/worktree-id.ts) is the only function
# that makes one. Tests and the SQL twin in the worktree queries are the only other places.
set -eu
cd "$(dirname "$0")/.."

dirs="apps/hub/src apps/web/src apps/desktop/src apps/worker/src packages/*/src plugins/*/src"
status=0

check() {
  pattern="$1"
  message="$2"
  # shellcheck disable=SC2086
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' "$pattern" $dirs 2>/dev/null \
    | grep -v 'packages/shared/src/worktree-id.ts' \
    | grep -v 'apps/hub/src/server/infra/db/queries/worktrees.ts' \
    | grep -v '/migrations/' \
    | grep -vE ':[0-9]+:[[:space:]]*(\*|//)' || true)
  if [ -n "$hits" ]; then
    echo "$message"
    echo "$hits"
    status=1
  fi
}

check "\\$\\{[A-Za-z_.]*[rR]epo[A-Za-z_.]*\\}-\\$\\{[A-Za-z_.]*([bB]ranch|[nN]ame)" \
  "Worktree id built from a repo and a branch by hand. Use toWorktreeId(repo, name, hostId)."
check "[rR]epo_?[nN]ame[^|]*\\|\\| '-' \\|\\|" \
  "Worktree id built in SQL outside the worktree queries. Use WORKTREE_ID_MATCH."
check "[bB]ranch\\.replaceAll\\(\"/\", \"-\"\\)" \
  "A branch turned into an id segment by hand. Use toWorktreeId(repo, name, hostId)."

if [ "$status" -ne 0 ]; then
  echo "See packages/shared/src/worktree-id.ts."
fi
exit "$status"
