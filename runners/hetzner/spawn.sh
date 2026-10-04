#!/bin/sh
# Runner hook "hetzner": spawn. See hetzner.mjs and docs/runner-hooks.md.
set -eu
exec "${BAND_NODE:-node}" "$(dirname "$0")/hetzner.mjs" spawn
