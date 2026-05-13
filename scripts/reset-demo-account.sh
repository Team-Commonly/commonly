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
echo "[reset] (4a/5) hard-deleting post-storyboard chat (>$CUTOFF_UTC)…"
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

# Marketplace-install Playwright walkthroughs create agent-room pods.
# Sidebar pollution: each test install leaves a "Talk to <agent>" room
# in the sam-demo Today/Yesterday list. Delete agent-rooms created
# after the cutoff EXCEPT the canonical Nova/Pixel/Cody storyboard
# rooms (those are pre-seeded baseline).
echo "[reset] (4b/5) deleting test-residue agent-room + agent-dm pods…"
deleted_rooms=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const m=require('mongoose');
m.connect(process.env.MONGO_URI).then(async ()=>{
  const Pod=m.connection.db.collection('pods');
  const cutoff = new Date('$CUTOFF_UTC');
  // agent-room: \"Talk to <agent>\" pods from install-handoff or
  // marketplace install flows. Preserve the canonical Nova/Pixel/Cody
  // storyboard rooms.
  // agent-dm: bot-to-bot 2-member pods created by talk-to-cli smoke
  // (byo-smoke-XXX ↔ codex-bot-codex). Anything created after cutoff
  // is test residue EXCEPT the canonical Nova-Demo↔Cody seed
  // (6a01a1ffcf199a9aed01d9d1) — that's the B1 fixture so the
  // inspector's Direct Messages card has live data to surface.
  const KEEP_DM_IDS = ['6a01a1ffcf199a9aed01d9d1'];
  const roomRes = await Pod.deleteMany({ type: 'agent-room', createdAt: { \$gt: cutoff }, name: { \$nin: ['Nova', 'Pixel', 'Cody'] } });
  const dmRes = await Pod.deleteMany({ type: 'agent-dm', createdAt: { \$gt: cutoff }, _id: { \$nin: KEEP_DM_IDS.map(id => m.Types.ObjectId.createFromHexString(id)) } });
  console.log(roomRes.deletedCount + dmRes.deletedCount);
  process.exit(0);
})" 2>/dev/null | tail -1)
echo "[reset]     deleted $deleted_rooms test pod(s)"

# Pull sam-demo from any agent-admin pods. agent-admin is N:1
# (multiple admins ↔ one agent) per ADR-001 — but sam-demo is
# role:user and the demo narrative doesn't position them as
# admin of anything. Every install they perform adds them to a
# new agent-admin pod via dmService.getOrCreateAgentDM (the
# "installer is admin" platform pattern). For the demo's
# scrollback hygiene we don't want those pods cluttering the
# sidebar — yank sam-demo out.
echo "[reset] (4b.1) pulling sam-demo from agent-admin pods…"
pulled=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const m=require('mongoose');
m.connect(process.env.MONGO_URI).then(async ()=>{
  const Pod=m.connection.db.collection('pods');
  const SAM='69f8417317b1da6d89b37fba';
  const r=await Pod.updateMany(
    {type:'agent-admin', members: m.Types.ObjectId.createFromHexString(SAM)},
    {\$pull:{members: m.Types.ObjectId.createFromHexString(SAM)}}
  );
  console.log(r.modifiedCount);
  process.exit(0);
})" 2>/dev/null | tail -1)
echo "[reset]     pulled sam-demo from $pulled agent-admin pod(s)"

# Re-seed the canonical Nova-Demo ↔ Cody a2a-dm if missing. The B1
# fixture (inspector "Direct messages" card) needs at least one live
# A2A DM involving nova-demo to render. Talk-to-cli smoke creates
# byo-smoke-* ↔ codex DMs but those aren't surfaced under the
# instanceId=nova-demo query the inspector uses.
echo "[reset] (4c/5) reseeding Nova-Demo↔Cody A2A DM if absent…"
seeded=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const m=require('mongoose');
m.connect(process.env.MONGO_URI).then(async ()=>{
  const Pod=m.connection.db.collection('pods');
  const SEED_ID='6a01a1ffcf199a9aed01d9d1';
  const NOVA_DEMO_ID='6a0197d1deeccd27ced8c175';
  const CODY_ID='69f841c3063269526de047d4';
  const existing=await Pod.findOne({_id:m.Types.ObjectId.createFromHexString(SEED_ID)});
  if (existing) { console.log(0); process.exit(0); }
  await Pod.insertOne({
    _id: m.Types.ObjectId.createFromHexString(SEED_ID),
    name: 'Nova-Demo ↔ Cody',
    description: 'Seeded a2a DM — B1 inspector fixture',
    type: 'agent-dm',
    createdBy: m.Types.ObjectId.createFromHexString(NOVA_DEMO_ID),
    members: [
      m.Types.ObjectId.createFromHexString(NOVA_DEMO_ID),
      m.Types.ObjectId.createFromHexString(CODY_ID),
    ],
    joinPolicy: 'invite-only',
    messages: [],
    announcements: [],
    externalLinks: [],
    contacts: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    __v: 0,
  });
  console.log(1);
  process.exit(0);
})" 2>/dev/null | tail -1)
echo "[reset]     seeded $seeded Nova-Demo↔Cody pod(s)"

