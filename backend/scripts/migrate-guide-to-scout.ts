/**
 * migrate-guide-to-scout — full agentName rename, 'guide' → 'scout'
 * (Sam, 2026-08-13: "just go with scout even in db" — done pre-GTM while
 * the fleet is 3 installs, one of them a REAL user's).
 *
 * Identity continuity is the contract (CLAUDE.md rule 8): after this runs,
 * every renamed agent finds its memory, its installs, and its pending
 * approvals exactly where it left them — under the new key. What moves:
 *
 *   users              username 'guide-<inst>' → 'scout-<inst>',
 *                      botMetadata.agentName → 'scout',
 *                      botMetadata.displayName 'Guide' → 'Scout' (exact only,
 *                      so a user's own rename survives) + PG mirror resync
 *   agentinstallations agentName + exact-'Guide' displayName
 *   agentmemories      agentName (THE envelope key — ADR-003)
 *   agentregistries    agentName + displayName (seed upserts by agentName;
 *                      leaving 'guide' would strand a stale package row)
 *   approvalactions    flagged rows only — a pending card must execute
 *                      against the renamed installation; resolved/moot rows
 *                      stay as honest audit records of what acted at the time
 *   agentruns          agentName — keeps lastActiveAt/cost continuity so the
 *                      roster doesn't show a live agent as 'ready/never'
 *   agentevents        pending/queued rows only — same audit logic as above
 *
 * Chat message author snapshots (PG username column) are FROZEN history and
 * are deliberately not rewritten. The @guide mention alias in
 * agentMentionService keeps old handles landing.
 *
 * Idempotent; --dry supported.
 * Run:  node --import tsx backend/scripts/migrate-guide-to-scout.ts [--dry]
 */
import mongoose from 'mongoose';

const DRY = process.argv.includes('--dry');

const model = (name: string, collection: string) => mongoose.model(
  name,
  new mongoose.Schema({}, { strict: false }),
  collection,
);

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(2);
  }
  await mongoose.connect(uri);

  const User = model('User', 'users');
  const AgentInstallation = model('AgentInstallation', 'agentinstallations');
  const AgentMemory = model('AgentMemory', 'agentmemories');
  const AgentRegistry = model('AgentRegistry', 'agentregistries');
  const ApprovalAction = model('ApprovalAction', 'approvalactions');
  const AgentRun = model('AgentRun', 'agentruns');
  const AgentEvent = model('AgentEvent', 'agentevents');

  const report: Array<[string, number]> = [];
  const count = async (label: string, fn: () => Promise<number>) => {
    report.push([label, await fn()]);
  };

  // 1. Bot user rows — the identity anchors.
  const guideUsers = await User.find({ 'botMetadata.agentName': 'guide' })
    .select('username botMetadata')
    .lean<Array<{ _id: mongoose.Types.ObjectId; username?: string; botMetadata?: { displayName?: string } }>>();
  let usersRenamed = 0;
  for (const u of guideUsers) {
    const newUsername = (u.username || '').replace(/^guide-/, 'scout-');
    const sets: Record<string, unknown> = {
      'botMetadata.agentName': 'scout',
    };
    if (newUsername && newUsername !== u.username) sets.username = newUsername;
    if ((u.botMetadata?.displayName || '') === 'Guide') sets['botMetadata.displayName'] = 'Scout';
    console.log(`${DRY ? '[dry] ' : ''}user ${u.username} → ${newUsername}`);
    if (!DRY) {
      await User.updateOne({ _id: u._id }, { $set: sets });
    }
    usersRenamed += 1;
  }
  report.push(['users', usersRenamed]);

  // PG mirror: resync each renamed user so the pg users row carries the new
  // username (FK-joined surfaces read it). Best-effort per row.
  if (!DRY && process.env.PG_HOST && usersRenamed > 0) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AgentIdentityService = require('../services/agentIdentityService');
    // Real model (with hooks/shape) for the sync call:
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RealUser = require('../models/User');
    for (const u of guideUsers) {
      try {
        const doc = await RealUser.findById(u._id);
        if (doc) await AgentIdentityService.syncUserToPostgreSQL(doc);
      } catch (pgErr) {
        console.warn(`PG resync failed for ${u.username}:`, (pgErr as Error).message);
      }
    }
  }

  const rename = { $set: { agentName: 'scout' } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dryCount = (m: mongoose.Model<any>, filter: Record<string, unknown>) => m.countDocuments(filter);

  await count('installations', async () => (DRY
    ? dryCount(AgentInstallation, { agentName: 'guide' })
    : (await AgentInstallation.updateMany({ agentName: 'guide' }, {
      $set: { agentName: 'scout' },
    })).modifiedCount));
  if (!DRY) {
    await AgentInstallation.updateMany(
      { agentName: 'scout', displayName: 'Guide' },
      { $set: { displayName: 'Scout' } },
    );
  }

  await count('memories', async () => (DRY
    ? dryCount(AgentMemory, { agentName: 'guide' })
    : (await AgentMemory.updateMany({ agentName: 'guide' }, rename)).modifiedCount));

  // The boot seeder (seed-native-agents, runs before this script can) will
  // already have upserted a fresh 'scout' registry row from the renamed
  // manifest. If it exists, the old 'guide' row is superseded — delete it
  // rather than renaming into a collision.
  await count('registry', async () => {
    if (DRY) return dryCount(AgentRegistry, { agentName: 'guide' });
    const scoutExists = await AgentRegistry.findOne({ agentName: 'scout' }).lean();
    if (scoutExists) {
      return (await AgentRegistry.deleteMany({ agentName: 'guide' })).deletedCount;
    }
    return (await AgentRegistry.updateMany({ agentName: 'guide' }, {
      $set: { agentName: 'scout', displayName: 'Scout' },
    })).modifiedCount;
  });

  await count('approvals (flagged)', async () => (DRY
    ? dryCount(ApprovalAction, { agentName: 'guide', status: 'flagged' })
    : (await ApprovalAction.updateMany({ agentName: 'guide', status: 'flagged' }, rename)).modifiedCount));

  await count('runs', async () => (DRY
    ? dryCount(AgentRun, { agentName: 'guide' })
    : (await AgentRun.updateMany({ agentName: 'guide' }, rename)).modifiedCount));

  await count('events (pending)', async () => (DRY
    ? dryCount(AgentEvent, { agentName: 'guide', status: { $in: ['pending', 'queued'] } })
    : (await AgentEvent.updateMany(
      { agentName: 'guide', status: { $in: ['pending', 'queued'] } },
      rename,
    )).modifiedCount));

  console.log(`\n${DRY ? '[dry] ' : ''}guide → scout:`);
  for (const [label, n] of report) console.log(`  ${label}: ${n}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
