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
#
# Run 42179615014 showed the cap alone is not enough: azure delivered ~25 of 181
# packages per 300 s attempt, so 3 attempts could never finish. The download now
# retries for as long as an attempt adds .debs to the archive, up to
# APT_DOWNLOAD_BUDGET_SECONDS in total (default 900), and stops early after an
# attempt that added none. The runner's mirror list lives in
# /etc/apt/apt-mirrors.txt (the deb822 source points at it with `mirror+file:`),
# so the mirror switch edits that file as well as sources.list and *.sources.
#
# Run 43035119746 showed that giving up after one attempt with no progress
# never reaches the mirror switch: the runners could not resolve
# azure.archive.ubuntu.com for hours, every attempt 1 downloaded nothing, and
# every job failed. An attempt with no progress now gets one retry on
# archive.ubuntu.com before the script gives up.
#
# The downloaded .debs are cached between runs. APT_DEB_CACHE_DIR names a
# runner-owned directory that actions/cache restores and saves, because
# /var/cache/apt/archives belongs to root. Before the download the script copies
# the .debs from that directory into the archive, so apt finds them, and after
# the download it copies the archive back. `--plan` prints the cache key part
# (a hash of the package list Playwright prints) and installs nothing.
set -uo pipefail

plan_only=0
if [ "${1:-}" = --plan ]; then
  plan_only=1
  shift
fi
browsers=${1:?usage: install-playwright.sh [--plan] "<browsers>"}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
with_timeout=${WITH_TIMEOUT_SCRIPT:-$here/../with-timeout.mjs}
playwright=${PLAYWRIGHT_CMD:-"pnpm --filter @band-app/web exec playwright"}
sudo_cmd=${SUDO-sudo}
apt_timeout=${APT_TIMEOUT_SECONDS:-0}
apt_attempts=${APT_ATTEMPTS:-3}
download_timeout=${APT_DOWNLOAD_TIMEOUT_SECONDS:-300}
apt_sources=${APT_SOURCES_FILES:-"/etc/apt/sources.list /etc/apt/sources.list.d/* /etc/apt/apt-mirrors.txt"}
download_budget=${APT_DOWNLOAD_BUDGET_SECONDS:-900}
archives=${APT_ARCHIVES_DIR:-/var/cache/apt/archives}
deb_cache=${APT_DEB_CACHE_DIR:-}
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

deb_count() {
  local n=0 f
  for f in "$archives"/*.deb; do
    [ -e "$f" ] && n=$((n + 1))
  done
  echo "$n"
}

# Puts the cached .debs where apt looks for them.
restore_debs() {
  [ -n "$deb_cache" ] && [ -d "$deb_cache" ] || return 0
  local f
  for f in "$deb_cache"/*.deb; do
    [ -e "$f" ] && $sudo_cmd cp -n "$f" "$archives/"
  done
  echo "Restored the cache; $(deb_count) .debs now in $archives"
}

# Copies the archive to the runner-owned directory that actions/cache saves.
save_debs() {
  [ -n "$deb_cache" ] || return 0
  # An empty folder would be saved as a cache hit and stop later runs from saving.
  [ "$(deb_count)" -gt 0 ] || return 0
  mkdir -p "$deb_cache"
  local f
  for f in "$archives"/*.deb; do
    [ -e "$f" ] && $sudo_cmd cp -n "$f" "$deb_cache/"
  done
  $sudo_cmd chown -R "$(id -u):$(id -g)" "$deb_cache" || true
}

# Prints the package list from Playwright, which follows the version in use.
read_packages() {
  local plan
  # shellcheck disable=SC2086
  plan=$($playwright install-deps --dry-run $browsers 2>/dev/null) || plan=""
  printf '%s\n' "$plan" | grep -o 'apt-get install.*' | head -n 1 | sed -E "s/^apt-get install//; s/[\"']//g; s/(^| )-[-a-zA-Z]+//g"
}

hash_text() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

# Downloads with retries while attempts make progress (more .debs in the archive).
# An attempt with no progress gets one retry on the other mirror before giving up.
download_packages() {
  local start=$SECONDS attempt=0 before after status switched=0
  while :; do
    attempt=$((attempt + 1))
    before=$(deb_count)
    echo "Playwright apt download attempt $attempt (limit ${download_timeout}s, $before .debs present): apt-get install --download-only"
    status=0
    # shellcheck disable=SC2086
    if [ "$download_timeout" = 0 ]; then
      $sudo_cmd env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive apt-get "${apt_opts[@]}" install -y --no-install-recommends --download-only $packages || status=$?
    else
      $sudo_cmd env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive node "$with_timeout" "$download_timeout" \
        apt-get "${apt_opts[@]}" install -y --no-install-recommends --download-only $packages || status=$?
    fi
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    after=$(deb_count)
    save_debs
    if [ "$after" -le "$before" ]; then
      if [ "$switched" = 0 ]; then
        echo "::warning::Playwright apt download made no progress in attempt $attempt (exit code $status, $after .debs present); retrying on archive.ubuntu.com"
        switched=1
        retry_download
        sleep "$backoff"
        continue
      fi
      echo "::error::Playwright apt download made no progress in attempt $attempt (exit code $status, $after .debs present); giving up"
      return 1
    fi
    if [ $((SECONDS - start)) -ge "$download_budget" ]; then
      echo "::error::Playwright apt download was still progressing ($before to $after .debs in attempt $attempt) but used the ${download_budget}s time budget; giving up"
      return 1
    fi
    echo "::warning::Playwright apt download attempt $attempt stopped (exit code $status) after adding $((after - before)) .debs; retrying"
    switched=1
    retry_download
    sleep "$backoff"
  done
}

install_system_deps() {
  packages=$(read_packages)
  if [ -z "$packages" ]; then
    echo "::error::Could not read the system package list from 'playwright install-deps --dry-run'"
    return 1
  fi
  restore_debs
  run_attempts "Playwright apt update" "$apt_attempts" "$apt_timeout" clear_apt 1 apt-get "${apt_opts[@]}" update || return 1
  download_packages || return 1
  save_debs
  # shellcheck disable=SC2086
  run_attempts "Playwright apt install" "$apt_attempts" "$apt_timeout" clear_apt 1 \
    apt-get "${apt_opts[@]}" install -y --no-install-recommends $packages
}

if [ "$plan_only" = 1 ]; then
  packages=$(read_packages)
  if [ -z "$packages" ]; then
    echo "::error::Could not read the system package list from 'playwright install-deps --dry-run'" >&2
    exit 1
  fi
  echo "apt-packages-hash=$(printf '%s' "$packages" | hash_text)"
  exit 0
fi

if [ "$(uname -s)" = Linux ] || [ -n "${FORCE_APT:-}" ]; then
  install_system_deps || exit 1
fi

# shellcheck disable=SC2086
run_attempts "Playwright browser download" "$browser_attempts" "$browser_timeout" "" 0 \
  $playwright install $browsers