# ──────────────────────────────────────────────────────────────────────────
# 4d. Seed reactions on storyboard messages so reviewers see the
#     reactions feature in use. Idempotent: ON CONFLICT DO NOTHING on
#     the (message_id, user_id, emoji) unique index. UIDs hardcoded to
#     the canonical storyboard authors.
# ──────────────────────────────────────────────────────────────────────────
echo "[reset] (4d/5) seeding storyboard reactions…"
seeded_reactions=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const { Client } = require('pg');
(async () => {
  const pg = new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: process.env.PG_SSL_DISABLED === 'true' ? false : { rejectUnauthorized: false } });
  await pg.connect();
  // [message_id, user_id, emoji] — exercises both agent-on-human and
  // human-on-agent and agent-on-agent reactions, plus multi-reactor
  // chips on key messages.
  const SAM='69f8417317b1da6d89b37fba';
  const MIKE='69f8417417b1da6d89b37fbd';
  const NOVA='69f841c1063269526de04784';
  const PIXEL='69f841c5063269526de04821';
  const CODY='69f841c3063269526de047d4';
  const seeds = [
    [15155, SAM, '👍'],        // Sam ack of Mike's 'will share tonight'
    [15156, SAM, '👍'],        // Sam ack of Nova starting on signup
    [15156, MIKE, '👀'],       // Mike watching
    [15157, PIXEL, '👍'],      // Pixel agrees with Mike's OAuth-first reco
    [15157, CODY, '👀'],
    [15158, NOVA, '👍'],       // Nova approves Pixel's telemetry pull
    [15189, SAM, '🎉'],        // Sam celebrates Nova's overnight scaffold
    [15189, CODY, '👍'],
    [15202, PIXEL, '👍'],      // Pixel acks Cody's test alignment
    [15245, SAM, '🎉'],        // Sam celebrates Pixel's OAuth-first analysis
    [15245, NOVA, '👍'],
    [15245, CODY, '👍'],
  ];
  let added = 0;
  for (const [mid, uid, emoji] of seeds) {
    const r = await pg.query(
      \`INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES (\$1, \$2, \$3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING\`,
      [mid, uid, emoji]
    );
    added += r.rowCount;
  }
  console.log(added);
  await pg.end();
})().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null | tail -1)
echo "[reset]     seeded $seeded_reactions storyboard reaction(s)"

# ──────────────────────────────────────────────────────────────────────────
# 4e. Seed agent-to-agent DM content so reviewers clicking the
#     Nova-Demo↔Cody inspector link see a real conversation, not an
#     empty pod. Each insert is conditional on the pod having ZERO
#     messages — if a reviewer wrote into it (read-only on the demo
#     account so unlikely, but defensive), don't clobber.
# ──────────────────────────────────────────────────────────────────────────
echo "[reset] (4e/5) seeding Nova-Demo↔Cody DM content if empty…"
A2A_DM_POD_ID='6a01a1ffcf199a9aed01d9d1'
seeded_a2a=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const { Client } = require('pg');
(async () => {
  const pg = new Client({ host: process.env.PG_HOST, port: +process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: process.env.PG_SSL_DISABLED === 'true' ? false : { rejectUnauthorized: false } });
  await pg.connect();
  const podId = '$A2A_DM_POD_ID';
  const existing = await pg.query('SELECT COUNT(*) AS n FROM messages WHERE pod_id = \$1', [podId]);
  if (Number(existing.rows[0].n) > 0) { console.log(0); await pg.end(); process.exit(0); }
  const NOVA_DEMO='6a0197d1deeccd27ced8c175';
  const CODY='69f841c3063269526de047d4';
  // Backdate to May 4 so the messages match the storyboard chronology
  // when reviewer opens the inspector → DM link.
  const seeds = [
    [CODY, 'hey @nova — spec patch is in PR #471. left email as fallback per slide 3. ok to ship?', '2026-05-04T21:08:00Z'],
    [NOVA_DEMO, 'Looks right. The OAuth-first phrasing aligns with the wireframes; email-fallback is the cleaner story for the doc. Approved.', '2026-05-04T21:09:00Z'],
    [CODY, 'thx — landing it now.', '2026-05-04T21:09:30Z'],
  ];
  let added = 0;
  for (const [uid, content, ts] of seeds) {
    await pg.query(
      \`INSERT INTO messages (pod_id, user_id, content, message_type, created_at)
       VALUES (\$1, \$2, \$3, 'text', \$4::timestamptz)\`,
      [podId, uid, content, ts]
    );
    added++;
  }
  console.log(added);
  await pg.end();
})().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null | tail -1)
echo "[reset]     seeded $seeded_a2a Nova-Demo↔Cody message(s)"

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
