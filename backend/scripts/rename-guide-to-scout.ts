/**
 * rename-guide-to-scout — one-shot rollout of the Scout persona name
 * (Sam, 2026-08-13: the Cindy-in-Raft decision).
 *
 * Updates the two DB name sources for every existing per-user guide agent:
 *   - User.botMetadata.displayName  (chat bylines, resolveAgentDisplayLabel)
 *   - AgentInstallation.displayName (roster payloads, mention displaySlug)
 *
 * agentName stays 'guide' — it is the stable identity key (memory
 * envelopes, AGENT_TYPES, manifests). Only rows still named exactly
 * "Guide" are touched, so a user who already renamed their agent keeps
 * their choice. Idempotent.
 *
 * Run:  node --import tsx backend/scripts/rename-guide-to-scout.ts [--dry]
 */
import mongoose from 'mongoose';

const DRY = process.argv.includes('--dry');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(2);
  }
  await mongoose.connect(uri);
  const User = mongoose.model(
    'User',
    new mongoose.Schema({}, { strict: false }),
    'users',
  );
  const AgentInstallation = mongoose.model(
    'AgentInstallation',
    new mongoose.Schema({}, { strict: false }),
    'agentinstallations',
  );

  const userFilter = { 'botMetadata.agentName': 'guide', 'botMetadata.displayName': 'Guide' };
  const installFilter = { agentName: 'guide', displayName: 'Guide' };

  if (DRY) {
    const users = await User.countDocuments(userFilter);
    const installs = await AgentInstallation.countDocuments(installFilter);
    console.log(`[dry] would rename ${users} user row(s) and ${installs} installation(s) Guide → Scout`);
  } else {
    const users = await User.updateMany(userFilter, { $set: { 'botMetadata.displayName': 'Scout' } });
    const installs = await AgentInstallation.updateMany(installFilter, { $set: { displayName: 'Scout' } });
    console.log(`renamed ${users.modifiedCount} user row(s) and ${installs.modifiedCount} installation(s) Guide → Scout`);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Rename failed:', err);
  process.exit(1);
});
