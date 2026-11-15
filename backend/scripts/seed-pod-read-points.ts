#!/usr/bin/env node
/*
 * Seed a first pod read point for every human member of every pod who has
 * none, so their first return after #4150 shows "New since your last visit".
 * Each seed is the later of the member's thread read point and last message in
 * that pod, else their last-active time, never later than now. A row that
 * exists is never touched, so this is safe to re-run. The GET path seeds the
 * same way on a first visit but without last-active (that request has just
 * moved it to now), so run this right after the deploy that ships it.
 *
 * Prints counts only, never who.
 *
 * Usage (ops-runner, from /app):
 *   node dist/scripts/seed-pod-read-points.js            # dry run
 *   node dist/scripts/seed-pod-read-points.js --apply
 */

/* eslint-disable no-console, @typescript-eslint/no-require-imports */
const mongoose = require('mongoose');
const Pod = require('../models/Pod');
const User = require('../models/User');
const { pool } = require('../config/db-pg');
const { seedAllPodReadPoints } = require('../services/podReadPointSeed');

const APPLY = process.argv.includes('--apply');

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  if (!pool) throw new Error('PostgreSQL is not configured (PG_HOST unset)');
  await mongoose.connect(uri);
  try {
    const humans = await User.find({ isBot: { $ne: true } }).select('_id lastActive').lean();
    const lastActiveByUser = new Map<string, unknown>(
      humans.map((u: { _id: unknown; lastActive?: unknown }) => [String(u._id), u.lastActive ?? null]),
    );
    const podRows = await Pod.find({}).select('_id members').lean();
    const pods = podRows.map((p: { _id: unknown; members?: unknown[] }) => ({
      podId: String(p._id),
      memberIds: (p.members || []).map((m) => String((m as { _id?: unknown })?._id ?? m)),
    }));
    const counts = await seedAllPodReadPoints({ pods, lastActiveByUser, apply: APPLY });
    console.log(`pods: ${pods.length}`);
    console.log(JSON.stringify(counts));
    console.log(APPLY ? 'APPLIED' : 'DRY RUN: re-run with --apply to write.');
  } finally {
    await mongoose.disconnect();
    await pool.end();
  }
};

main().catch((error: Error) => {
  console.error('seed-pod-read-points failed:', error.message);
  process.exit(1);
});
