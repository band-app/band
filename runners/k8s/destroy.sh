#!/bin/sh
# Runner hook "k8s": deletes the pod (or job, or sandbox) spawn.sh created. Its token Secret is owned by
# it, so the garbage collector deletes the Secret (the runner's Role cannot read or get Secrets).
# Succeeds when they are gone already (the pod of an idle worker stays as Completed until deleted).
set -eu

: "${BAND_WORKER_ID:?}"
ns="${BAND_K8S_NAMESPACE:-band-workers}"
name="band-$BAND_WORKER_ID"
# The handle spawn.sh printed, when the caller passes it back (the hub does not yet).
if [ -n "${BAND_MACHINE_HANDLE:-}" ]; then
  ns="${BAND_MACHINE_HANDLE%%/*}"
  name="${BAND_MACHINE_HANDLE#*/}"
fi
case "$ns/$name" in
  [a-z0-9]*/[a-z0-9]*) ;;
  *) echo "invalid machine handle $ns/$name" >&2; exit 1 ;;
esac

case "${BAND_K8S_KIND:-pod}" in
  job) resource=job.batch ;;
  sandbox) resource=sandboxes.agents.x-k8s.io ;;
  *) resource=pod ;;
esac

k() { "${BAND_KUBECTL_BIN:-kubectl}" ${BAND_K8S_CONTEXT:+--context "$BAND_K8S_CONTEXT"} --namespace "$ns" "$@"; }

# --ignore-not-found makes a missing object a success. An unreachable cluster is an error, so the run
# log shows the leak.
k delete "$resource" "$name" --ignore-not-found --wait=false
echo "removed $resource $ns/$name"
