#!/usr/bin/env bash
# Installs the Playwright system packages (Linux, apt) and then the browsers.
# Usage: scripts/ci/install-playwright.sh "<browsers>"
#
# `playwright install --with-deps` runs `sudo apt-get` as a child. A timeout
# that kills the user's process group cannot signal root's apt, so a stalled
# apt kept the dpkg lock and every retry failed with exit code 100. Installing
# ~180 packages legitimately takes several minutes, so apt gets no cap that
# could stop it while it works: apt's own network timeout, retries and dpkg lock
# wait handle stalls. A failed attempt is followed by clearing leftovers and a
# dpkg repair. APT_TIMEOUT_SECONDS (default 0, off) adds an outer cap that
# runs apt as root so the whole group can be stopped. Only the browser
# download has a default cap, and it is generous.
#
# Run 42167062165 showed a third failure: the runner's mirror
# (azure.archive.ubuntu.com) delivered ~1 package a minute, so apt kept
# "working" past the 20 minute step limit. The download therefore runs as its
# own phase (`apt-get install --download-only`), capped per attempt. Finished
# .deb files stay in /var/cache/apt/archives, so a capped attempt loses nothing,
# and a retry switches to archive.ubuntu.com. The install phase then runs from
# the cache with no cap. APT_DOWNLOAD_TIMEOUT_SECONDS sets the cap (default 300).
set -uo pipefail

browsers=${1:?usage: install-playwright.sh "<browsers>"}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
with_timeout=${WITH_TIMEOUT_SCRIPT:-$here/../with-timeout.mjs}
playwright=${PLAYWRIGHT_CMD:-"pnpm --filter @band-app/web exec playwright"}
sudo_cmd=${SUDO-sudo}
apt_timeout=${APT_TIMEOUT_SECONDS:-0}
apt_attempts=${APT_ATTEMPTS:-3}
download_timeout=${APT_DOWNLOAD_TIMEOUT_SECONDS:-300}
apt_sources=${APT_SOURCES_FILES:-"/etc/apt/sources.list /etc/apt/sources.list.d/*"}
browser_timeout=${BROWSER_TIMEOUT_SECONDS:-1200}
browser_attempts=${BROWSER_ATTEMPTS:-3}
backoff=${INSTALL_BACKOFF_SECONDS:-10}
lock_files=${DPKG_LOCK_FILES:-"/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock"}
apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120)

# Stops what a stalled attempt left behind, then repairs a half-done dpkg run.
clear_apt() {
  for lock in $lock_files; do
    [ -e "$lock" ] && $sudo_cmd fuser -k -9 "$lock" >/dev/null 2>&1
  done
  $sudo_cmd env "PATH=$PATH" dpkg --configure -a || true
}

# A slow mirror is the likeliest reason for a capped download, so retry elsewhere.
switch_mirror() {
  local f
  for f in $apt_sources; do
    [ -f "$f" ] && $sudo_cmd sed -i.bak 's#//azure\.archive\.ubuntu\.com#//archive.ubuntu.com#g' "$f"
  done
  $sudo_cmd env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive apt-get "${apt_opts[@]}" update || true
}

retry_download() {
  clear_apt
  switch_mirror
}

# run_attempts <label> <attempts> <seconds> <before-retry function or ""> <as-root 0|1> <command...>
run_attempts() {
  local label=$1 attempts=$2 seconds=$3 before_retry=$4 as_root=$5
  shift 5
  local attempt status=0
  for attempt in $(seq 1 "$attempts"); do
    echo "$label attempt $attempt of $attempts (limit ${seconds}s, 0 is none): $*"
    status=0
    if [ "$seconds" = 0 ]; then
      if [ "$as_root" = 1 ]; then $sudo_cmd env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive "$@" || status=$?; else "$@" || status=$?; fi
    elif [ "$as_root" = 1 ]; then
      $sudo_cmd env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive node "$with_timeout" "$seconds" "$@" || status=$?
    else
      node "$with_timeout" "$seconds" "$@" || status=$?
    fi
    [ "$status" -eq 0 ] && return 0
    if [ "$status" -eq 124 ]; then
      echo "::warning::$label attempt $attempt stalled and was stopped after ${seconds}s"
    else
      echo "::warning::$label attempt $attempt failed with exit code $status"
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      [ -n "$before_retry" ] && "$before_retry"
      sleep $((attempt * backoff))
    fi
  done
  echo "::error::$label failed after $attempts attempts (last exit code $status; 124 means it stalled)"
  return 1
}

install_system_deps() {
  # The package list comes from Playwright, so it follows the version in use.
  local plan packages
  # shellcheck disable=SC2086
  plan=$($playwright install-deps --dry-run $browsers 2>/dev/null) || plan=""
  packages=$(printf '%s\n' "$plan" | grep -o 'apt-get install.*' | head -n 1 | sed -E "s/^apt-get install//; s/[\"']//g; s/(^| )-[-a-zA-Z]+//g")
  if [ -z "$packages" ]; then
    echo "::error::Could not read the system package list from 'playwright install-deps --dry-run'"
    return 1
  fi
  run_attempts "Playwright apt update" "$apt_attempts" "$apt_timeout" clear_apt 1 apt-get "${apt_opts[@]}" update || return 1
  # shellcheck disable=SC2086
  run_attempts "Playwright apt download" "$apt_attempts" "$download_timeout" retry_download 1 \
    apt-get "${apt_opts[@]}" install -y --no-install-recommends --download-only $packages || return 1
  # shellcheck disable=SC2086
  run_attempts "Playwright apt install" "$apt_attempts" "$apt_timeout" clear_apt 1 \
    apt-get "${apt_opts[@]}" install -y --no-install-recommends $packages
}

if [ "$(uname -s)" = Linux ] || [ -n "${FORCE_APT:-}" ]; then
  install_system_deps || exit 1
fi

# shellcheck disable=SC2086
run_attempts "Playwright browser download" "$browser_attempts" "$browser_timeout" "" 0 \
  $playwright install $browsers
