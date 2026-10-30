/**
 * repair-first-party-labels — one-shot repair of stored User labels written
 * before the resolver knew the first-party name and the default-instance
 * rule (TASK-551).
 *
 *   1. A first-party agent whose label is blank, or is its bare agentName
 *      ("scout"), gets its curated label ("Scout").
 *   2. A default-instance row carrying the " (Default)" suffix that the
 *      collision resolver used to add gets the suffix stripped.
 *
 * Both are exact-match rules and idempotent. Dry run unless --apply. This
 * never suffixes a label: a repaired label that now shares a name with
 * another agent is printed with its peers, and the operator decides.
 *
 * Run:  node --import tsx backend/scripts/repair-first-party-labels.ts [--apply]
 */
import mongoose from 'mongoose';
import { FIRST_PARTY_DISPLAY_NAMES } from '../constants/firstPartyDisplayNames';

const APPLY = process.argv.includes('--apply');
const DEFAULT_SUFFIX = ' (Default)';

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
}

// Pure, so the rules are pinned without a database.
export function planLabelRepairs(rows: LabelRow[]): LabelRepair[] {
  const repairs: LabelRepair[] = [];
  for (const row of rows) {
    const display = (row.displayName || '').trim();
    const agentName = (row.agentName || '').trim().toLowerCase();
    const instanceId = (row.instanceId || '').trim();
    let to = display;
    let reason: LabelRepair['reason'] | null = null;
    if (instanceId === 'default' && display.endsWith(DEFAULT_SUFFIX)) {
      to = display.slice(0, -DEFAULT_SUFFIX.length).trim();
      reason = 'default-suffix';
    }
    const curated = FIRST_PARTY_DISPLAY_NAMES.get(agentName);
    if (curated && (!to || to.toLowerCase() === agentName)) {
      to = curated;
      reason = 'first-party';
    }
    if (reason && to && to !== display) {
      repairs.push({ id: row.id, username: row.username || '', from: display, to, reason });
    }
  }
  return repairs;
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

  const users = await User.find({
    $or: [
      { 'botMetadata.agentName': { $in: [...FIRST_PARTY_DISPLAY_NAMES.keys()] } },
      { 'botMetadata.instanceId': 'default', 'botMetadata.displayName': / \(Default\)$/ },
    ],
  })
    .select('username botMetadata')
    .lean<LabelUser[]>();

  const repairs = planLabelRepairs(users.map((u) => ({
    id: String(u._id),
    username: u.username,
    agentName: u.botMetadata?.agentName,
    instanceId: u.botMetadata?.instanceId,
    displayName: u.botMetadata?.displayName,
  })));

  for (const r of repairs) {
    console.log(`${APPLY ? '' : '[dry] '}${r.username}: "${r.from}" → "${r.to}" (${r.reason})`);
    // Report, don't resolve: the new label may now be shared with another agent.
    const peers = await User.find({ 'botMetadata.displayName': r.to, _id: { $ne: r.id } })
      .select('botMetadata.instanceId')
      .lean<LabelUser[]>();
    if (peers.length) {
      const holders = peers.map((p) => p.botMetadata?.instanceId || '(none)').join(', ');
      console.log(`  ! "${r.to}" is also held by instance(s): ${holders}`);
    }
    if (APPLY) {
      await User.updateOne({ _id: r.id }, { $set: { 'botMetadata.displayName': r.to } });
    }
  }
  const verb = APPLY ? 'repaired' : 'would be repaired (dry run; pass --apply to write)';
  console.log(`\nDone — ${repairs.length} label(s) ${verb}.`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Repair failed:', err);
    process.exit(1);
  });
}
