#!/usr/bin/env bash
# =============================================================================
# setup-demo.sh — Reset the Commonly dev environment for a clean demo recording
#
# Usage: ./scripts/setup-demo.sh [--dry-run]
#
# What it does:
#   1. Gets an admin JWT from the running backend
#   2. Clears agent sessions (prevents stale context causing wrong behavior)
#   3. Seeds a fresh GitHub issue: "Add health check endpoint to /api/health"
#   4. Clears any existing tasks from the dev team board
#   5. Seeds the new issue as the first task on the board
#   6. Prints the demo script to follow
#
# Prerequisites:
#   - kubectl configured for commonly-dev
#   - GITHUB_PAT set (or available in the cluster)
#   - gh CLI installed
# =============================================================================

set -e

NAMESPACE=commonly-dev
DEV_POD_ID=69b7ddff0ce64c9648365fc4
BACKEND_POD_ID=69b7de080ce64c964836623b
GH_REPO=Team-Commonly/commonly
DEMO_ISSUE_TITLE="Add health check endpoint to /api/health"
DEMO_ISSUE_BODY="## Context
The backend is missing a health check endpoint. Kubernetes probes and load balancers need this.

## What to build
\`GET /api/health\` — no auth required. Returns:
\`\`\`json
{ \"status\": \"ok\", \"timestamp\": \"...\", \"uptime\": 123 }
\`\`\`

Add a basic test. Wire it into \`backend/server.js\`."

DRY_RUN=false
if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "🔍 Dry run mode — no changes will be made"
fi

echo ""
echo "============================================================"
echo "  Commonly Demo Setup"
echo "============================================================"
echo ""

# ── Step 1: Get admin JWT ────────────────────────────────────────────────────
echo "1️⃣  Getting admin JWT..."
ADMIN_JWT=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const u = await mongoose.connection.db.collection('users').findOne({role:'admin'});
  console.log(jwt.sign({id:u._id}, process.env.JWT_SECRET, {expiresIn:'1h'}));
  process.exit(0);
});
" 2>/dev/null)

if [[ -z "$ADMIN_JWT" ]]; then
  echo "❌ Failed to get admin JWT. Is the backend pod running?"
  exit 1
fi
echo "   ✅ Admin JWT obtained"

# ── Step 2: Clear agent sessions ────────────────────────────────────────────
echo "2️⃣  Clearing agent sessions (theo, nova, pixel, ops)..."
if [[ "$DRY_RUN" == "false" ]]; then
  kubectl exec -n "$NAMESPACE" deployment/clawdbot-gateway -- sh -c \
    "rm -f /state/agents/theo/sessions/*.jsonl /state/agents/theo/sessions/sessions.json \
            /state/agents/nova/sessions/*.jsonl /state/agents/nova/sessions/sessions.json \
            /state/agents/pixel/sessions/*.jsonl /state/agents/pixel/sessions/sessions.json \
            /state/agents/ops/sessions/*.jsonl /state/agents/ops/sessions/sessions.json \
            2>/dev/null; echo cleared" 2>/dev/null || echo "   ⚠️  Session clear had errors (non-fatal)"
fi
echo "   ✅ Sessions cleared"

# ── Step 3: Close any existing demo issues ───────────────────────────────────
echo "3️⃣  Checking for existing demo issue..."
EXISTING=$(gh issue list --repo "$GH_REPO" --state open --search "$DEMO_ISSUE_TITLE" --json number --jq '.[0].number' 2>/dev/null || echo "")
if [[ -n "$EXISTING" ]]; then
  echo "   Found existing issue #$EXISTING — closing it..."
  if [[ "$DRY_RUN" == "false" ]]; then
    gh issue close "$EXISTING" --repo "$GH_REPO" --comment "Closing for demo reset." 2>/dev/null || true
  fi
fi

# ── Step 4: Create fresh GitHub issue ───────────────────────────────────────
echo "4️⃣  Creating fresh demo GitHub issue..."
if [[ "$DRY_RUN" == "false" ]]; then
  ISSUE_URL=$(gh issue create \
    --repo "$GH_REPO" \
    --title "$DEMO_ISSUE_TITLE" \
    --body "$DEMO_ISSUE_BODY" \
    --label "backend,agent-task" 2>/dev/null)
  ISSUE_NUM=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$')
  echo "   ✅ Created $ISSUE_URL"
else
  ISSUE_NUM="NNN"
  echo "   (dry run) Would create issue: $DEMO_ISSUE_TITLE"
fi

# ── Step 5: Clear stale board tasks ─────────────────────────────────────────
echo "5️⃣  Clearing stale pending/claimed board tasks..."
if [[ "$DRY_RUN" == "false" ]]; then
  kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const r = await mongoose.connection.db.collection('tasks').updateMany(
    { podId: new mongoose.Types.ObjectId('$DEV_POD_ID'), status: { \\\$in: ['pending','claimed'] } },
    { \\\$set: { status: 'cancelled', completedAt: new Date(), notes: 'cleared for demo reset' } }
  );
  console.log('cleared:', r.modifiedCount);
  process.exit(0);
});
" 2>/dev/null || echo "   ⚠️  Could not clear tasks (non-fatal)"
fi
echo "   ✅ Board cleared"

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  ✅ Demo environment ready!"
echo "============================================================"
echo ""
echo "  New issue: GH#$ISSUE_NUM — $DEMO_ISSUE_TITLE"
echo "  Board: empty (all stale tasks cleared)"
echo "  Sessions: cleared (next heartbeat will be fresh)"
echo ""
echo "  📋 DEMO SCRIPT (90 seconds)"
echo "  ──────────────────────────────────────────────────────────"
echo "  00:00  Show GitHub: issue GH#$ISSUE_NUM is open"
echo "  00:10  Show Commonly board tab: empty"
echo "  00:15  Trigger Theo's heartbeat:"
echo "         curl -X POST https://api-dev.commonly.me/api/registry/admin/agents/theo/trigger-heartbeat \\"
echo "              -H 'Authorization: Bearer \$ADMIN_JWT' -H 'Content-Type: application/json'"
echo "  00:25  Board: TASK appears (Pending column, assigned to Nova)"
echo "  00:30  Trigger Nova's heartbeat:"
echo "         curl -X POST https://api-dev.commonly.me/api/registry/admin/agents/nova/trigger-heartbeat \\"
echo "              -H 'Authorization: Bearer \$ADMIN_JWT' -H 'Content-Type: application/json'"
echo "  00:40  Board: task moves to In Progress, Nova avatar lit up green"
echo "  01:00  Nova's acpx_run completes — PR opens on GitHub"
echo "  01:10  Show PR on GitHub with the health endpoint code"
echo "  01:20  Human clicks Merge"
echo "  01:25  Board: task moves to Done, GitHub issue auto-closed"
echo ""
echo "  💡 To trigger a heartbeat manually during recording:"
echo "     ./scripts/trigger-heartbeat.sh <agentName>"
echo ""
echo "  📺 Full recording guide: docs/yc/DEMO_RECORDING.md"
echo ""
