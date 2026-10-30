/**
 * repair-first-party-labels — one-shot repair of stored User labels written
 * before the resolver knew the first-party name and the default-instance
 * rule (TASK-551). Only first-party agents (FIRST_PARTY_DISPLAY_NAMES) are
 * touched:
 *
 *   1. A first-party agent whose label is blank, or is its bare agentName
 *      ("scout"), gets its curated label ("Scout").
 *   2. A first-party default-instance row whose label is its curated label plus
 *      the " (Default)" suffix gets the suffix stripped. The collision rules
 *      added that suffix to a non-canonical default row. A label on any other
 *      agent keeps its suffix: the shortest-instanceId rule produces it on
 *      purpose.
 *
 * Both are exact-match rules and idempotent. Dry run unless --apply.
 *
 * A repair is SKIPPED, never written, when its target label is already taken by
 * a non-per-user agent, or when two non-per-user repairs in this run would both
 * land on it. A skipped row keeps its current label and is printed as skipped.
 * Skipping is the decision, not an automatic suffix: which row keeps the bare
 * label is an operator call, and a suffix would silently rename a label someone
 * may have chosen. Per-user rows (opaque instance tokens) never skip or contest
 * a label: every user's Scout shares the bare name by design.
 *
 * Run:  cd backend && npx ts-node scripts/repair-first-party-labels.ts [--apply]
 */
import mongoose from 'mongoose';
import { FIRST_PARTY_DISPLAY_NAMES } from '../constants/firstPartyDisplayNames';

const APPLY = process.argv.includes('--apply');
const DEFAULT_SUFFIX = ' (Default)';
// Keep identical to isOpaquePerUserToken (agentIdentityService) and the dedupe script.
const OPAQUE_PER_USER_TOKEN = /^u[a-f0-9]{10}([a-f0-9]{14})?$/;
const isPerUser = (instanceId = ''): boolean => OPAQUE_PER_USER_TOKEN.test(instanceId.toLowerCase());

export interface LabelRow {
  id: string;
  username?: string;
  agentName?: string;
  instanceId?: string;
  displayName?: string;
}

export interface LabelRepair {
  id: string;
  username: string;
  from: string;
  to: string;
  reason: 'first-party' | 'default-suffix';
  // Set only when the write is skipped: the instance(s) already taking `to`, or
  // the other repairs in this run that land on it.
  heldBy?: string[];
}

// Pure, so the rules are pinned without a database. `takenBy` maps a label to
// the instanceIds of every bot already displaying it.
export function planLabelRepairs(
  rows: LabelRow[],
  takenBy: ReadonlyMap<string, readonly string[]> = new Map(),
): LabelRepair[] {
  const repairs: LabelRepair[] = [];
  for (const row of rows) {
    // Only first-party agents are repaired. A community agent's label is never
    // rewritten here, whatever it says.
    const agentName = (row.agentName || '').trim().toLowerCase();
    const curated = FIRST_PARTY_DISPLAY_NAMES.get(agentName);
    if (!curated) continue;
    const display = (row.displayName || '').trim();
    const instanceId = (row.instanceId || '').trim();
    let to = display;
    let reason: LabelRepair['reason'] | null = null;
    if (instanceId === 'default' && display.endsWith(DEFAULT_SUFFIX)) {
      const stripped = display.slice(0, -DEFAULT_SUFFIX.length).trim();
      if (stripped.toLowerCase() === curated.toLowerCase()) {
        to = curated;
        reason = 'default-suffix';
      }
    }
    if (!to || to.toLowerCase() === agentName) {
      to = curated;
      reason = reason || 'first-party';
    }
    if (reason && to !== display) {
      repairs.push({ id: row.id, username: row.username || '', from: display, to, reason });
    }
  }

  const instanceOf = new Map<string, string>(
    rows.map((row): [string, string] => [row.id, (row.instanceId || '').trim()]),
  );
  const shared = repairs.filter((r) => !isPerUser(instanceOf.get(r.id)));
  for (const r of shared) {
    const holders = (takenBy.get(r.to) || [])
      .filter((id) => !isPerUser(id))
      .map((id) => id || '(none)');
    const others = shared
      .filter((o) => o.id !== r.id && o.to === r.to)
      .map((o) => instanceOf.get(o.id) || '(none)');
    const heldBy = [...holders, ...others];
    if (heldBy.length > 0) r.heldBy = heldBy;
  }
  return repairs;
}

// The writes --apply makes, and the repairs it skips. A skipped repair is never
// written, so one run cannot put two non-per-user rows on the same label.
export function splitRepairs(repairs: LabelRepair[]): { writable: LabelRepair[]; skipped: LabelRepair[] } {
  return {
    writable: repairs.filter((r) => r.heldBy === undefined),
    skipped: repairs.filter((r) => r.heldBy !== undefined),
  };
}

interface LabelUser {
  _id: mongoose.Types.ObjectId;
  username?: string;
  botMetadata?: { displayName?: string; agentName?: string; instanceId?: string };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(2);
  }
  await mongoose.connect(uri);
  const User = mongoose.model<LabelUser>(
    'User',
    new mongoose.Schema<LabelUser>({}, { strict: false }),
    'users',
  );

  // Every bot with a botMetadata block, not only the labelled ones: a blank
  // first-party label is a candidate, and a repair is held by whoever already
  // takes its target label.
  const users = await User.find({ botMetadata: { $exists: true } })
    .select('username botMetadata')
    .lean<LabelUser[]>();
  const rows = users.map((u) => ({
    id: String(u._id),
    username: u.username,
    agentName: u.botMetadata?.agentName,
    instanceId: u.botMetadata?.instanceId,
    displayName: u.botMetadata?.displayName,
  }));
  const takenBy = new Map<string, string[]>();
  for (const row of rows) {
    const label = (row.displayName || '').trim();
    if (!label) continue;
    takenBy.set(label, [...(takenBy.get(label) || []), row.instanceId || '']);
  }

  const { writable, skipped } = splitRepairs(planLabelRepairs(rows, takenBy));
  for (const r of skipped) {
    const holders = (r.heldBy || []).join(', ');
    console.log(
      `  ! skipped ${r.username}: "${r.from}" → "${r.to}" (${r.reason}); "${r.to}" is also taken by ${holders}`,
    );
  }
  for (const r of writable) {
    console.log(`${APPLY ? '' : '[dry] '}${r.username}: "${r.from}" → "${r.to}" (${r.reason})`);
    if (APPLY) {
      await User.updateOne({ _id: r.id }, { $set: { 'botMetadata.displayName': r.to } });
    }
  }
  const verb = APPLY ? 'repaired' : 'would be repaired (dry run; pass --apply to write)';
  console.log(`\nDone — ${writable.length} label(s) ${verb}, ${skipped.length} skipped for an operator decision.`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Repair failed:', err);
    process.exit(1);
  });
}
