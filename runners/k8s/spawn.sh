#!/bin/sh
# Runner hook "k8s": starts a band-worker as a Pod (or Job, or agent-sandbox Sandbox) in a namespace
# with kubectl. Contract: docs/runner-hooks.md. Manifests are rendered by render.mjs.
#
# The pod carries the same hardening as the docker hook: uid 65532, no capabilities, a read-only root
# with emptyDir volumes for /tmp and /work, the RuntimeDefault seccomp profile, no service account
# token. The bootstrap token goes into a Secret created after the workload and owned by it, so the
# garbage collector deletes it with the pod. The token is only on kubectl's stdin.
#
# Settings (the runner's "env"):
#   BAND_K8S_NAMESPACE        namespace for the workers (default: band-workers). deploy/k8s/ creates it.
#   BAND_K8S_IMAGE            the worker base image, run when the project has no environment image
#                             (default: band-worker). BAND_PROJECT_IMAGE, set by the hub, wins over it.
#   BAND_K8S_KIND             pod (default), job, or sandbox (kubernetes-sigs/agent-sandbox Sandbox).
#   BAND_K8S_RUNTIME_CLASS    runtimeClassName, such as kata or gvisor. Required for isolation vm.
#   BAND_K8S_PULL_POLICY      imagePullPolicy (default: the cluster's).
#   BAND_K8S_PULL_SECRET      name of an imagePullSecret in the namespace.
#   BAND_K8S_CA_CONFIGMAP     name of a ConfigMap in the namespace with the CA of a hub behind a private
#                             certificate. It is mounted read-only and NODE_EXTRA_CA_CERTS points at it.
#   BAND_K8S_CA_KEY           key of the CA file in that ConfigMap (default: ca.crt).
#   BAND_K8S_TMP_SIZE         size of the memory-backed /tmp (default: 512Mi).
#   BAND_K8S_WORK_SIZE        size limit of the /work emptyDir (default: 10Gi).
#   BAND_K8S_SECRET_WAIT      seconds to retry the token Secret create while an old one is collected (default: 30).
#   BAND_K8S_CONTEXT          kubectl --context.
#   BAND_PROJECT_IMAGE        must be pullable by the cluster (see BAND_K8S_PULL_SECRET), else the pod stays in
#                             ImagePullBackOff until the runner times out.
#   BAND_KUBECTL_BIN          the kubectl binary (default: kubectl).
#   KUBECONFIG                the hook environment carries only HOME, so ~/.kube/config is read by default.
#   BAND_IDLE_EXIT            idle time before the ephemeral worker exits, like 90s.
set -eu

: "${BAND_HUB_URL:?}" "${BAND_WORKER_ID:?}" "${BAND_BOOTSTRAP_TOKEN:?}"

here="$(cd "$(dirname "$0")" && pwd)"
node="${BAND_NODE:-node}"
render() { "$node" "$here/render.mjs" "$@"; }

# Validates the settings before anything is created: a bad namespace, a vm request with no
# RuntimeClass, a repository with no URL a pod can clone.
checked="$(render check)"
set -- $checked
kind="$1" ns="$2" name="$3" repo_name="$4"

case "$kind" in
  job) resource=job.batch ;;
  sandbox) resource=sandboxes.agents.x-k8s.io ;;
  *) resource=pod ;;
esac

k() { "${BAND_KUBECTL_BIN:-kubectl}" ${BAND_K8S_CONTEXT:+--context "$BAND_K8S_CONTEXT"} --namespace "$ns" "$@"; }

# A worker id that wakes an ephemeral host (docs/ephemeral-workers.md) comes back on a clean pod. A
# leftover that has finished is removed. One that still runs is left alone.
phases="$(k get pods --selector "band.worker=$BAND_WORKER_ID" --output 'jsonpath={range .items[*]}{.status.phase}{"\n"}{end}')"
if printf '%s\n' "$phases" | grep -qE '^(Pending|Running)$'; then
  echo "a pod for worker $BAND_WORKER_ID is still running in $ns" >&2
  exit 1
fi
k delete "$resource" "$name" --ignore-not-found --wait=true >/dev/null

uid="$(render workload | k create --filename - --output 'jsonpath={.metadata.uid}')"
if [ -z "$uid" ]; then
  echo "kubectl created the $resource but returned no uid" >&2
  exit 1
fi

# The workload waits in ContainerCreating until the Secret it names exists. The hook never deletes a
# Secret itself, because `kubectl delete` reads the object first and the runner's Role grants no read
# on Secrets. The garbage collector removes the Secret of a deleted workload, so a woken worker's old
# Secret can still be there for a moment: the create is retried for BAND_K8S_SECRET_WAIT seconds.
secret_ok=
tries="${BAND_K8S_SECRET_WAIT:-30}"
while :; do
  if BAND_K8S_OWNER_UID="$uid" render secret | k create --filename - >/dev/null; then secret_ok=1; break; fi
  [ "$tries" -gt 0 ] || break
  tries=$((tries - 1))
  sleep 1
done
if [ -z "$secret_ok" ]; then
  echo "could not create the token secret; removing $resource $name" >&2
  k delete "$resource" "$name" --ignore-not-found --wait=false >/dev/null || true
  exit 1
fi

if [ -n "${BAND_REPO_URLS:-}" ]; then echo "BAND_HOST_PROJECT_PATH=/work/$repo_name"; fi
echo "BAND_MACHINE_HANDLE=$ns/$name"
echo "started $resource $ns/$name"
