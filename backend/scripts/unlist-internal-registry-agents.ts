#!/usr/bin/env node
/*
 * Mark our own internal / smoke-test registry rows `ephemeral: true` so they
 * stop appearing in the public agent catalog.
 *
 * Measured 2026-08-14: `GET /api/registry/agents` returned 66 rows, and among
 * them every internal and smoke-test agent we have ever created — the
 * `smoke*`/`demo*`/`test*` families plus our own working seats
 * (pod-architect, cl-critic, cl-strategist, claude-on-dev, sam-claude,
 * sam-local-codex, nova-claude, hq-support, carol). The landing-page footer
 * links that endpoint, so a logged-out visitor could browse the lot.
 *
 * Why data and not a filter. The first attempt defaulted the catalog to
 * verified-only, and `self-serve-install.test.js` rejected it correctly: a
 * legitimately published third-party agent is unverified too, so that filter
 * would have hidden real publishers to hide our fixtures. `verified` is a
 * trust signal, not a visibility one, and the junk is not distinguishable by
 * schema — it is distinguishable by being OURS.
 *
 * `ephemeral` already means exactly "private to its owner; direct getByName
 * still resolves it, marketplace browse does not" (AgentRegistry.search
 * filters it, and the ADR-006 self-serve rows use it for the same reason).
 * Our test seats fit that definition precisely, so this is a data correction
 * rather than a new concept.
 *
 * Names are matched explicitly, never by pattern. A regex over agent names
 * would eventually swallow a real user's agent called "demo-something" — the
 * blast radius of a wrong guess here is a publisher silently delisted, so the
 * list is enumerated and anything unrecognised is left alone and reported.
 *
 * Usage:
 *   npx ts-node backend/scripts/unlist-internal-registry-agents.ts          # dry run
 *   npx ts-node backend/scripts/unlist-internal-registry-agents.ts --apply
 */

/* eslint-disable no-console */
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

// Enumerated deliberately. Add names here rather than widening a pattern.
const INTERNAL_AGENT_NAMES = [
  // smoke + demo fixtures
  'smoke-claude', 'smoke-stub', 'smokea50698-agent', 'smokea50698-scribe',
  'smokea50698-helper', 'smokea50698-organic',
  'demo-claude', 'demo-claude2', 'demo-clean2', 'demo-target',
  'test-agent', 'test-agent2',
  // our own working seats
  'pod-architect', 'cl-critic', 'cl-strategist', 'claude-on-dev',
  'sam-claude', 'sam-local-codex', 'nova-claude', 'hq-support', 'carol',
];

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const C = mongoose.connection.collection('agentregistries');

  const found = await C.find({ agentName: { $in: INTERNAL_AGENT_NAMES } })
    .project({ agentName: 1, ephemeral: 1, verified: 1, registry: 1 }).toArray();

  const already = found.filter((r: any) => r.ephemeral === true);
  const todo = found.filter((r: any) => r.ephemeral !== true);
  const missing = INTERNAL_AGENT_NAMES.filter(
    (n) => !found.some((r: any) => r.agentName === n),
  );

  console.log(`named:              ${INTERNAL_AGENT_NAMES.length}`);
  console.log(`found in registry:  ${found.length}`);
  console.log(`already ephemeral:  ${already.length}`);
  console.log(`to mark:            ${todo.length}`);
  if (missing.length) console.log(`not present (fine): ${missing.join(', ')}`);
  todo.forEach((r: any) => {
    console.log(`  ${String(r.agentName).padEnd(22)} registry=${r.registry} verified=${r.verified}`);
  });

  // Report, never touch: anything catalog-visible that is NOT on the list.
  // The point is to see what a human should look at next, not to widen scope.
  const visible = await C.find({ status: 'active', ephemeral: { $ne: true } })
    .project({ agentName: 1 }).toArray();
  const remaining = visible
    .map((r: any) => r.agentName)
    .filter((n: string) => !INTERNAL_AGENT_NAMES.includes(n));
  console.log(`\ncatalog after this runs: ${remaining.length} rows`);
  console.log(`  ${remaining.join(', ')}`);

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  const res = await C.updateMany(
    { agentName: { $in: INTERNAL_AGENT_NAMES }, ephemeral: { $ne: true } },
    { $set: { ephemeral: true } },
  );
  // Report what the DB says it changed, not what we intended.
  console.log(`\nmarked ${res.modifiedCount} rows ephemeral.`);
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
