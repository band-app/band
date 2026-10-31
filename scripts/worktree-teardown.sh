#!/usr/bin/env bash
# Stops processes still running from a worktree before Band removes it: test
# workers, daemons and dev servers that outlived the run that started them.
#
# Usage: worktree-teardown.sh [worktree path]   (default: the current directory)
#
# A process matches when its working directory is the worktree or below it, or
# its command line names a path below the worktree. The match is on the path
# plus a trailing slash, so /x/foo does not match /x/foo-bar. Processes are
# killed by PID: SIGTERM first, SIGKILL after a few seconds. This script and
# its ancestors are never touched.
set -u

given="${1:-$PWD}"
target="$(cd "$given" 2>/dev/null && pwd -P)" || exit 0
case "$target" in
  "" | "/") exit 0 ;;
esac
# A command line may spell the path through a symlink (/tmp on macOS), so the
# logical spelling matches too.
logical="$(cd "$given" && pwd)"
grace="${BAND_TEARDOWN_GRACE_SECONDS:-5}"

# PIDs to spare: this script and every ancestor.
spared=" "
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
  spared="$spared$pid "
  pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
done

in_tree() { # path -> 0 when it is the worktree or below it
  case "$1" in
    "$target" | "$target"/* | "$logical" | "$logical"/*) return 0 ;;
  esac
  return 1
}

matching_pids() {
  local found=" " p cwd cmd
  # Working directory.
  if [ -d /proc/self ]; then
    for p in /proc/[0-9]*; do
      cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
      in_tree "$cwd" && found="$found${p#/proc/} "
    done
  elif command -v lsof >/dev/null 2>&1; then
    local line
    while IFS= read -r line; do
      case "$line" in
        p*) p="${line#p}" ;;
        n*) in_tree "${line#n}" && found="$found$p " ;;
      esac
    done < <(lsof -a -d cwd -Fpn 2>/dev/null)
  fi
  # Command line: the worktree path followed by a slash, anywhere in the arguments.
  while IFS= read -r line; do
    p="${line%% *}"
    cmd="${line#* }"
    case "$cmd" in
      *"$target"/* | *"$logical"/*) found="$found$p " ;;
    esac
  done < <(ps -axo pid=,command= 2>/dev/null | sed 's/^ *//')

  local out="" seen=" "
  for p in $found; do
    case "$spared$seen" in *" $p "*) continue ;; esac
    seen="$seen$p "
    out="$out $p"
  done
  echo "$out"
}

alive() { kill -0 "$1" 2>/dev/null; }

pids="$(matching_pids)"
[ -z "${pids// /}" ] && exit 0

echo "worktree-teardown: stopping processes under $target:${pids}"
for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done

deadline=$((SECONDS + grace))
while [ "$SECONDS" -lt "$deadline" ]; do
  left=""
  for p in $pids; do alive "$p" && left="$left $p"; done
  [ -z "$left" ] && exit 0
  sleep 0.2
done

for p in $pids; do
  if alive "$p"; then
    echo "worktree-teardown: SIGKILL $p"
    kill -KILL "$p" 2>/dev/null || true
  fi
done
exit 0
