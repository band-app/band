#!/bin/sh
# Checks what the band-hub service account may do, with `kubectl auth can-i --as`. Run it as a cluster
# admin after `kubectl apply -f deploy/k8s/rbac.yaml`. Exits 1 on the first answer that is wrong.
set -eu

kubectl="${KUBECTL:-kubectl}"
as="system:serviceaccount:band:band-hub"

check() {
  want="$1"; shift
  got="$("$kubectl" auth can-i "$@" --as "$as" 2>/dev/null || true)"
  if [ "$got" != "$want" ]; then
    echo "FAIL: can-i $* is '$got', want '$want'" >&2
    exit 1
  fi
  echo "ok: can-i $* is $got"
}

for verb in create delete get list watch; do check yes "$verb" pods -n band-workers; done
check yes create secrets -n band-workers

# Secrets are only created (the garbage collector deletes them), never read back, and nothing outside the namespace is reachable.
for verb in get list watch update patch delete; do check no "$verb" secrets -n band-workers; done
for verb in create delete list; do check no "$verb" pods -n band; done
for verb in create delete list; do check no "$verb" pods -n kube-system; done
check no get secrets -n kube-system
check no create pods --all-namespaces
check no list nodes
check no create clusterrolebindings
check no create pods --subresource=exec -n band-workers
