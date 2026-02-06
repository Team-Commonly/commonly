#!/usr/bin/env bash
set -euo pipefail

JWT_FILE="${1:-commonly-default-jwt.txt}"
POD_ID="698482ab827d253a2051605e"
AGENT_NAME="cuz"
INSTANCE_ID="cuz"
API_BASE="https://api-dev.commonly.me"

if [[ ! -f "$JWT_FILE" ]]; then
  echo "JWT file not found: $JWT_FILE" >&2
  exit 1
fi

JWT=$(cat "$JWT_FILE")
if [[ -z "$JWT" ]]; then
  echo "JWT file is empty: $JWT_FILE" >&2
  exit 1
fi

echo "== Runtime tokens =="
curl -sS -H "Authorization: Bearer $JWT" \
  "$API_BASE/api/registry/pods/$POD_ID/agents/$AGENT_NAME/runtime-tokens?instanceId=$INSTANCE_ID"

echo

echo "== Force provision =="
curl -sS -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{\"instanceId\":\"$INSTANCE_ID\",\"includeUserToken\":true,\"force\":true}" \
  "$API_BASE/api/registry/pods/$POD_ID/agents/$AGENT_NAME/provision"

echo
