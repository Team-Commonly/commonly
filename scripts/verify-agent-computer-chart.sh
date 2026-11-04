#!/usr/bin/env bash
# The agent computer chart (templates/agent-computer/): nothing renders without
# both the flag and a user id. With them, Steel listens on loopback behind a
# token gate, runs as non-root under the chart's Chrome policy, the image is
# pinned by digest, the waker's role names only that browser, and a bad id
# fails the render. What the policy actually stops is measured by
# scripts/agent-computer-steel-probe.sh.
set -euo pipefail

chart=k8s/helm/commonly
yq_bin=${YQ_BIN:-yq}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

# Several checks below pass on an empty answer, so a missing yq or a yq error
# must produce something that matches no expected value. `$(...)` would
# otherwise swallow the failure.
command -v "$yq_bin" > /dev/null || { echo "verify-agent-computer-chart: $yq_bin not found"; exit 1; }
q() { "$yq_bin" -N "$1" "$2" 2> /dev/null || echo "__yq_error__"; }

user=aaaaaaaaaaaaaaaaaaaaaaaa
dev=(-f "$chart/values.yaml" -f "$chart/values-dev.yaml")
computer='select(.metadata.labels.app == "agent-computer-steel" or .metadata.labels.app == "agent-computer-waker") | .kind'

# The committed values carry no user id, so the committed render has no computer.
helm template commonly-dev "$chart" "${dev[@]}" > "$tmp_dir/off.yaml"
test "$(q "$computer" "$tmp_dir/off.yaml")" = ""

# A user id without the flag renders nothing either.
helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" \
  --set backend.env.agentComputerEnabled=false > "$tmp_dir/flag-off.yaml"
test "$(q "$computer" "$tmp_dir/flag-off.yaml")" = ""

helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" > "$tmp_dir/on.yaml"
on="$tmp_dir/on.yaml"
steel="select(.kind == \"Deployment\" and .metadata.name == \"steel-$user\") | .spec.template.spec"
browser="$steel | .containers[] | select(.name == \"steel\")"
gate="$steel | .containers[] | select(.name == \"gate\")"

# The browser: pinned by digest, on loopback only, with its profile on the disk
# from the first launch, no token, off spot, and no replicas field.
test "$(q "$browser | .image" "$on" | grep -cE '^ghcr\.io/steel-dev/steel-browser@sha256:[0-9a-f]{64}$')" = 1
test "$(q "$browser | .env[] | select(.name == \"HOST\") | .value" "$on")" = 127.0.0.1
test "$(q "$browser | .env[] | select(.name == \"PORT\") | .value" "$on")" = 3001
test "$(q "$browser | .env[] | select(.name == \"CHROME_USER_DATA_DIR\") | .value" "$on")" = /app/api/user-data-dir
test "$(q "$browser | .volumeMounts[] | select(.name == \"profile\") | .mountPath" "$on")" = /app/api/user-data-dir
test "$(q "$browser | .ports | length" "$on")" = 0
test "$(q "$steel | .initContainers[0].command[2]" "$on" | grep -c SingletonLock)" = 1
test "$(q "select(.kind == \"Deployment\" and .metadata.name == \"steel-$user\") | .spec.replicas" "$on")" = null
test "$(q "select(.kind == \"Deployment\" and .metadata.name == \"steel-$user\") | .spec.strategy.type" "$on")" = Recreate
test "$(q "$steel | .automountServiceAccountToken" "$on")" = false
test "$(q "$steel | .serviceAccountName" "$on")" = agent-computer-steel
test "$(q "$steel | .nodeSelector.pool" "$on")" = dev
test "$(q "select(.kind == \"PersistentVolumeClaim\" and .metadata.name == \"steel-$user-profile\") | .metadata.annotations[\"helm.sh/resource-policy\"]" "$on")" = keep
test "$(q 'select(.kind == "ServiceAccount" and .metadata.name == "agent-computer-steel") | .automountServiceAccountToken' "$on")" = false

# The browser and its init step run as the image's own user (1000) with no
# capabilities. Chrome's sandbox is off, as Steel needs it to be there, and the
# chart's Chrome policy is mounted read-only over the image's own.
test "$(q "$browser | .securityContext.runAsNonRoot" "$on")" = true
test "$(q "$browser | .securityContext.runAsUser" "$on")" = 1000
test "$(q "$browser | .securityContext.allowPrivilegeEscalation" "$on")" = false
test "$(q "$browser | .securityContext.capabilities.drop | join(\",\")" "$on")" = ALL
test "$(q "$steel | .initContainers[0].securityContext.runAsNonRoot" "$on")" = true
test "$(q "$steel | .initContainers[0].securityContext.capabilities.drop | join(\",\")" "$on")" = ALL
test "$(q "$steel | .securityContext.fsGroup" "$on")" = 1000
test "$(q "$browser | .env[] | select(.name == \"DISABLE_CHROME_SANDBOX\") | .value" "$on")" = true
test "$(q "$browser | .volumeMounts[] | select(.name == \"chrome-policy\") | .mountPath" "$on")" = /etc/chromium/policies/managed
test "$(q "$browser | .volumeMounts[] | select(.name == \"chrome-policy\") | .readOnly" "$on")" = true
test "$(q "$browser | .volumeMounts[] | select(.name == \"steel-files\") | .mountPath" "$on")" = /files
q 'select(.kind == "ConfigMap" and .metadata.name == "agent-computer-chrome-policy") | .data["00_policy.json"]' "$on" > "$tmp_dir/policy.json"
# Every navigation is blocked but the broker's own allowed hosts, exactly and
# over https, and no page reaches a loopback or private address.
pj() { "$yq_bin" -N -p json "$1" "$tmp_dir/policy.json" 2> /dev/null || echo "__yq_error__"; }
test "$(pj '.URLBlocklist | join(",")')" = '*'
test "$(pj '.URLAllowlist | join(",")')" = 'https://.commonly.me'
test "$(pj '.LocalNetworkAccessBlockedForUrls | join(",")')" = '*'
for bad in '*' 'commonly.me/x' 'localhost' '.commonly.me'; do
  if helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" \
    --set-string "backend.env.agentComputerAllowedHosts=$bad" > "$tmp_dir/bad-host.yaml" 2> "$tmp_dir/bad-host.err"; then
    echo "agent computer chart accepted allowed host: $bad"
    exit 1
  fi
  grep -q 'is not a plain host name' "$tmp_dir/bad-host.err" || { echo "bad host $bad failed for another reason:"; cat "$tmp_dir/bad-host.err"; exit 1; }
