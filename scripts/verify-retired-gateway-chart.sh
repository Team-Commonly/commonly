#!/usr/bin/env bash
# ADR-021: old private overlays must not resurrect the retired gateway.
set -euo pipefail
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
for lane in default dev staging local; do
  values=(-f k8s/helm/commonly/values.yaml)
  if [[ "$lane" != default ]]; then
    values+=(-f "k8s/helm/commonly/values-$lane.yaml")
  fi
  helm template "commonly-$lane" k8s/helm/commonly "${values[@]}" \
    --set agents.clawdbot.enabled=true \
    --set agents.clawdbot.persistence.config.enabled=true \
    --set agents.clawdbot.persistence.workspace.enabled=true \
    --set agentProvisioning.createWorkspacePvc=true \
    --set githubPat.enabled=true > "$task_tmp/$lane.yaml"
  if sed '/^[[:space:]]*#/d' "$task_tmp/$lane.yaml" | grep -Eiq '^[[:space:]-]*(name|claimName|app|image|secretKey|key):.*(clawdbot|filestore-sc|GITHUB_PAT|CLAWDBOT|MOLTBOT)' ; then
    echo "Retired gateway resource or credential rendered in $lane" >&2
    exit 1
  fi
  grep -q 'name: backend' "$task_tmp/$lane.yaml"
  grep -q 'name: frontend' "$task_tmp/$lane.yaml"
done
# Deployment and test workflows must not fetch or build the retired runtime.
if grep -Eq 'submodules:|steps\.gateway|GATEWAY_TAG|verify:moltbot-tools|docker build _external/clawdbot' \
  .github/workflows/{deploy-dev,deploy-staging,tests}.yml; then
  echo 'Retired gateway CI dependency remains' >&2
  exit 1
fi
echo 'Gateway retirement: four chart lanes and three workflows pass'
