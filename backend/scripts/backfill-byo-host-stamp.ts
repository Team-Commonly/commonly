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

  // Deliberately NOT filtered in the query: `config` is a Mixed/Map field
  // across generations of install rows, so shape-matching in Mongo silently
  // misses variants. Filter in JS where the shape is inspectable.
  const rows = await AgentInstallation.find({}).select('agentName instanceId podId config status');

  const candidates = rows.filter((row: any) => {
    const runtime = row?.config?.runtime;
    if (!runtime || typeof runtime !== 'object') return false;
    if (runtime.host) return false;
    if (runtime.webhookUrl) return false;
    return String(runtime.runtimeType || '').toLowerCase() === 'webhook';
  });

  console.log(`installs scanned:      ${rows.length}`);
  console.log(`already stamped:       ${rows.filter((r: any) => r?.config?.runtime?.host).length}`);
  console.log(`push webhooks skipped: ${rows.filter((r: any) => r?.config?.runtime?.webhookUrl).length}`);
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
    const runtime = { ...(row.config.runtime || {}), host: 'byo' };
    // Assign the whole config object back: Mixed paths do not reliably mark
    // themselves dirty on nested mutation, which is the classic way a
    // migration reports success and writes nothing.
    row.config = { ...(row.config || {}), runtime };
    row.markModified('config');
    // eslint-disable-next-line no-await-in-loop
    await row.save();
    stamped += 1;
  }

  console.log(`\nstamped ${stamped} installs.`);
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
