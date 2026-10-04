#!/bin/sh
# Runner hook "hetzner": status. See hetzner.mjs and docs/runner-hooks.md.
set -eu
exec "${BAND_NODE:-node}" "$(dirname "$0")/hetzner.mjs" status
