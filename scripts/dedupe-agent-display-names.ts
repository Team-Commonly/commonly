/**
 * dedupe-agent-display-names — one-shot migration to disambiguate agent
 * displayName collisions in `User.botMetadata.displayName`.
 *
 * Why: an agent's displayName drives chat author rendering, the inspector
 * card, and `resolveAgentDisplayLabel` everywhere downstream. Two agents
 * with the same `instanceId` (e.g. `pixel`) or with carelessly-set demo
 * variants (`pixel-demo` sharing displayName "Pixel" with `pixel`) render
 * identically in chat — confusing for humans and a real attribution risk
 * (you can't tell which Pixel just posted).
 *
 * What the script does:
 *   1. Group every bot User by botMetadata.displayName.
 *   2. For each group with >1 user, pick ONE canonical to keep as-is
 *      (preference: shortest instanceId, then alphabetically first
 *       instanceId — deterministic across re-runs).
 *   3. For every other user in the group, rewrite displayName to
 *      `<originalDisplayName> (<instanceId>)`. instanceId is humanized:
 *      `pixel-demo` → "Pixel-demo", `inst-315667` → "inst-315667".
 *   4. Skip users whose displayName already contains a parenthetical
 *      suffix — the script is idempotent.
 *
 * What it does NOT touch:
 *   - `botMetadata.agentName` / `instanceId` — these are stable identity
 *     keys; only displayName (the human-facing label) is rewritten.
 *   - `username` — DB-unique already; collisions there are impossible.
 *
 * Run with: `node --import tsx scripts/dedupe-agent-display-names.ts`
 * or via `kubectl exec ... node /app/scripts/dedupe-agent-display-names.js`.
 *
 * Idempotent: safe to re-run. New duplicates introduced later can be
 * cleaned up by re-running.
 */

/* eslint-disable no-console */
import mongoose from 'mongoose';

interface BotMeta {
  displayName?: string;
  instanceId?: string;
  agentName?: string;
}

interface BotUser {
  _id: mongoose.Types.ObjectId;
  username?: string;
  botMetadata?: BotMeta;
}

const formatSuffix = (instanceId: string): string => instanceId
  .split(/[-_]/)
  .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
  .join('-');

const looksAlreadyDisambiguated = (displayName: string): boolean => (
  /\([^)]+\)\s*$/.test(displayName.trim())
);

const pickCanonical = (users: BotUser[]): BotUser => {
  // Deterministic preference: shortest instanceId wins (so "pixel" beats
  // "pixel-demo"); ties resolved alphabetically. Stable across re-runs.
  return [...users].sort((a, b) => {
    const ai = a.botMetadata?.instanceId || '';
    const bi = b.botMetadata?.instanceId || '';
    if (ai.length !== bi.length) return ai.length - bi.length;
    return ai.localeCompare(bi);
  })[0];
};

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(2);
  }
  await mongoose.connect(uri);
  const User = mongoose.model<BotUser>('User', new mongoose.Schema<BotUser>({}, { strict: false }), 'users');

  const bots = await User.find({ 'botMetadata.displayName': { $exists: true, $ne: '' } })
    .select('username botMetadata')
    .lean<BotUser[]>();

  const groups = new Map<string, BotUser[]>();
  for (const u of bots) {
    const display = (u.botMetadata?.displayName || '').trim();
    if (!display) continue;
    if (!groups.has(display)) groups.set(display, []);
    groups.get(display)!.push(u);
  }

  let renamed = 0;
  let skippedAlreadyClean = 0;
  for (const [display, users] of groups) {
    if (users.length < 2) continue;
    const canonical = pickCanonical(users);
    for (const u of users) {
      if (u._id.equals(canonical._id)) continue;
      const instanceId = (u.botMetadata?.instanceId || '').trim();
      if (!instanceId) continue;
      if (looksAlreadyDisambiguated(display)) {
        skippedAlreadyClean += 1;
        continue;
      }
      const newDisplay = `${display} (${formatSuffix(instanceId)})`;
      await User.updateOne(
        { _id: u._id },
        { $set: { 'botMetadata.displayName': newDisplay } },
      );
      console.log(
        `  renamed ${String(u._id).slice(-6)} ${u.username}: "${display}" → "${newDisplay}"`,
      );
      renamed += 1;
    }
  }
  console.log(`\nDone — ${renamed} users renamed, ${skippedAlreadyClean} already-clean entries skipped.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
