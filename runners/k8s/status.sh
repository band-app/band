#!/bin/sh
# Runner hook "k8s": lists the live worker pods, one `<namespace>/<pod> <phase>` line each.
# With BAND_WORKER_ID it lists that worker's pods, else every pod the runner (BAND_RUNNER_ID) started,
# else every pod with a band.worker label in the namespace.
set -eu

ns="${BAND_K8S_NAMESPACE:-band-workers}"
# render.mjs labels with these characters only, cut to 63.
label() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_' | cut -c1-63 | sed 's/^[^A-Za-z0-9]*//; s/[^A-Za-z0-9]*$//'; }
if [ -n "${BAND_WORKER_ID:-}" ]; then
  selector="band.worker=$(label "$BAND_WORKER_ID")"
elif [ -n "${BAND_RUNNER_ID:-}" ]; then
  selector="band.runner=$(label "$BAND_RUNNER_ID")"
else
  selector="band.worker"
fi

"${BAND_KUBECTL_BIN:-kubectl}" ${BAND_K8S_CONTEXT:+--context "$BAND_K8S_CONTEXT"} --namespace "$ns" \
  get pods --selector "$selector" \
  --output 'jsonpath={range .items[*]}{.metadata.namespace}/{.metadata.name} {.status.phase}{"\n"}{end}'
