#!/usr/bin/env node
/*
 * Stamp `config.runtime.host = 'byo'` on self-serve polling seats that were
 * created without it.
 *
 * Every self-serve BYO seat has been born mislabelled. The connect page posts
 * `runtimeType: 'webhook'` — ADR-006's self-serve branch requires that value to
 * synthesize a manifest — while the user never runs a webhook; they run
 * `commonly agent run`, which POLLS. No `host` was written, so
 * `deriveAgentState` asks push-webhook? / native? / byo?, gets no to all three,
 * and answers `unknown`.
 *
 * Measured on production 2026-08-14 (pod-architect): 202 of 314 active installs
 * derive `unknown`, and every real BYO user seat is in that 202 — including all
 * four users who mentioned a seat with nobody home and got silence (m0re 08-04,
 * l3r0ys4n3 08-07, user-8863 08-09, ngoc-tran 08-10). The honesty surface, the
 * install intro (#943) and W4's stalled-connect trigger all read that
 * derivation, so all three are inert for exactly the people they exist to
 * protect until these rows are corrected.
 *
 * `registry/install.ts` closes this going forward. This script is the
 * historical half — read-side normalization CANNOT substitute for it, because
 * `normalizeRuntimeIdentity` can only rescue the legacy `local-cli` +
 * `wrappedCli` shape and these rows carry neither. There is nothing in them to
 * infer from; the information has to be put back.
 *
 * Discriminator, identical to the write path: a PUSH webhook must supply
 * `webhookUrl` (no registry route writes that field — it only ever arrives in
 * caller config), so webhook-typed WITHOUT a URL is a polling seat. Rows with
 * an explicit host are never touched.
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-byo-host-stamp.ts          # dry run
 *   npx ts-node backend/scripts/backfill-byo-host-stamp.ts --apply
 */

/* eslint-disable no-console */
const mongoose = require('mongoose');
const { AgentInstallation } = require('../models/AgentRegistry');

const APPLY = process.argv.includes('--apply');

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);

  // `.lean()` is load-bearing, not an optimization. `config` is declared
  // `{ type: Map, of: Mixed }` (AgentRegistry.ts:235), so on a live Mongoose
  // document `config.runtime` is undefined — a Map needs `.get()`. The first
  // version of this script omitted `.lean()` and its dry run reported
  // "scanned 545, already stamped 0, candidates 0" against a database where
  // two seats were demonstrably stamped and ~200 were candidates. Every row
  // filtered out on a property that cannot exist.
  //
  // With `--apply` that would have written nothing and printed success: the
  // migration-reports-success-and-writes-nothing failure this file already
  // warns about below, arriving through a different door. The dry run is what
  // caught it.
  const rows = await AgentInstallation.find({})
    .select('agentName instanceId podId config status')
    .lean();

  const runtimeOf = (row: any) => {
    const config = row?.config;
    if (!config) return null;
    // Defensive both ways: lean() gives a plain object, but a caller that
    // hands this a live document should degrade to a correct read rather than
    // a silent empty one.
    const runtime = typeof config.get === 'function' ? config.get('runtime') : config.runtime;
    return runtime && typeof runtime === 'object' ? runtime : null;
  };

  const candidates = rows.filter((row: any) => {
    const runtime = runtimeOf(row);
    if (!runtime) return false;
    if (runtime.host) return false;
    if (runtime.webhookUrl) return false;
    return String(runtime.runtimeType || '').toLowerCase() === 'webhook';
  });

  console.log(`installs scanned:      ${rows.length}`);
  console.log(`already stamped:       ${rows.filter((r: any) => runtimeOf(r)?.host).length}`);
  console.log(`push webhooks skipped: ${rows.filter((r: any) => runtimeOf(r)?.webhookUrl).length}`);
  console.log(`candidates to stamp:   ${candidates.length}`);
  candidates.slice(0, 20).forEach((row: any) => {
    console.log(`  ${row.agentName}:${row.instanceId || 'default'} pod=${row.podId} status=${row.status}`);
  });
  if (candidates.length > 20) console.log(`  … and ${candidates.length - 20} more`);

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  let stamped = 0;
  for (const row of candidates) {
    // `updateOne` with a dotted path rather than load-mutate-save. The rows
    // are lean (see the scan above), so there is no document to save; and a
    // dotted `$set` on a Map path writes the one key without rewriting the
    // whole config, so a concurrent install touching another key is not
    // clobbered. It also sidesteps the Mixed-path dirty-tracking problem that
    // the load-mutate-save shape has to remember to handle.
    // eslint-disable-next-line no-await-in-loop
    const res = await AgentInstallation.updateOne(
      { _id: row._id },
      { $set: { 'config.runtime.host': 'byo' } },
    );
    // Count what the DB says it changed, not what we intended — the whole
    // reason this script needed a second pass.
    stamped += (res?.modifiedCount ?? res?.nModified ?? 0);
  }

  console.log(`\nstamped ${stamped} installs.`);
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
