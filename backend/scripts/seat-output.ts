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

  const silent: string[] = [];
  for (const r of rows) {
    const seat = `${r._id.agent}${r._id.instance && r._id.instance !== 'default' ? `:${r._id.instance}` : ''}`;
    if (r.posted === 0 && r.total > 0) silent.push(seat);
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
    const reasons = await events.aggregate([
      { $match: { ...match, 'delivery.outcome': { $in: ['no_action', 'error'] } } },
      { $group: { _id: { agent: '$agentName', reason: '$delivery.reason' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ]).toArray();
    for (const r of reasons) {
      if (!silent.includes(r._id.agent)) continue;
      console.log(`    ${String(r._id.agent).padEnd(20)} ${String(r._id.reason || '(none given)').padEnd(28)} ${r.n}`);
    }
  } else {
    console.log('\n✓ every woken seat posted at least once in the window');
  }

  const totalDead = rows.reduce((a: number, r: Record<string, number>) => a + (r.deadLettered || 0), 0);
  if (totalDead > 0) {
    console.log(`\n⚠ ${totalDead} event(s) in terminal 'failed' — hit the requeue cap, never retried, invisible to list(). See #998.`);
  }

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
