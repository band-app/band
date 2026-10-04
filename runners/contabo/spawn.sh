#!/bin/sh
# Runner hook "contabo": spawn. See contabo.mjs and docs/runner-hooks.md.
set -eu
exec "${BAND_NODE:-node}" "$(dirname "$0")/contabo.mjs" spawn