done
# A policy change restarts the browser, so it never runs under a stale policy.
test "$(q "select(.kind == \"Deployment\" and .metadata.name == \"steel-$user\") | .spec.template.metadata.annotations[\"checksum/chrome-policy\"]" "$on" | grep -cE '^[0-9a-f]{64}$')" = 1

# The gate is the pod's only listener and the Service's only target.
test "$(q "$gate | .command | join(\" \")" "$on")" = "node dist/services/agentComputerSteelGate.js"
test "$(q "$gate | .ports[0].containerPort" "$on")" = 3000
test "$(q "$gate | .env[] | select(.name == \"STEEL_UPSTREAM_PORT\") | .value" "$on")" = 3001
test "$(q "$gate | .env[] | select(.name == \"STEEL_GATE_TOKEN\") | .valueFrom.secretKeyRef.name" "$on")" = agent-computer-steel
test "$(q "$gate | .readinessProbe.httpGet.path" "$on")" = /healthz
test "$(q "$gate | .securityContext.runAsNonRoot" "$on")" = true
# The gate follows the backend tag unless pinned, and a pin holds.
test "$(q "$gate | .image" "$on")" = "$(q 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[] | select(.name == "backend") | .image' "$on")"
helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" \
  --set backend.image.tag=moved --set agentComputer.steel.gate.imageTag=pinned > "$tmp_dir/pinned.yaml"
test "$(q "$gate | .image" "$tmp_dir/pinned.yaml" | sed 's/.*://')" = pinned
test "$(q "select(.kind == \"Service\" and .metadata.name == \"steel-$user\") | .spec.ports[] | (.port | tostring) + \"->\" + .targetPort" "$on")" = "3000->api"
test "$(q 'select(.kind == "ExternalSecret" and .metadata.name == "agent-computer-steel") | .spec.data[0].remoteRef.key' "$on")" = commonly-dev-agent-computer-steel-token

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

# Both tokens have their own ExternalSecret; api-keys must not grow a key that
# could fail its sync. Read its key list first, so an empty read can't pass.
api_keys=$(q 'select(.kind == "ExternalSecret" and .metadata.name == "api-keys") | .spec.data[].secretKey' "$on")
test "$api_keys" != "__yq_error__"
test "$(printf '%s\n' "$api_keys" | grep -c -- '-key\|secret')" -gt 0
test "$(printf '%s\n' "$api_keys" | grep -c 'agent-computer' || true)" = 0

# The backend reaches the browser on the gate's port, with the gate's token,
# and the waker on its Service.
backend='select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[] | select(.name == "backend") | .env[]'
test "$(q "$backend | select(.name == \"AGENT_COMPUTER_STEEL_CDP_URL_TEMPLATE\") | .value" "$on")" = "ws://steel-{userId}.commonly-dev.svc.cluster.local:3000"
test "$(q "$backend | select(.name == \"AGENT_COMPUTER_STEEL_TOKEN\") | .valueFrom.secretKeyRef.name" "$on")" = agent-computer-steel
test "$(q "$backend | select(.name == \"AGENT_COMPUTER_WAKER_URL\") | .value" "$on")" = "http://agent-computer-waker.commonly-dev.svc.cluster.local"
test "$(q "$backend | select(.name == \"AGENT_COMPUTER_ALLOWED_HOSTS\") | .value" "$on")" = commonly.me

# Two people: two browsers, one waker whose role names both.
second=bbbbbbbbbbbbbbbbbbbbbbbb
helm template commonly-dev "$chart" "${dev[@]}" --set "agentComputer.users[0]=$user" \
  --set "agentComputer.users[1]=$second" > "$tmp_dir/two.yaml"
test "$(q 'select(.kind == "Deployment" and .metadata.labels.app == "agent-computer-steel") | .metadata.name' "$tmp_dir/two.yaml" | wc -l | tr -d ' ')" = 2
test "$(q "$role | .rules[0].resourceNames | join(\",\")" "$tmp_dir/two.yaml")" = "steel-$user,steel-$second"

# Anything but a 24-hex lowercase id fails the render, at the template's check.
for bad in 'AAAAAAAAAAAAAAAAAAAAAAAA' 'aaaa' 'aaaaaaaaaaaaaaaaaaaaaaag' '../aaaaaaaaaaaaaaaaaaaaaa'; do
  if helm template commonly-dev "$chart" "${dev[@]}" --set-string "agentComputer.users[0]=$bad" > "$tmp_dir/bad.yaml" 2> "$tmp_dir/bad.err"; then
    echo "agent computer chart accepted user id: $bad"
    exit 1
  fi
  grep -q 'is not a 24-character lowercase hex user id' "$tmp_dir/bad.err" || { echo "bad id $bad failed for another reason:"; cat "$tmp_dir/bad.err"; exit 1; }
done

echo "agent computer chart: ok"
