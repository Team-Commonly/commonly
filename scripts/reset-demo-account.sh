#!/usr/bin/env bash
# Sprint C1 — Reset the sam-demo account to a clean baseline so smoke-tests
# don't drift state over time. Idempotent: re-running yields the same end
# state. Run after a smoke sweep or before a YC reviewer trial session.
#
# What this script does (in order):
#   1. Uninstall every byo-smoke-* AgentInstallation in the demo pod
#      (smoke leaves one per run; this cleans them up).
#   2. Mark any non-nova-demo openclaw installations in the demo pod as
#      `uninstalled` (cluster Nova / Liz / whoever else got installed mid-
#      session). The nova-demo concierge stays — it's the demo's
#      responsive identity per Sprint C0.
#   3. Clear stale agent sessions for the demo's openclaw runtime so the
#      next heartbeat re-reads HEARTBEAT.md cleanly.
#   4. Smoke-test the result. The script exits non-zero if smoke goes red.
#
# What it does NOT do:
#   - Reseed scrollback. The 17 storyboard messages (May 3–4) are intact
#     across runs; nothing here destroys them.
#   - Touch C2 (pixel-stub replacement). That's a one-time migration, not
#     a per-run reset.
#   - Reset agent memory. Cycles/long-term/etc. survive — those are
#     legitimate learning state, not test pollution.
#
# Requires:
#   - kubectl access to the commonly-dev namespace
#   - `.dev/yc-application/.smoke-env` with TOKEN + DEMO_POD (read by smoke)
#
# Usage:
#   bash scripts/reset-demo-account.sh

set -uo pipefail

DEMO_POD="${DEMO_POD:-69f841a9063269526de0437c}"
NAMESPACE="${NAMESPACE:-commonly-dev}"

# ──────────────────────────────────────────────────────────────────────────
# 1. Clean ephemeral byo-* installs (anything created by smoke runs or
#    Playwright trial flows leaves a byo-<purpose>-<ts> AgentInstallation).
#    Catches byo-smoke-*, byo-handoff-probe, byo-playwright-test-*, etc.
# ──────────────────────────────────────────────────────────────────────────
echo "[reset] (1/4) uninstalling byo-* AgentInstallations from $DEMO_POD…"
removed=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const m=require('mongoose');
m.connect(process.env.MONGO_URI).then(async ()=>{
  const AI=m.connection.db.collection('agentinstallations');
  const r=await AI.updateMany(
    {podId: m.Types.ObjectId.createFromHexString('$DEMO_POD'), agentName: {\$regex: '^byo-'}, status: 'active'},
    {\$set: {status: 'uninstalled', updatedAt: new Date()}}
  );
  console.log(r.modifiedCount);
  process.exit(0);
})" 2>/dev/null | tail -1)
echo "[reset]     uninstalled $removed byo-* row(s)"

# ──────────────────────────────────────────────────────────────────────────
# 2. Demote any non-demo openclaw installations in the demo pod.
#    The demo's authoritative responsive identity is openclaw:nova-demo (per
#    Sprint C0). Anything else in the pod that's openclaw and status=active
#    is residual experimentation — silence it.
# ──────────────────────────────────────────────────────────────────────────
echo "[reset] (2/4) demoting non-nova-demo openclaw installations…"
demoted=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const m=require('mongoose');
m.connect(process.env.MONGO_URI).then(async ()=>{
  const AI=m.connection.db.collection('agentinstallations');
  const r=await AI.updateMany(
    {podId: m.Types.ObjectId.createFromHexString('$DEMO_POD'), agentName: 'openclaw', instanceId: {\$ne: 'nova-demo'}, status: 'active'},
    {\$set: {status: 'uninstalled', updatedAt: new Date()}}
  );
  console.log(r.modifiedCount);
  process.exit(0);
})" 2>/dev/null | tail -1)
echo "[reset]     demoted $demoted openclaw row(s)"

# ──────────────────────────────────────────────────────────────────────────
# 3. Clear nova-demo's session so the next chat.mention re-reads HEARTBEAT.md
#    cleanly. Sessions accumulate context across heartbeat ticks; a fresh
#    one ensures the concierge instructions are applied verbatim.
# ──────────────────────────────────────────────────────────────────────────
echo "[reset] (3/4) clearing nova-demo gateway sessions…"
kubectl exec -n "$NAMESPACE" deployment/clawdbot-gateway -- bash -c \
  "rm -f /state/agents/nova-demo/sessions/*.jsonl /state/agents/nova-demo/sessions/sessions.json 2>/dev/null; ls /state/agents/nova-demo/sessions/ 2>/dev/null | wc -l" 2>&1 | tail -1 | \
  xargs -I{} echo "[reset]     {} session file(s) remaining"

# ──────────────────────────────────────────────────────────────────────────
# 4. Re-run smoke to verify the reset didn't break anything.
# ──────────────────────────────────────────────────────────────────────────
echo "[reset] (4/4) running smoke-test-demo.sh…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if bash "$SCRIPT_DIR/smoke-test-demo.sh"; then
  echo "[reset] ✅ reset complete, smoke green"
  exit 0
else
  echo "[reset] ❌ smoke red after reset — investigate" >&2
  exit 1
fi
