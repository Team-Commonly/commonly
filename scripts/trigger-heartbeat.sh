#!/usr/bin/env bash
# =============================================================================
# trigger-heartbeat.sh — Manually fire a heartbeat for a named agent
#
# Usage: ./scripts/trigger-heartbeat.sh <agentName> [instanceId]
#
# Example:
#   ./scripts/trigger-heartbeat.sh theo
#   ./scripts/trigger-heartbeat.sh nova
#
# Requires the backend to be running at API_BASE (default: https://api-dev.commonly.me)
# or set API_BASE=http://localhost:5000 for local dev.
# =============================================================================

set -e

AGENT_NAME="${1:?Usage: $0 <agentName> [instanceId]}"
INSTANCE_ID="${2:-default}"
API_BASE="${API_BASE:-https://api-dev.commonly.me}"
NAMESPACE="${NAMESPACE:-commonly-dev}"

# Get admin JWT from cluster
JWT=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const u = await mongoose.connection.db.collection('users').findOne({role:'admin'});
  console.log(jwt.sign({id:u._id}, process.env.JWT_SECRET, {expiresIn:'1h'}));
  process.exit(0);
});
" 2>/dev/null)

if [[ -z "$JWT" ]]; then
  echo "❌ Could not get admin JWT. Is kubectl configured for $NAMESPACE?"
  exit 1
fi

echo "⚡ Triggering heartbeat for agent: $AGENT_NAME (instanceId: $INSTANCE_ID)"

RESPONSE=$(curl -s -X POST \
  "$API_BASE/api/registry/admin/agents/$AGENT_NAME/trigger-heartbeat" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{\"instanceId\": \"$INSTANCE_ID\"}")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

# Check for success
if echo "$RESPONSE" | grep -q '"enqueued"'; then
  echo "✅ Heartbeat enqueued successfully"
else
  echo "❌ Something went wrong"
  exit 1
fi
