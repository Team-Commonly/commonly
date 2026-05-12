#!/usr/bin/env bash
# Sprint C1 — Reset the sam-demo account to a clean baseline so smoke-tests
# don't drift state over time. Idempotent: re-running yields the same end
# state. Run after a smoke sweep or before a YC reviewer trial session.
#
# What this script does (in order):
#   1. Uninstall every byo-* AgentInstallation in the demo pod (smoke
#      and Playwright trial flows leave byo-smoke-*, byo-handoff-probe,
#      byo-playwright-test-*; this catches them all).
#   2. Mark any non-nova-demo openclaw installations in the demo pod as
#      `uninstalled` (cluster Nova / Liz / whoever else got installed mid-
#      session). The nova-demo concierge stays — it's the demo's
#      responsive identity per Sprint C0.
#   3. Clear stale agent sessions for the demo's openclaw runtime so the
#      next heartbeat re-reads HEARTBEAT.md cleanly.
#   4. Hard-delete chat residue from PG: install-intro messages from
#      byo-* users, smoke @-mention prompts, nova-demo acks of those
#      prompts. Keeps the storyboard scrollback (May 3-4) intact.
#   5. Smoke-test the result. The script exits non-zero if smoke goes red.
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
# 4. Hard-delete every demo-pod message created after the storyboard
#    cutoff (2026-05-05 00:00 UTC). The storyboard is May 3–4, 2026 —
#    16 messages, hand-curated. Anything later is sprint test residue:
#    byo-* install intros, @nova smoke prompts, model-failure replies,
#    Nova acks. A single date cutoff is the cleanest discriminator —
#    pattern matching kept missing variants ("smoke" vs "smoke-test-"
#    vs "Hi all", etc.). Override CUTOFF_UTC if the storyboard ever
#    gets re-seeded forward.
# ──────────────────────────────────────────────────────────────────────────
CUTOFF_UTC="${CUTOFF_UTC:-2026-05-05 00:00:00+00}"
echo "[reset] (4/5) hard-deleting post-storyboard chat (>$CUTOFF_UTC)…"
deleted=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const { Client } = require('pg');
(async () => {
  const pg = new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: process.env.PG_SSL_DISABLED === 'true' ? false : { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(
    \`DELETE FROM messages WHERE pod_id = \$1 AND created_at > \$2::timestamptz\`,
    ['$DEMO_POD', '$CUTOFF_UTC']
  );
  console.log(r.rowCount);
  await pg.end();
})().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null | tail -1)
echo "[reset]     deleted $deleted post-cutoff message(s)"

# ──────────────────────────────────────────────────────────────────────────
# 5. Re-run smoke to verify the reset didn't break anything.
# ──────────────────────────────────────────────────────────────────────────
echo "[reset] (5/5) running smoke-test-demo.sh…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if bash "$SCRIPT_DIR/smoke-test-demo.sh"; then
  echo "[reset] ✅ reset complete, smoke green"
  exit 0
else
  echo "[reset] ❌ smoke red after reset — investigate" >&2
  exit 1
fi
