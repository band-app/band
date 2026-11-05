#!/bin/sh
# Every hub test file that imports helpers/test-host must be listed in
# apps/hub/tests/loopback-files.txt, because remote-loopback mode runs only
# the listed files. Also fails on a listed file that does not exist.
set -eu
cd "$(dirname "$0")/.."
tests=apps/hub/tests
list=$tests/loopback-files.txt
status=0
for f in $(grep -l 'helpers/test-host' "$tests"/*.test.ts); do
  name=$(basename "$f")
  if ! grep -qx "$name" "$list"; then
    echo "check-loopback-files: $name imports helpers/test-host but is not in $list" >&2
    status=1
  fi
done
grep -v '^#' "$list" | grep -v '^$' | while read -r name; do
  if [ ! -f "$tests/$name" ]; then
    echo "check-loopback-files: $list names $name, which does not exist" >&2
    exit 1
  fi
done || status=1
exit $status
