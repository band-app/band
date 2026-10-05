#!/bin/sh
set -eu

# Band server container entrypoint. Seeds a known access token (production
# auth enforces the band_token cookie), configures git for bind-mounted
# repos, provisions a ready-to-use sample repo, prints the access URL,
# then runs the server (auto-registering the sample once it's up).

BAND_DIR="$HOME/.band"
mkdir -p "$BAND_DIR"

# The hub owns the admin token: BAND_ADMIN_TOKEN sets it, and a first run with
# none mints one and prints it once (BAND_PRINT_ADMIN_TOKEN). BAND_ACCESS_TOKEN
# is the older name for BAND_ADMIN_TOKEN.
if [ -z "${BAND_ADMIN_TOKEN:-}" ] && [ -n "${BAND_ACCESS_TOKEN:-}" ]; then
  export BAND_ADMIN_TOKEN="$BAND_ACCESS_TOKEN"
fi
export BAND_PRINT_ADMIN_TOKEN=true

# git needs an identity for worktree/commit operations and must trust
# bind-mounted repos owned by a different uid than the container user.
git config --global --add safe.directory '*' >/dev/null 2>&1 || true
git config --global user.email "band@localhost" >/dev/null 2>&1 || true
git config --global user.name "Band" >/dev/null 2>&1 || true
git config --global init.defaultBranch main >/dev/null 2>&1 || true

# A ready-to-use sample repo on the persisted volume. A registered repo
# whose directory doesn't exist on disk fails to spawn terminals, so we always
# provide at least one valid one.
# With BAND_LOCAL_HOST=off (the image default) worktrees run on workers, so the
# sample repo would land in the container and is skipped.
export BAND_LOCAL_HOST="${BAND_LOCAL_HOST:-off}"
SAMPLE="$HOME/repos/sample"
LOCAL_WORKTREES=true
case "$(printf '%s' "$BAND_LOCAL_HOST" | tr '[:upper:]' '[:lower:]')" in
  off|false|0) LOCAL_WORKTREES=false ;;
esac
if [ "$LOCAL_WORKTREES" = true ] && [ ! -d "$SAMPLE/.git" ]; then
  mkdir -p "$SAMPLE"
  ( cd "$SAMPLE" \
    && git init -q \
    && printf '# Sample repo\n\nCreated by the Band Linux test container.\n' > README.md \
    && git add -A && git commit -qm "init" ) >/dev/null 2>&1 || true
fi

HOST_PORT="${BAND_HOST_PORT:-$PORT}"

echo "──────────────────────────────────────────────────────────────"
echo " Band hub listening on container port ${PORT}"
echo " Open:  http://localhost:${HOST_PORT}/ (sign in with the admin token)"
echo " State: ${BAND_DIR} (mounted volume)"
if [ "$LOCAL_WORKTREES" = true ]; then
  echo " Sample repo: ${SAMPLE} (auto-registered once the server is up)"
else
  echo " Local worktrees are off (BAND_LOCAL_HOST=off): add a worker to run worktrees"
fi
echo "──────────────────────────────────────────────────────────────"

# Run the server in the background so we can register the sample repo once
# it answers, while forwarding termination signals for a clean shutdown.
term() { kill -TERM "$SERVER_PID" 2>/dev/null || true; }
trap term TERM INT
node dist/start-server.mjs &
SERVER_PID=$!

# Register the sample repo once the server responds (idempotent, non-fatal).
# `band repos list` doubles as the readiness probe — it talks to the local
# server using the token from settings.json.
if [ "$LOCAL_WORKTREES" = true ]; then
(
  i=0
  while [ "$i" -lt 40 ]; do
    if band repos list >/dev/null 2>&1; then
      band repos add "$SAMPLE" >/dev/null 2>&1 || true
      break
    fi
    i=$((i + 1))
    sleep 0.5
  done
) &
fi

wait "$SERVER_PID"
