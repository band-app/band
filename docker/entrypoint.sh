#!/bin/sh
set -eu

# Band server container entrypoint. Seeds a known access token (production
# auth enforces the band_token cookie), configures git for bind-mounted
# repos, provisions a ready-to-use sample project, prints the access URL,
# then runs the server (auto-registering the sample once it's up).

BAND_DIR="$HOME/.band"
mkdir -p "$BAND_DIR"

# getOrCreateToken() keeps an existing tokenSecret, so we only seed one on
# first boot. Visiting /?token=<secret> sets the cookie for the session.
if [ ! -f "$BAND_DIR/settings.json" ]; then
  printf '{\n  "tokenSecret": "%s"\n}\n' "$BAND_ACCESS_TOKEN" > "$BAND_DIR/settings.json"
fi

# git needs an identity for worktree/commit operations and must trust
# bind-mounted repos owned by a different uid than the container user.
git config --global --add safe.directory '*' >/dev/null 2>&1 || true
git config --global user.email "band@localhost" >/dev/null 2>&1 || true
git config --global user.name "Band" >/dev/null 2>&1 || true
git config --global init.defaultBranch main >/dev/null 2>&1 || true

# A ready-to-use sample project on the persisted volume. A registered project
# whose directory doesn't exist on disk fails to spawn terminals, so we always
# provide at least one valid one.
SAMPLE="$HOME/projects/sample"
if [ ! -d "$SAMPLE/.git" ]; then
  mkdir -p "$SAMPLE"
  ( cd "$SAMPLE" \
    && git init -q \
    && printf '# Sample project\n\nCreated by the Band Linux test container.\n' > README.md \
    && git add -A && git commit -qm "init" ) >/dev/null 2>&1 || true
fi

TOKEN="$(node -e "process.stdout.write(require('$BAND_DIR/settings.json').tokenSecret || '')" 2>/dev/null || echo "$BAND_ACCESS_TOKEN")"
HOST_PORT="${BAND_HOST_PORT:-$PORT}"

echo "──────────────────────────────────────────────────────────────"
echo " Band server (Linux standalone) listening on container port ${PORT}"
echo " Open:  http://localhost:${HOST_PORT}/?token=${TOKEN}"
echo " State: ${BAND_DIR} (mounted volume)"
echo " Sample project: ${SAMPLE} (auto-registered once the server is up)"
echo "──────────────────────────────────────────────────────────────"

# Run the server in the background so we can register the sample project once
# it answers, while forwarding termination signals for a clean shutdown.
term() { kill -TERM "$SERVER_PID" 2>/dev/null || true; }
trap term TERM INT
node dist/start-server.mjs &
SERVER_PID=$!

# Register the sample project once the server responds (idempotent, non-fatal).
# `band projects list` doubles as the readiness probe — it talks to the local
# server using the token from settings.json.
(
  i=0
  while [ "$i" -lt 40 ]; do
    if band projects list >/dev/null 2>&1; then
      band projects add "$SAMPLE" >/dev/null 2>&1 || true
      break
    fi
    i=$((i + 1))
    sleep 0.5
  done
) &

wait "$SERVER_PID"
