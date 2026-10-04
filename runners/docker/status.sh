#!/bin/sh
# Runner hook "docker": prints the id of every container of this runner that still exists
# (label band.runner), one per line. The hub destroys the ones it has no record of.
set -eu

: "${BAND_RUNNER_ID:?}"
docker ps --all --no-trunc --filter "label=band.runner=$BAND_RUNNER_ID" --format '{{.ID}}'
