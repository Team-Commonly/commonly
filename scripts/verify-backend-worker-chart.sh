#!/usr/bin/env bash
set -euo pipefail

chart=k8s/helm/commonly
yq_bin=${YQ_BIN:-yq}
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

for lane in default dev staging; do
  values=(-f "$chart/values.yaml")
  if [[ $lane != default ]]; then
    values+=(-f "$chart/values-dev.yaml")
  fi
  if [[ $lane == staging ]]; then
    values+=(-f "$chart/values-staging.yaml")
  fi

  helm template "commonly-$lane" "$chart" "${values[@]}" > "$tmp_dir/$lane-off.yaml"
  helm template "commonly-$lane" "$chart" "${values[@]}" --set backend.worker.enabled=true --set backend.worker.startPaused=false > "$tmp_dir/$lane-on.yaml"
  helm template "commonly-$lane" "$chart" "${values[@]}" --set backend.worker.enabled=true > "$tmp_dir/$lane-paused.yaml"

  off="$tmp_dir/$lane-off.yaml"
  on="$tmp_dir/$lane-on.yaml"
  paused="$tmp_dir/$lane-paused.yaml"
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .metadata.name' "$off")" = ""
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .metadata.name' "$on")" = backend-worker
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.replicas' "$on")" = 1
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.replicas' "$on")" = 1
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.replicas' "$paused")" = 0
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$paused")" = 0
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.strategy.type' "$on")" = Recreate
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$off")" = ""
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$on")" = 0
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER") | .value' "$on")" = 1
  test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.selector.matchLabels.app' "$on")" = backend-worker
  test "$("$yq_bin" -N 'select(.kind == "Service" and .metadata.name == "backend") | .spec.selector.app' "$on")" = backend

  # With the worker enabled, no existing resource changes except the web
  # container's RUN_WORKER=0 env. The worker's env otherwise matches web.
  "$yq_bin" -N '.' "$off" > "$tmp_dir/$lane-normalized-off.yaml"
  "$yq_bin" -N 'select(.metadata.name != "backend-worker") | del(.spec.template.spec.containers[].env[] | select(.name == "RUN_WORKER"))' "$on" > "$tmp_dir/$lane-normalized-on.yaml"
  diff -u "$tmp_dir/$lane-normalized-off.yaml" "$tmp_dir/$lane-normalized-on.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].env | map(select(.name != "RUN_WORKER"))' "$on" > "$tmp_dir/$lane-web-env.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env | map(select(.name != "RUN_WORKER"))' "$on" > "$tmp_dir/$lane-worker-env.yaml"
  diff -u "$tmp_dir/$lane-web-env.yaml" "$tmp_dir/$lane-worker-env.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend") | .spec.template.spec.containers[].image' "$on" > "$tmp_dir/$lane-web-image.yaml"
  "$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].image' "$on" > "$tmp_dir/$lane-worker-image.yaml"
  diff -u "$tmp_dir/$lane-web-image.yaml" "$tmp_dir/$lane-worker-image.yaml"

  if [[ $lane != default ]]; then
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.nodeSelector.pool' "$on")" = dev
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.tolerations[] | select(.key == "pool" and .value == "dev" and .effect == "NoSchedule") | .key' "$on")" = pool
    test "$("$yq_bin" -N 'select(.kind == "Deployment" and .metadata.name == "backend-worker") | .spec.template.spec.containers[].env[] | select(.name == "AGENT_PROVISIONER_K8S") | .value' "$on")" = 1
  fi
done
