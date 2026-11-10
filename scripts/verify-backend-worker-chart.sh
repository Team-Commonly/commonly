#!/usr/bin/env bash
set -euo pipefail

chart=k8s/helm/commonly
yq_bin=${YQ_BIN:-yq}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

for lane in default dev staging; do
  # The files each lane's deploy workflow passes: deploy-dev.yml layers
  # values-dev.yaml, and deploy-staging.yml layers values-staging.yaml alone.
  values=(-f "$chart/values.yaml")
  if [[ $lane == dev ]]; then
    values+=(-f "$chart/values-dev.yaml")
  fi
  if [[ $lane == staging ]]; then
    values+=(-f "$chart/values-staging.yaml")
  fi

  helm template "commonly-$lane" "$chart" "${values[@]}" > "$tmp_dir/$lane-shipped.yaml"
  helm template "commonly-$lane" "$chart" "${values[@]}" --set backend.worker.enabled=false > "$tmp_dir/$lane-off.yaml"
  helm template "commonly-$lane" "$chart" "${values[@]}" --set backend.worker.enabled=true --set backend.worker.startPaused=false > "$tmp_dir/$lane-on.yaml"
  helm template "commonly-$lane" "$chart" "${values[@]}" --set backend.worker.enabled=true --set backend.worker.startPaused=true > "$tmp_dir/$lane-paused.yaml"

  shipped="$tmp_dir/$lane-shipped.yaml"
  off="$tmp_dir/$lane-off.yaml"
  on="$tmp_dir/$lane-on.yaml"
  paused="$tmp_dir/$lane-paused.yaml"
  web_replicas=$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.replicas' "$off")
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .metadata.name' "$off")" = ""
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .metadata.name' "$on")" = backend-worker
  # The worker switch never changes how many web replicas a lane runs.
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.replicas' "$on")" = "$web_replicas"
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.replicas' "$on")" = 1
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.replicas' "$paused")" = 0
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.replicas' "$paused")" = "$web_replicas"
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$paused")" = 0
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$paused")" = 1
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.strategy.type' "$on")" = Recreate
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$off")" = ""
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$on")" = 0
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$on")" = 1
  # F52: with a running worker, web pods hand native turns to it and the worker
  # runs them. Paused there is no worker, so web keeps them; off, nothing changes.
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "NATIVE_TURNS_ON_WORKER") | .value' "$on")" = 1
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "NATIVE_TURNS_ON_WORKER") | .value' "$on")" = ""
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "NATIVE_TURNS_ON_WORKER") | .value' "$paused")" = ""
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "NATIVE_TURNS_ON_WORKER") | .value' "$off")" = ""
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.selector.matchLabels.app' "$on")" = backend-worker
  test "$("$yq_bin" -N 'select(.kind == "Service" and .metadata.name == "backend") | .spec.selector.app' "$on")" = backend
  test "$("$yq_bin" -N 'select((.kind == "Service" or .kind == "Ingress") and .metadata.name == "backend-worker") | .kind' "$on")" = ""

  # With the worker enabled, no existing resource changes except the web
  # container's RUN_WORKER=0 and NATIVE_TURNS_ON_WORKER=1 env. The worker's
  # env otherwise matches web.
  "$yq_bin" -N '.' "$off" > "$tmp_dir/$lane-normalized-off.yaml"
  "$yq_bin" -N 'select(.kind != "Deployment" or .metadata.name != "backend-worker") | del(.spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER" or .name == "NATIVE_TURNS_ON_WORKER"))' "$on" > "$tmp_dir/$lane-normalized-on.yaml"
  diff -u "$tmp_dir/$lane-normalized-off.yaml" "$tmp_dir/$lane-normalized-on.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env | map(select(.name != "RUN_WORKER" and .name != "NATIVE_TURNS_ON_WORKER"))' "$on" > "$tmp_dir/$lane-web-env.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env | map(select(.name != "RUN_WORKER"))' "$on" > "$tmp_dir/$lane-worker-env.yaml"
  diff -u "$tmp_dir/$lane-web-env.yaml" "$tmp_dir/$lane-worker-env.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].image' "$on" > "$tmp_dir/$lane-web-image.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].image' "$on" > "$tmp_dir/$lane-worker-image.yaml"
  diff -u "$tmp_dir/$lane-web-image.yaml" "$tmp_dir/$lane-worker-image.yaml"

  # What each lane actually deploys: more than one web replica only with the
  # worker split on, or every web pod runs the scheduler and the Discord gateway,
  # and only with the worker running, or two web pods run one agent's turns in
  # a pod at once (F52). An autoscaler that can add a web pod counts as more
  # than one.
  # No default inside yq: `//` there yields one per document, not per match.
  shipped_web=$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.replicas' "$shipped")
  shipped_web=${shipped_web:-1}
  shipped_hpa=$("$yq_bin" -N 'select(.kind == "HorizontalPodAutoscaler" and .metadata.name == "backend-hpa") | .spec.maxReplicas' "$shipped")
  shipped_hpa=${shipped_hpa:-0}
  # Inside an `if`, a malformed (( )) is false, not fatal: refuse anything but
  # one integer each. A glob, because macOS bash's =~ lets ^ and $ match at a
  # newline.
  [[ $shipped_web != *[!0-9]* && $shipped_hpa != *[!0-9]* ]]
  if (( shipped_web > 1 || shipped_hpa > 1 )); then
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .metadata.name' "$shipped")" = backend-worker
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$shipped")" = 0
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.replicas' "$shipped")" = 1
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "NATIVE_TURNS_ON_WORKER") | .value' "$shipped")" = 1
  fi

  # D286: the internal-usernames list reaches web and worker when set, and the
  # shipped values leave it unset, since usernames live in private values only.
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "USAGE_INTERNAL_USERNAMES") | .value' "$shipped")" = ""
  helm template "commonly-$lane" "$chart" "${values[@]}" --set backend.worker.enabled=true --set backend.worker.startPaused=false --set backend.env.usageInternalUsernames=alpha-test > "$tmp_dir/$lane-usage.yaml"
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "USAGE_INTERNAL_USERNAMES") | .value' "$tmp_dir/$lane-usage.yaml")" = alpha-test
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "USAGE_INTERNAL_USERNAMES") | .value' "$tmp_dir/$lane-usage.yaml")" = alpha-test
  # F401: the prefix list follows the same rule.
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "USAGE_INTERNAL_PREFIXES") | .value' "$shipped")" = ""
  helm template "commonly-$lane" "$chart" "${values[@]}" --set backend.worker.enabled=true --set backend.worker.startPaused=false --set backend.env.usageInternalPrefixes=beta- > "$tmp_dir/$lane-prefix.yaml"
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "USAGE_INTERNAL_PREFIXES") | .value' "$tmp_dir/$lane-prefix.yaml")" = beta-
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "USAGE_INTERNAL_PREFIXES") | .value' "$tmp_dir/$lane-prefix.yaml")" = beta-

  if [[ $lane != default ]]; then
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "AGENT_PROVISIONER_K8S") | .value' "$on")" = 1
  fi
  # Cron and the Discord gateway must survive spot reclamation in prod. Staging
  # keeps its worker on spot beside its web pods; a reclaim only pauses its cron.
  if [[ $lane == dev ]]; then
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.nodeSelector.pool' "$on")" = dev
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.tolerations[] | select(.key == "pool" and .value == "dev" and .effect == "NoSchedule") | .key' "$on")" = pool
  fi
  if [[ $lane == staging ]]; then
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.nodeSelector."workload-tier"' "$on")" = spot
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.tolerations[] | select(.key == "workload-tier" and .value == "spot" and .effect == "NoSchedule") | .key' "$on")" = workload-tier
  fi
done
