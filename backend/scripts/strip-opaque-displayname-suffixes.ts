/**
 * strip-opaque-displayname-suffixes — one-shot repair for per-user agents
 * whose displayName carries a collision suffix built from their own opaque
 * instance token ("Guide (U0da521ab41)", observed live 2026-08-13).
 *
 * The inline collision resolver (agentIdentityService) and the offline
 * dedup script both suffixed opaque per-user tokens like any other
 * instanceId. Since every user's Guide shares displayName "Guide" by
 * design, that put the opaque token into the chat byline of every user's
 * Guide except the first — the exact leak the #930 identity convention
 * exists to prevent. Both writers now skip opaque tokens; this sweep
 * repairs rows written before the fix.
 *
 * Safety: only strips a suffix that is EXACTLY the humanization of the
 * row's own instanceId, so a legitimately human-suffixed name ("Pixel
 * (Pixel-Demo)") can never match. Idempotent.
 *
 * Run:  node --import tsx backend/scripts/strip-opaque-displayname-suffixes.ts [--dry]
 */
import mongoose from 'mongoose';

const DRY = process.argv.includes('--dry');

// Keep aligned with isOpaquePerUserToken in agentIdentityService and
// isOpaqueInstanceToken in V2PodChat.
const isOpaquePerUserToken = (instanceId: string): boolean => (
  /^u[a-f0-9]{10}([a-f0-9]{14})?$/.test((instanceId || '').toLowerCase())
);

// Mirror of the humanizer in the inline resolver / dedup script: opaque
// tokens have no -/_ separators, so this is just an uppercased first char.
const humanize = (instanceId: string): string => instanceId
  .split(/[-_]/)
  .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
  .join('-');

interface BotUser {
  _id: mongoose.Types.ObjectId;
  username?: string;
  botMetadata?: { displayName?: string; instanceId?: string };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(2);
  }
  await mongoose.connect(uri);
  const User = mongoose.model<BotUser>(
    'User',
    new mongoose.Schema<BotUser>({}, { strict: false }),
    'users',
  );

  const bots = await User.find({ 'botMetadata.instanceId': { $regex: /^u[a-f0-9]{10}/ } })
    .select('username botMetadata')
    .lean<BotUser[]>();

  let repaired = 0;
  for (const u of bots) {
    const instanceId = (u.botMetadata?.instanceId || '').trim();
    const display = (u.botMetadata?.displayName || '').trim();
    if (!isOpaquePerUserToken(instanceId) || !display) continue;
    const suffix = ` (${humanize(instanceId)})`;
    if (!display.endsWith(suffix)) continue;
    const bare = display.slice(0, -suffix.length).trim();
    if (!bare) continue;
    console.log(`${DRY ? '[dry] ' : ''}${u.username}: "${display}" → "${bare}"`);
    if (!DRY) {
      await User.updateOne(
        { _id: u._id },
        { $set: { 'botMetadata.displayName': bare } },
      );
    }
    repaired += 1;
  }
  console.log(`\nDone — ${repaired} row(s) ${DRY ? 'would be ' : ''}repaired.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
