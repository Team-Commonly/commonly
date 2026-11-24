#!/usr/bin/env bash
# Proves, on a live cluster, that the chart's NetworkPolicies are enforced and
# that a gVisor RuntimeClass isolates a sandboxed agent pod. Run by
# .github/workflows/kind-isolation.yml against kind with Calico and runsc, after
# the chart is installed with values-kind-isolation.yaml.
#
#   scripts/kind-isolation/probe.sh <namespace> <canary-ip>
#
# Every probe runs from a throwaway pod with no service-account token. A probe
# expected closed passes only on a connect TIMEOUT, which is how a dropped
# packet looks, so a DNS failure or a refused port can't pass as enforcement.
# Every closed path is paired with an open one from an allowed client, so a
# cluster that drops everything fails too.
set -euo pipefail

NS=${1:?namespace}
CANARY=${2:?canary ip}
FOREIGN=isolation-foreign
AGNHOST='registry.k8s.io/e2e-test-images/agnhost:2.59@sha256:10ed98804c877e505e17bced991682b6fd50ab1da9cddcd19935b48d645da40a'
SVC=svc.cluster.local
MONGO="mongodb.$NS.$SVC:27017"
REDIS="redis.$NS.$SVC:6379"
POSTGRES="postgres.$NS.$SVC:5432"
BACKEND="backend.$NS.$SVC:5000"
CANARY_URL="$CANARY:8080"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "  ok    $1"; }
bad() { failed=$((failed + 1)); echo "  FAIL  $1"; if [ -n "${2:-}" ]; then echo "        $2"; fi; }

# probe-pod <namespace> <name> <labels> [runtimeClass]
probe_pod() {
  local ns=$1 name=$2 labels=$3 rc=${4:-}
  local spec='"automountServiceAccountToken":false'
  [ -n "$rc" ] && spec="$spec,\"runtimeClassName\":\"$rc\""
  kubectl run "$name" -n "$ns" --image="$AGNHOST" --labels="$labels" --restart=Never \
    --overrides="{\"apiVersion\":\"v1\",\"spec\":{$spec}}" --command -- /agnhost pause >/dev/null
}

# check <namespace> <pod> <host:port> <open|closed> <description>
check() {
  local ns=$1 pod=$2 target=$3 want=$4 what=$5 out rc
  out=$(kubectl exec -n "$ns" "$pod" -- /agnhost connect "$target" --timeout=3s 2>&1) && rc=0 || rc=$?
  if [ "$want" = open ]; then
    if [ "$rc" -eq 0 ]; then ok "$what"; else bad "$what (expected open)" "$out"; fi
  elif [ "$rc" -ne 0 ] && grep -q TIMEOUT <<<"$out"; then
    ok "$what"
  else
    bad "$what (expected a dropped connection, got exit $rc)" "$out"
  fi
}

echo "== probe pods"
kubectl create namespace "$FOREIGN" >/dev/null
probe_pod "$NS" intruder app=intruder
probe_pod "$NS" data-client app=ops-runner
probe_pod "$NS" api-client app=commonly-bot
probe_pod "$NS" edge app=edge-probe
probe_pod "$NS" backup component=backup,app=backup-probe
probe_pod "$FOREIGN" spoof app=ops-runner
probe_pod "$NS" runc-kernel app=kernel-probe
probe_pod "$NS" gvisor-kernel app=ops-runner gvisor

# The per-turn shape OpenShell's Kubernetes driver creates: an agent-sandbox
# Sandbox whose pod runs under gVisor.
kubectl apply -f - >/dev/null <<YAML
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: probe-sandbox
  namespace: $NS
spec:
  podTemplate:
    metadata:
      labels:
        app: agent-sandbox
    spec:
      runtimeClassName: gvisor
      automountServiceAccountToken: false
      containers:
        - name: probe
          image: $AGNHOST
          command: ["/agnhost", "pause"]
YAML

kubectl wait -n "$NS" --for=condition=Ready pod/intruder pod/data-client pod/api-client pod/edge pod/backup \
  pod/runc-kernel pod/gvisor-kernel --timeout=180s
kubectl wait -n "$FOREIGN" --for=condition=Ready pod/spoof --timeout=180s
for _ in $(seq 1 60); do
  SANDBOX=$(kubectl get pod -n "$NS" -l app=agent-sandbox -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  [ -n "$SANDBOX" ] && break
  sleep 3
done
[ -n "${SANDBOX:-}" ] || { kubectl describe sandbox -n "$NS" probe-sandbox; echo "the Sandbox made no pod"; exit 1; }
kubectl wait -n "$NS" --for=condition=Ready "pod/$SANDBOX" --timeout=180s

echo "== ingress: each store admits only its listed clients"
for target in "$MONGO" "$REDIS" "$POSTGRES" "$BACKEND"; do
  check "$NS" data-client "$target" open "a listed client (app=ops-runner) reaches $target"
  check "$NS" intruder "$target" closed "an unlisted pod is dropped at $target"
done
check "$NS" api-client "$BACKEND" open "an agent workload (app=commonly-bot) reaches the backend"
check "$NS" api-client "$MONGO" closed "an agent workload is dropped at Mongo"
check "$NS" edge "$BACKEND" open "the edge reaches the backend"
check "$NS" backup "$MONGO" open "the backup component reaches Mongo"
check "$FOREIGN" spoof "$MONGO" closed "a client label in another namespace is dropped at Mongo"

echo "== egress: an excepted address is unreachable except from an exempt component"
check "$NS" backup "$CANARY_URL" open "the exempt backup component reaches the canary"
check "$NS" intruder "$CANARY_URL" closed "an ordinary pod is dropped on the way to the canary"

echo "== the sandboxed agent pod"
# Network works under gVisor: the same runtime with a listed label connects, so
# the drops below are the policies, not a broken sandbox network.
check "$NS" gvisor-kernel "$MONGO" open "a listed client under gVisor reaches Mongo"
check "$NS" gvisor-kernel "$CANARY_URL" closed "a pod under gVisor is dropped on the way to the canary"
for target in "$MONGO" "$REDIS" "$POSTGRES" "$BACKEND" "$CANARY_URL"; do
  check "$NS" "$SANDBOX" "$target" closed "the Sandbox pod is dropped at $target"
done

echo "== gVisor"
handler=$(kubectl get runtimeclass gvisor -o jsonpath='{.handler}')
if [ "$handler" = runsc ]; then ok "RuntimeClass gvisor uses the runsc handler"; else bad "RuntimeClass gvisor has handler '$handler'"; fi
host_kernel=$(kubectl exec -n "$NS" runc-kernel -- cat /proc/version)
for pod in gvisor-kernel "$SANDBOX"; do
  kernel=$(kubectl exec -n "$NS" "$pod" -- cat /proc/version)
  rc=$(kubectl get pod -n "$NS" "$pod" -o jsonpath='{.spec.runtimeClassName}')
  # gVisor's Sentry reports its own kernel string (e.g. "Linux version
  # 4.19.0-gvisor"), never the host's; the version number moves between releases.
  if [ "$rc" = gvisor ] && [ "$kernel" != "$host_kernel" ] && grep -Eq '^Linux version [0-9.]+-gvisor ' <<<"$kernel"; then
    ok "$pod runs under gVisor ($kernel)"
  else
    bad "$pod is not under gVisor (runtimeClassName '$rc')" "guest: $kernel / host: $host_kernel"
  fi
done

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
