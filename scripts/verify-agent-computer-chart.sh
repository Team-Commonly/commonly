#!/usr/bin/env bash
# The agent computer chart (templates/agent-computer/): nothing renders without
# both the flag and a user id; with them, the browser is pinned by digest, the
# waker's role names only that browser, and a bad id fails the render.
set -euo pipefail

chart=k8s/helm/commonly
yq_bin=${YQ_BIN:-yq}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

user=aaaaaaaaaaaaaaaaaaaaaaaa
dev=(-f "$chart/values.yaml" -f "$chart/values-dev.yaml")
q() { "$yq_bin" -N "$1" "$2"; }
# An empty answer is a pass below, so a missing yq must not read as one.
command -v "$yq_bin" > /dev/null || { echo "verify-agent-computer-chart: $yq_bin not found"; exit 1; }

# The committed values carry no user id, so the committed render has no computer.
helm template commonly-dev "$chart" "${dev[@]}" > "$tmp_dir/off.yaml"
test "$(q 'select(.metadata.labels.app == "agent-computer-steel" or .metadata.labels.app == "agent-computer-waker") | .kind' "$tmp_dir/off.yaml")" = ""

# A user id without the flag renders nothing either.
helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" \
  --set backend.env.agentComputerEnabled=false > "$tmp_dir/flag-off.yaml"
test "$(q 'select(.metadata.labels.app == "agent-computer-steel" or .metadata.labels.app == "agent-computer-waker") | .kind' "$tmp_dir/flag-off.yaml")" = ""

helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" > "$tmp_dir/on.yaml"
on="$tmp_dir/on.yaml"
steel="select(.kind == \"Deployment\" and .metadata.name == \"steel-$user\")"

# The browser: pinned by digest, no replicas field (the waker owns scale), one
# disk at Steel's persist path, no token, off spot, and a Service on the API port.
test "$(q "$steel | .spec.template.spec.containers[0].image" "$on" | grep -cE '^ghcr\.io/steel-dev/steel-browser@sha256:[0-9a-f]{64}$')" = 1
test "$(q "$steel | .spec.replicas" "$on")" = null
test "$(q "$steel | .spec.strategy.type" "$on")" = Recreate
test "$(q "$steel | .spec.template.spec.automountServiceAccountToken" "$on")" = false
test "$(q "$steel | .spec.template.spec.serviceAccountName" "$on")" = agent-computer-steel
test "$(q "$steel | .spec.template.spec.containers[0].volumeMounts[] | select(.name == \"profile\") | .mountPath" "$on")" = /app/api/user-data-dir
test "$(q "$steel | .spec.template.spec.nodeSelector.pool" "$on")" = dev
test "$(q "select(.kind == \"PersistentVolumeClaim\" and .metadata.name == \"steel-$user-profile\") | .metadata.annotations[\"helm.sh/resource-policy\"]" "$on")" = keep
test "$(q "select(.kind == \"Service\" and .metadata.name == \"steel-$user\") | .spec.ports[].port" "$on")" = 3000
test "$(q 'select(.kind == "ServiceAccount" and .metadata.name == "agent-computer-steel") | .automountServiceAccountToken' "$on")" = false

# The waker: its role names only the rendered browser, with get/patch on scale.
role='select(.kind == "Role" and .metadata.name == "agent-computer-waker")'
test "$(q "$role | .rules[].resourceNames[]" "$on" | sort -u)" = "steel-$user"
test "$(q "$role | .rules[] | select(.resources[0] == \"deployments/scale\") | .verbs | join(\",\")" "$on")" = get,patch
test "$(q "$role | .rules[] | select(.resources[0] == \"deployments\") | .verbs | join(\",\")" "$on")" = get
test "$(q "$role | .rules | length" "$on")" = 2
waker='select(.kind == "Deployment" and .metadata.name == "agent-computer-waker") | .spec.template.spec.containers[0]'
test "$(q "$waker | .env[] | select(.name == \"AGENT_COMPUTER_WAKER_USERS\") | .value" "$on")" = "$user"
test "$(q "$waker | .env[] | select(.name == \"AGENT_COMPUTER_WAKER_TOKEN\") | .valueFrom.secretKeyRef.name" "$on")" = agent-computer-waker
test "$(q "$waker | .command | join(\" \")" "$on")" = "node dist/services/agentComputerWaker.js"
test "$(q 'select(.kind == "ExternalSecret" and .metadata.name == "agent-computer-waker") | .spec.data[0].remoteRef.key' "$on")" = commonly-dev-agent-computer-waker-token
# The token is its own ExternalSecret; api-keys must not grow a key that could fail its sync.
test "$(q 'select(.kind == "ExternalSecret" and .metadata.name == "api-keys") | .spec.data[].secretKey' "$on" | grep -c waker || true)" = 0

# The backend reaches the browser on the Service's port and the waker on its Service.
backend='select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[] | select(.name == "backend") | .env[]'
test "$(q "$backend | select(.name == \"AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE\") | .value" "$on")" = "ws://steel-{userId}.commonly-dev.svc.cluster.local:3000"
test "$(q "$backend | select(.name == \"AGENT_COMPUTER_WAKER_URL\") | .value" "$on")" = "http://agent-computer-waker.commonly-dev.svc.cluster.local"
test "$(q "$backend | select(.name == \"AGENT_COMPUTER_ALLOWED_HOSTS\") | .value" "$on")" = commonly.me

# Two people: two browsers, one waker whose role names both.
second=bbbbbbbbbbbbbbbbbbbbbbbb
helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" \
  --set "agentComputer.users[1]=$second" > "$tmp_dir/two.yaml"
test "$(q 'select(.kind == "Deployment" and .metadata.labels.app == "agent-computer-steel") | .metadata.name' "$tmp_dir/two.yaml" | wc -l | tr -d ' ')" = 2
test "$(q "$role | .rules[0].resourceNames | join(\",\")" "$tmp_dir/two.yaml")" = "steel-$user,steel-$second"

# Anything but a 24-hex lowercase id fails the render.
for bad in 'AAAAAAAAAAAAAAAAAAAAAAAA' 'aaaa' 'aaaaaaaaaaaaaaaaaaaaaaaa,x' '../aaaaaaaaaaaaaaaaaaaaaa'; do
  if helm template commonly-dev "$chart" "${dev[@]}" --set-string "agentComputer.users[0]=$bad" > /dev/null 2>&1; then
    echo "agent computer chart accepted user id: $bad"
    exit 1
  fi
done

echo "agent computer chart: ok"
