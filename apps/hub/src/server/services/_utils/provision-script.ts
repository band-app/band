/**
 * The shell script behind `curl -fsSL https://<hub>/api/provision/<code>/script | sh`.
 *
 * It holds no secret. The code is the one in its own URL, and the script trades it at
 * `POST /api/provision/exchange` for a worker bootstrap token, which it keeps in memory and in
 * the environment of the commands it starts, never on a command line. Everything it prints goes
 * to the hub as well (`POST /api/provision/<code>/log`), where tokens are removed again.
 *
 * POSIX `sh`, Linux and macOS. In this file `\${` is a shell parameter expansion.
 */

/** Quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const TEMPLATE = `#!/bin/sh
# Band host provisioning. This script holds no secret: it trades the one-time code below for a
# worker token at the hub. Read it before you run it.
set -eu

main() {
HUB_URL=@@HUB_URL@@
CODE=@@CODE@@
WORKER_VERSION=@@WORKER_VERSION@@
NODE_MAJOR=24

fail() {
  printf 'band provision: %s\\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=macos ;;
  *) fail "unsupported system $(uname -s). Band provisioning supports Linux and macOS." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "unsupported architecture $(uname -m). Band provisioning supports x86_64 and arm64." ;;
esac
for tool in curl tar sed wc; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required and was not found"
done

WORK="$(mktemp -d "\${TMPDIR:-/tmp}/band-provision.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LOG="$WORK/provision.log"
CHUNK="$WORK/chunk"
: >"$LOG"

# POST a file to the hub with the run token. The token goes to curl on stdin, not argv.
hub_post() {
  printf 'header = "Authorization: Bearer %s"\\n' "$RUN_TOKEN" |
    curl -fsS -K - -X POST -H 'Content-Type: text/plain' --data-binary "@$2" -o /dev/null "$1"
}

hub_get() {
  printf 'header = "Authorization: Bearer %s"\\n' "$RUN_TOKEN" |
    curl -fsS -K - -o "$2" "$1"
}

EXCHANGE="$WORK/exchange"
if ! curl -fsS -X POST -H 'Content-Type: application/json' \\
  --data "{\\"code\\":\\"$CODE\\"}" -o "$EXCHANGE" "$HUB_URL/api/provision/exchange"; then
  fail "the hub refused this command. It was already used or has expired. Create a new one in Settings > Hosts."
fi
TOKEN=""
WORKER_ID=""
RUN_TOKEN=""
BUNDLE=0
START_COMMAND=""
HOST_NAME=""
LABELS=""
while IFS='=' read -r key value; do
  case "$key" in
    token) TOKEN="$value" ;;
    workerId) WORKER_ID="$value" ;;
    runToken) RUN_TOKEN="$value" ;;
    bundle) BUNDLE="$value" ;;
    command) START_COMMAND="$value" ;;
    name) HOST_NAME="$value" ;;
    labels) LABELS="$value" ;;
  esac
done <"$EXCHANGE"
rm -f "$EXCHANGE"
if [ -z "$TOKEN" ] || [ -z "$WORKER_ID" ] || [ -z "$RUN_TOKEN" ]; then
  fail "the hub's answer was incomplete"
fi

say() { printf '%s\\n' "$*"; }

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$have" -ge "$NODE_MAJOR" ] 2>/dev/null; then
      say "Using Node $(node -v) from $(command -v node)"
      return 0
    fi
  fi
  MISE="$(command -v mise 2>/dev/null || true)"
  if [ -z "$MISE" ]; then
    say "Installing mise"
    curl -fsSL https://mise.run | sh
    MISE="$HOME/.local/bin/mise"
  fi
  say "Installing Node $NODE_MAJOR with mise"
  "$MISE" install "node@$NODE_MAJOR"
  "$MISE" use --global "node@$NODE_MAJOR"
  PATH="$("$MISE" where "node@$NODE_MAJOR")/bin:$PATH"
  export PATH
}

install_worker() {
  if [ -n "\${BAND_WORKER_CMD:-}" ]; then
    WORKER="$BAND_WORKER_CMD"
    say "Using the worker from BAND_WORKER_CMD"
    return 0
  fi
  ensure_node
  PREFIX="$HOME/.band/npm"
  say "Installing @band-app/worker\${WORKER_VERSION:+@$WORKER_VERSION}"
  npm install --global --prefix "$PREFIX" "@band-app/worker\${WORKER_VERSION:+@$WORKER_VERSION}"
  WORKER="$PREFIX/bin/band-worker"
}

root_steps() {
  [ "$OS" = linux ] || return 0
  if [ "\${BAND_PROVISION_ROOT_STEPS:-on}" = off ]; then
    say "Skipping the steps that need root (BAND_PROVISION_ROOT_STEPS=off)."
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
    say "Skipping the steps that need root: sudo is not available without a password."
    say "Run 'loginctl enable-linger $(id -un)' as root so the worker survives logout, and check 'band-worker doctor'."
    return 0
  fi
  say "Enabling lingering for $(id -un)"
  sudo -n loginctl enable-linger "$(id -un)" || say "loginctl enable-linger failed"
  # shellcheck disable=SC2086
  $WORKER doctor 2>&1 | sed -n 's/^ *fix: //p' | while IFS= read -r fix; do
    say "+ $fix"
    sh -c "$fix" </dev/null || say "that step failed"
  done || true
}

default_install() {
  say "No provisioning repo: installing the worker."
  install_worker
  export BAND_HUB_URL="$HUB_URL" BAND_WORKER_TOKEN="$TOKEN"
  # shellcheck disable=SC2086
  $WORKER install-service --worker-id "$WORKER_ID" \${HOST_NAME:+--name "$HOST_NAME"} \${LABELS:+--labels "$LABELS"}
  root_steps
}

custom_install() {
  DEST="\${BAND_PROVISION_HOME:-$HOME/.band/provision}"
  rm -rf "$DEST/repo"
  mkdir -p "$DEST/repo"
  say "Downloading the provisioning repo"
  hub_get "$HUB_URL/api/provision/$CODE/bundle" "$WORK/bundle.tgz"
  tar -xzf "$WORK/bundle.tgz" -C "$DEST/repo"
  [ -f "$DEST/repo/$START_COMMAND" ] || fail "the provisioning repo has no $START_COMMAND"
  chmod u+x "$DEST/repo/$START_COMMAND"
  export BAND_HUB_URL="$HUB_URL" BAND_BOOTSTRAP_TOKEN="$TOKEN" BAND_WORKER_ID="$WORKER_ID"
  export BAND_HOST_LABELS="$LABELS" BAND_PROVISION_DIR="$DEST/repo"
  say "Running $START_COMMAND"
  cd "$DEST/repo"
  "./$START_COMMAND"
}

steps() {
  say "Provisioning $OS $ARCH as $(id -un) for host $WORKER_ID"
  if [ "$BUNDLE" = 1 ]; then custom_install; else default_install; fi
  say "Done. The worker should appear online in Settings > Hosts."
}

SENT=0
upload() {
  if [ "$1" = final ]; then
    sed -n "$((SENT + 1)),\\$p" "$LOG" >"$CHUNK"
  else
    total="$(wc -l <"$LOG" | tr -d ' ')"
    sed -n "$((SENT + 1)),\${total}p" "$LOG" >"$CHUNK"
    SENT="$total"
  fi
  if [ -s "$CHUNK" ]; then
    cat "$CHUNK"
    hub_post "$HUB_URL/api/provision/$CODE/log" "$CHUNK" || true
  fi
}

( set -eu; steps ) >"$LOG" 2>&1 </dev/null &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$WORK"; exit 130' INT TERM
while kill -0 "$pid" 2>/dev/null; do
  upload partial
  sleep 1
done
status=0
wait "$pid" || status=$?
trap 'rm -rf "$WORK"' EXIT
upload final
: >"$CHUNK"
hub_post "$HUB_URL/api/provision/$CODE/log?exit=$status" "$CHUNK" || true
exit "$status"
}

main "$@"
`;

/** The script for one code. `workerVersion` is empty for an unreleased hub, which installs the latest worker. */
export function renderProvisionScript(opts: {
  hubUrl: string;
  code: string;
  workerVersion: string;
}): string {
  return TEMPLATE.replace("@@HUB_URL@@", () => shellQuote(opts.hubUrl))
    .replace("@@CODE@@", () => shellQuote(opts.code))
    .replace("@@WORKER_VERSION@@", () => shellQuote(opts.workerVersion));
}
