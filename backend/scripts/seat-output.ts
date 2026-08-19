#!/usr/bin/env node
/*
 * Which seats are producing output, and which are silent — and why.
 *
 * Everything here is already persisted on AgentEvent (`delivery.outcome`,
 * `delivery.reason`, `status`, `attempts`). Nothing surfaced it, so answering
 * "is this agent working?" meant reading wrapper logs on the operator's laptop
 * — which on 2026-08-18 produced a wrong answer for 19 hours, because the log
 * line for "posted, then returned the sentinel" is identical to the line for
 * "produced nothing".
 *
 * The kernel knows. It records `outcome: 'posted'` with the messageId. Ask it.
 *
 * Usage:
 *   node dist/scripts/seat-output.js               # last 60 min
 *   node dist/scripts/seat-output.js --minutes 240
 *   node dist/scripts/seat-output.js --agent fable-lead
 *
 * Reads only. Safe to run against production.
 */

/* eslint-disable no-console */
const mongoose = require('mongoose');

const argMinutes = process.argv.indexOf('--minutes');
const WINDOW_MIN = argMinutes > -1 ? Number(process.argv[argMinutes + 1]) || 60 : 60;
const argAgent = process.argv.indexOf('--agent');
const ONLY_AGENT = argAgent > -1 ? String(process.argv[argAgent + 1] || '').toLowerCase() : null;

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const events = mongoose.connection.collection('agentevents');

  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000);
  const match: Record<string, unknown> = { createdAt: { $gte: since } };
  if (ONLY_AGENT) match.agentName = ONLY_AGENT;

  const rows = await events.aggregate([
    { $match: match },
    {
      $group: {
        _id: { agent: '$agentName', instance: '$instanceId' },
        total: { $sum: 1 },
        posted: { $sum: { $cond: [{ $eq: ['$delivery.outcome', 'posted'] }, 1, 0] } },
        noAction: { $sum: { $cond: [{ $eq: ['$delivery.outcome', 'no_action'] }, 1, 0] } },
        errored: { $sum: { $cond: [{ $eq: ['$delivery.outcome', 'error'] }, 1, 0] } },
        // Terminal 'failed' is the dead-letter surface: these events hit the
        // requeue cap and will never be served again. Nothing else shows them.
        deadLettered: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        stillPending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        lastPostedAt: {
          $max: { $cond: [{ $eq: ['$delivery.outcome', 'posted'] }, '$delivery.updatedAt', null] },
        },
      },
    },
    { $sort: { posted: 1, total: -1 } },
  ]).toArray();

  console.log(`\nSeat output, last ${WINDOW_MIN} min (since ${since.toISOString()})\n`);
  console.log(
    'seat'.padEnd(22)
    + 'events'.padStart(7) + 'posted'.padStart(8) + 'no_act'.padStart(8)
    + 'error'.padStart(7) + 'DEAD'.padStart(6) + 'pend'.padStart(6) + '  last posted',
  );

  // Outcome-silence is NOT seat-silence. The native tier acks 'acknowledged'
  // and never writes `delivery.outcome: 'posted'`, so keying on that alone
  // reports a perfectly healthy user-facing agent as mute — which this script
  // did on its first run, against `scout` (68 replies in 7 days) and against
  // the `commonly-bot` 288-event row in its own output.
  //
  // So before calling a seat silent, ask the message ledger. Caught in review
  // by fable-lead; the native-tier outcome write is a separate kernel issue,
  // not a blocker for this detector.
  // Chat messages live in POSTGRES, not Mongo (CLAUDE.md: "PostgreSQL —
  // default for chat messages"). Querying mongo's `messages` here returned 0
  // for every seat, so the cross-check silently never fired and the detector
  // kept reporting "produced nothing" for agents that were posting fine —
  // reintroducing, inside the fix for it, the exact error this script exists
  // to catch. Same mistake was made earlier the same day against scout.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { Pool } = require('pg');
  const pg = new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: { rejectUnauthorized: false },
  });
  const silent: string[] = [];
  const postingUnrecorded: string[] = [];
  for (const r of rows) {
    const seat = `${r._id.agent}${r._id.instance && r._id.instance !== 'default' ? `:${r._id.instance}` : ''}`;
    if (r.posted === 0 && r.total > 0) {
      // Identity fans out per user (`scout` has 115 rows: scout + scout-u<hash>).
      // One row is not the agent — resolve the whole set or undercount silently.
      const identities = await mongoose.connection.collection('users')
        .find({ 'botMetadata.agentName': r._id.agent }, { projection: { _id: 1 } })
        .toArray();
      const wrote = identities.length
        ? Number((await pg.query(
          'select count(*)::int n from messages where user_id = any($1) and created_at >= $2',
          [identities.map((u: { _id: unknown }) => String(u._id)), since],
        )).rows[0].n)
        : 0;
      if (wrote > 0) postingUnrecorded.push(`${seat} (${wrote} in ledger)`);
      else silent.push(seat);
    }
    console.log(
      seat.padEnd(22)
      + String(r.total).padStart(7) + String(r.posted).padStart(8) + String(r.noAction).padStart(8)
      + String(r.errored).padStart(7) + String(r.deadLettered).padStart(6)
      + String(r.stillPending).padStart(6)
      + '  ' + (r.lastPostedAt ? new Date(r.lastPostedAt).toISOString() : '—'),
    );
  }

  // The question this script exists to answer, stated outright rather than
  // left for the reader to infer from a table.
  if (silent.length) {
    console.log(`\n⚠ woken but produced nothing: ${silent.join(', ')}`);
    console.log('  Reasons given, most frequent first:');
    // Group by (agent, instance) and compare the SAME composed label used
    // above. Grouping on bare agentName while `silent[]` holds
    // "agent:instance" means the match never fires for a suffixed seat — so
    // the explanation went missing exactly when it was needed. Found in
    // review by fable-lead.
    const reasons = await events.aggregate([
      { $match: { ...match, 'delivery.outcome': { $in: ['no_action', 'error'] } } },
      {
        $group: {
          _id: { agent: '$agentName', instance: '$instanceId', reason: '$delivery.reason' },
          n: { $sum: 1 },
        },
      },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ]).toArray();
    for (const r of reasons) {
      const label = `${r._id.agent}${r._id.instance && r._id.instance !== 'default' ? `:${r._id.instance}` : ''}`;
      if (!silent.includes(label)) continue;
      console.log(`    ${label.padEnd(20)} ${String(r._id.reason || '(none given)').padEnd(28)} ${r.n}`);
    }
  } else {
    console.log('\n✓ every woken seat posted at least once in the window');
  }

  if (postingUnrecorded.length) {
    console.log(`\nℹ posting, outcomes unrecorded by this tier: ${postingUnrecorded.join(', ')}`);
    console.log('  These wrote to the message ledger but never recorded delivery.outcome:"posted".');
    console.log('  Not a silent seat — a native-tier ack gap. Separate kernel issue.');
  }

  const totalDead = rows.reduce((a: number, r: Record<string, number>) => a + (r.deadLettered || 0), 0);
  if (totalDead > 0) {
    console.log(`\n⚠ ${totalDead} event(s) in terminal 'failed' — hit the requeue cap, never retried, invisible to list(). See #998.`);
  }

  await pg.end();
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
