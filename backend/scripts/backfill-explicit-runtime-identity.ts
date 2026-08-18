#!/usr/bin/env node
/*
 * Write each install's EFFECTIVE runtime identity down explicitly, so the
 * runtime stops being a function of the agent's name.
 *
 * Measured on production 2026-08-16 (pod-architect): 191 of 333 active
 * installs carry no explicit `runtimeType`. The read path fills it from
 * `AGENT_TYPES[agentName]`, so for the majority the runtime IS derived from
 * the name — and the name is also the memory key `(agentName, instanceId)`.
 * There is therefore nowhere to record "this seat runs BYO now" except by
 * renaming it, which would move its memory.
 *
 * That is why ADR-022's "persona and runtime are chosen separately" is a
 * migration and not a refactor: until the runtime is a field, a user cannot
 * change it without changing who the agent is.
 *
 * BEHAVIOUR-PRESERVING BY CONSTRUCTION. This script does not reimplement the
 * derivation — it calls `sanitizeRuntimeConfig`, the exported read path that
 * every consumer already goes through, and writes back exactly what it
 * returns. A reimplementation here would be a second copy of a subtle rule
 * (legacy `local-cli` + `wrappedCli` rewrite, the LEGACY_RUNTIME_RENAME map,
 * the cloud default) and would drift from the original the first time either
 * changed. Nothing observable changes on apply: rows stop *deriving* what
 * they now *state*.
 *
 * Rows already carrying an explicit runtimeType AND host are untouched.
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-explicit-runtime-identity.ts
 *   npx ts-node backend/scripts/backfill-explicit-runtime-identity.ts --apply
 *   ... --include-inactive     # default is ACTIVE only; see #949's reasoning
 */

/* eslint-disable no-console */
const mongoose = require('mongoose');
const { AgentInstallation } = require('../models/AgentRegistry');
const { sanitizeRuntimeConfig } = require('../routes/registry/helpers');

const APPLY = process.argv.includes('--apply');
const INCLUDE_INACTIVE = process.argv.includes('--include-inactive');

// `.lean()` is load-bearing, not an optimization — `config` is
// `{ type: Map, of: Mixed }`, so on a live document `config.runtime` is
// undefined and every row would filter out on a property that cannot exist.
// #948 shipped exactly that bug: a dry run reporting "candidates 0" against a
// database with ~200 of them, and with --apply it would have written nothing
// and printed success. Defensive both ways below.
const runtimeOf = (row: any) => {
  const config = row?.config;
  if (!config) return null;
  const runtime = typeof config.get === 'function' ? config.get('runtime') : config.runtime;
  return runtime && typeof runtime === 'object' ? runtime : null;
};

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const rows = await AgentInstallation.find({})
    .select('agentName instanceId podId config status')
    .lean();

  const byStatus: Record<string, number> = {};
  const candidates: Array<{
    row: any; from: any; to: any;
  }> = [];

  for (const row of rows as any[]) {
    const runtime = runtimeOf(row) || {};
    let normalized;
    try {
      normalized = sanitizeRuntimeConfig(runtime, row.agentName) || {};
    } catch (err) {
      console.warn(`  skip ${row.agentName}/${row.instanceId}: resolver threw — ${(err as Error).message}`);
      continue;
    }

    const needsType = !runtime.runtimeType && normalized.runtimeType;
    const needsHost = !runtime.host && normalized.host;
    const typeChanged = runtime.runtimeType
      && normalized.runtimeType
      && runtime.runtimeType !== normalized.runtimeType;

    if (!needsType && !needsHost && !typeChanged) continue;

    byStatus[row.status || '?'] = (byStatus[row.status || '?'] || 0) + 1;
    candidates.push({
      row,
      from: { runtimeType: runtime.runtimeType ?? null, host: runtime.host ?? null },
      to: { runtimeType: normalized.runtimeType ?? null, host: normalized.host ?? null },
    });
  }

  const scoped = INCLUDE_INACTIVE
    ? candidates
    : candidates.filter((c) => c.row.status === 'active');

  console.log(`scanned ${rows.length} installs`);
  console.log(`rows whose identity is currently DERIVED: ${candidates.length}`);
  console.log(`  by status: ${JSON.stringify(byStatus)}`);
  console.log(`in scope (${INCLUDE_INACTIVE ? 'all' : 'active only'}): ${scoped.length}`);

  const shapes: Record<string, number> = {};
  for (const c of scoped) {
    const k = `${c.from.runtimeType ?? '∅'}/${c.from.host ?? '∅'} → ${c.to.runtimeType ?? '∅'}/${c.to.host ?? '∅'}`;
    shapes[k] = (shapes[k] || 0) + 1;
  }
  console.log('\ntransitions:');
  for (const [k, n] of Object.entries(shapes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }

  console.log('\nsample (first 8):');
  for (const c of scoped.slice(0, 8)) {
    console.log(`  ${String(c.row.agentName).slice(0, 24).padEnd(24)} ${c.from.runtimeType ?? '∅'}/${c.from.host ?? '∅'} → ${c.to.runtimeType ?? '∅'}/${c.to.host ?? '∅'}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const c of scoped) {
    const set: Record<string, unknown> = {};
    if (c.to.runtimeType) set['config.runtime.runtimeType'] = c.to.runtimeType;
    if (c.to.host) set['config.runtime.host'] = c.to.host;
    if (Object.keys(set).length === 0) continue;
    const res = await AgentInstallation.updateOne({ _id: c.row._id }, { $set: set });
    if (res.modifiedCount > 0) written += 1;
  }
  console.log(`\nAPPLIED — ${written} of ${scoped.length} rows modified.`);
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
