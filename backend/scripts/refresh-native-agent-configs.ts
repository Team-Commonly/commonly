#!/usr/bin/env node
/*
 * Re-project native-agent manifests onto their existing installations.
 *
 * ADR-001: one manifest, N runtime projections, and UPDATES PROPAGATE. The
 * signup path stamps buildInstallationConfig(manifest) at install time, so a
 * manifest change (new tool grant, prompt change, cap change) reaches new
 * users only. This script carries it to existing installs.
 *
 * MERGE, NOT REPLACE (2026-10-14). The first version assigned the whole
 * projection to `config`. Run for Scout, that would have wiped per-install keys
 * and re-enabled wake flags operators had turned off. So it now:
 *   - rewrites only MANIFEST_CONFIG_KEYS, and removes those the manifest no
 *     longer declares;
 *   - never touches wake policy (INSTALL_TIME_ONLY_CONFIG_KEYS) or any other
 *     per-install key;
 *   - saves only installs whose manifest keys actually differ.
 *
 * Scope is explicit: --app <name> (repeatable or comma-separated) or --all.
 * --skip-pod <podId> leaves a pod's installs alone. It is a DRY RUN unless
 * --apply is passed. The dry run prints, per install, which keys would change,
 * be added or be removed, with strings shown as length and hash rather than text.
 *
 * Config-only: never touches identity (agentName/instanceId/User rows),
 * membership, memory, or status.
 *
 * Usage:
 *   node dist/scripts/refresh-native-agent-configs.js --app scout             # plan
 *   node dist/scripts/refresh-native-agent-configs.js --app scout --apply     # write
 *   node dist/scripts/refresh-native-agent-configs.js --all --skip-pod <id>   # plan, every app
 */

import crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MANIFEST_CONFIG_KEYS } = require('./seed-native-agents');

type Config = Record<string, unknown>;

/** JSON with object keys sorted at every depth, so key order is never a diff. */
export const stableStringify = (value: unknown): string => JSON.stringify(value, (_key, val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return Object.keys(val as Config).sort().reduce((out: Config, k) => {
      // eslint-disable-next-line no-param-reassign
      out[k] = (val as Config)[k];
      return out;
    }, {});
  }
  return val;
});

export interface RefreshPlan {
  next: Config;
  changed: string[];
  added: string[];
  removed: string[];
  /** Keys on the install that are not the manifest's, left exactly as found. */
  kept: string[];
}

export function planConfigRefresh(
  current: Config,
  projected: Config,
  manifestKeys: readonly string[] = MANIFEST_CONFIG_KEYS,
): RefreshPlan {
  const has = (obj: Config, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
  const next: Config = { ...current };
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  manifestKeys.forEach((key) => {
    if (has(projected, key)) {
      if (!has(current, key)) {
        added.push(key);
        next[key] = projected[key];
      } else if (stableStringify(current[key]) !== stableStringify(projected[key])) {
        changed.push(key);
        next[key] = projected[key];
      }
    } else if (has(current, key)) {
      removed.push(key);
      delete next[key];
    }
  });
  const kept = Object.keys(current).filter((key) => !manifestKeys.includes(key)).sort();
  return {
    next, changed, added, removed, kept,
  };
}

export const hasChanges = (plan: RefreshPlan): boolean => (
  plan.changed.length + plan.added.length + plan.removed.length > 0
);

/** A value as it may be printed: strings as length and hash, the rest as clipped JSON. */
export const describeValue = (value: unknown): string => {
  if (value === undefined) return '(absent)';
  if (typeof value === 'string') {
    const sha = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
    return `string len=${value.length} sha=${sha}`;
  }
  const json = stableStringify(value);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
};

export interface RefreshArgs {
  apps: string[] | 'all';
  skipPods: Set<string>;
  apply: boolean;
}

export function parseArgs(argv: string[]): RefreshArgs {
  const apps: string[] = [];
  const skipPods = new Set<string>();
  let all = false;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') all = true;
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry') { /* the default; accepted so old invocations stay read-only */ }
    else if (arg === '--app' || arg === '--skip-pod') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      const values = value.split(',').map((v) => v.trim()).filter(Boolean);
      if (arg === '--app') apps.push(...values);
      else values.forEach((v) => skipPods.add(v));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (all && apps.length) throw new Error('pass --app or --all, not both');
  if (!all && !apps.length) throw new Error('pass --app <name> (repeatable) or --all; the scope is never implied');
  return { apps: all ? 'all' : apps, skipPods, apply };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mongoose = require('mongoose');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildInstallationConfig } = require('./seed-native-agents');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FIRST_PARTY_APPS } = require('../config/native-agents/apps');

  const known = FIRST_PARTY_APPS.map((a: { agentName: string }) => a.agentName);
  if (args.apps !== 'all') {
    const unknown = args.apps.filter((name) => !known.includes(name));
    if (unknown.length) throw new Error(`unknown app(s): ${unknown.join(', ')}; known: ${known.join(', ')}`);
  }
  const selected = args.apps === 'all'
    ? FIRST_PARTY_APPS
    : FIRST_PARTY_APPS.filter((a: { agentName: string }) => (args.apps as string[]).includes(a.agentName));

  const mode = args.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)';
  console.log(`[config-refresh] ${mode}; apps: ${selected.map((a: { agentName: string }) => a.agentName).join(', ')}`);
  await mongoose.connect(uri);
  const totals = {
    installs: 0, differing: 0, written: 0, unchanged: 0, skipped: 0,
  };

  for (const app of selected) {
    const projected = buildInstallationConfig(app) as Config;
    // eslint-disable-next-line no-await-in-loop
    const installs = await AgentInstallation.find({ agentName: app.agentName, status: 'active' });
    for (const install of installs) {
      totals.installs += 1;
      const where = `${app.agentName} pod=${String(install.podId)} instance=${install.instanceId || 'default'}`;
      if (args.skipPods.has(String(install.podId))) {
        totals.skipped += 1;
        console.log(`[config-refresh] ${where}: skipped (--skip-pod)`);
        continue; // eslint-disable-line no-continue
      }
      const raw = install.config;
      const current: Config = raw instanceof Map ? Object.fromEntries(raw) : { ...(raw || {}) };
      const plan = planConfigRefresh(current, projected);
      if (!hasChanges(plan)) {
        totals.unchanged += 1;
        continue; // eslint-disable-line no-continue
      }
      totals.differing += 1;
      const lines = [
        ...plan.changed.map((k) => `  ~ ${k}: ${describeValue(current[k])} -> ${describeValue(projected[k])}`),
        ...plan.added.map((k) => `  + ${k}: ${describeValue(projected[k])}`),
        ...plan.removed.map((k) => `  - ${k}: ${describeValue(current[k])}`),
        `  kept as found: ${plan.kept.join(', ') || '(none)'}`,
      ];
      console.log(`[config-refresh] ${where}:\n${lines.join('\n')}`);
      if (args.apply) {
        install.config = plan.next;
        // eslint-disable-next-line no-await-in-loop
        await install.save();
        totals.written += 1;
      }
    }
  }

  await mongoose.disconnect();
  console.log(`[config-refresh] done: ${JSON.stringify(totals)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[config-refresh] failed:', err?.message || err);
    process.exit(1);
  });
}
