#!/bin/sh
# Entrypoint of the band-worker image. Arguments go to band-worker, as before. When the first
# argument is a command on PATH (`docker run --rm band-worker band --version`), that command runs.
case "${1:-}" in
  "" | -*) exec band-worker "$@" ;;
esac
if command -v "$1" >/dev/null 2>&1; then exec "$@"; fi
exec band-worker "$@"
