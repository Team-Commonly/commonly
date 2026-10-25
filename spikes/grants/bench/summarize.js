#!/usr/bin/env node
/**
 * Fold bench/out/load.jsonl rounds into one row per label: the median across
 * rounds, with the range in brackets, so one noisy round on a shared machine
 * cannot decide a row.
 *
 * Usage: node bench/summarize.js [bench/out/load.jsonl]
 */
import { readFileSync } from 'node:fs';
import { median } from './common.js';

const rows = readFileSync(process.argv[2] || new URL('./out/load.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fields = ['cpuUsPerCall', 'rps', 'p50Ms', 'p99Ms', 'idleRssMB', 'loadRssMedianMB', 'peakRssMB_timeL', 'settledRssMB', 'errors', 'loadavg1'];
const labels = [...new Set(rows.map((r) => r.label))];
for (const label of labels) {
  const mine = rows.filter((r) => r.label === label);
  const cells = fields.map((f) => {
    const xs = mine.map((r) => r[f]).filter((x) => typeof x === 'number');
    if (!xs.length) return `${f}=-`;
    return `${f}=${median(xs)} [${Math.min(...xs)}..${Math.max(...xs)}]`;
  });
  console.log(`${label} (rounds=${mine.length}): ${cells.join('  ')}`);
}
