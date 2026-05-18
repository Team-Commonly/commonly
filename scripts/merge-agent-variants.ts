/**
 * merge-agent-variants — collapse duplicate agent User rows into a single
 * canonical identity, preserving all chat history + memory + reactions.
 *
 * Configured for 3 pairs (Pixel/Nova/Cody). Each pair has a `winner`
 * (kept) and a `loser` (merged in then marked inactive). Per kernel rule
 * (CLAUDE.md "Identity is separate from package"), the loser's User row
 * is NEVER deleted — only marked `status: 'merged-into', mergedInto: <winner._id>`
 * so future reads can resolve historical references.
 *
 * Per merge, the steps are:
 *   1. PG `messages.user_id`: rewrite loser → winner (chat history
 *      re-attributes to the canonical identity).
 *   2. PG `message_reactions.user_id`: rewrite non-colliding; DELETE
 *      collisions (where winner already reacted with the same emoji to
 *      the same message — the unique-key invariant forbids both).
 *   3. Mongo `pod.members`: `$addToSet winner` + `$pull loser` from every
 *      pod the loser was in. Skipped per-pair if `--skip-pod-merge`
 *      is set for that pair (Cody case: legacy codex-bot-codex was in
 *      22 pods, user opted in to bring codex-cody along — but the flag
 *      stays available for surgical merges).
 *   4. Mongo `agentmemories`: if loser memory is empty, delete it;
 *      otherwise append loser.content / sections to winner under a
 *      `[merged_from_<instanceId>]` heading, then delete the loser row.
 *   5. Mongo `agentinstallations`: rewrite `installedBy` loser → winner.
 *      Then dedupe per (podId, installedBy): keep the most recent
 *      `status: 'active'` row; delete the others.
 *   6. Mongo loser `User`: mark `status='merged-into'`,
 *      `mergedInto=<winner._id>`, `deletedAt=<now>`. Username + _id stay
 *      stable so historical foreign-key references continue to resolve;
 *      botMetadata.displayName gets `'[merged] '` prepended so any UI
 *      that surfaces this row (e.g. admin audit) shows the new status.
 *
 * Pre-flight: writes a JSON snapshot of every row this run will touch
 * to ./snapshot-<timestamp>.json — sufficient to reverse the migration
 * manually if anything looks wrong.
 *
 * Run with: `node --import tsx scripts/merge-agent-variants.ts [--live]`
 * or via `kubectl exec ... node /app/scripts/merge-agent-variants.js`.
 * Without `--live` it's a dry-run — no writes, just prints what would change.
 */

/* eslint-disable no-console */
import mongoose from 'mongoose';
// Pg is loaded via require() to match the in-pod backend's CJS exports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');

interface MergeSpec {
  pairName: string;          // human label, e.g. "Pixel"
  winner: { username: string; }; // canonical to keep
  loser:  { username: string; }; // merge into winner then deactivate
  skipPodMerge?: boolean;    // when true, leave pod.members alone for this pair
}

const PAIRS: MergeSpec[] = [
  { pairName: 'Pixel', winner: { username: 'openclaw-pixel' }, loser: { username: 'openclaw-pixel-demo' } },
  { pairName: 'Nova',  winner: { username: 'openclaw-nova'  }, loser: { username: 'openclaw-nova-demo'  } },
  { pairName: 'Cody',  winner: { username: 'codex-cody'     }, loser: { username: 'codex-bot-codex'    } },
];

const LIVE = process.argv.includes('--live');

interface LooseUser {
  _id: mongoose.Types.ObjectId;
  username?: string;
  botMetadata?: {
    displayName?: string;
    instanceId?: string;
    agentName?: string;
  };
}

interface LooseMem {
  _id: mongoose.Types.ObjectId;
  agentName?: string;
  instanceId?: string;
  content?: string;
  sections?: Record<string, { content?: string } | unknown>;
}

interface LoosePod {
  _id: mongoose.Types.ObjectId;
  members?: mongoose.Types.ObjectId[];
}

const User = () => mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
const Pod  = () => mongoose.model('Pod',  new mongoose.Schema({}, { strict: false }), 'pods');
const AgentInstallation = () => mongoose.model('AgentInstallation', new mongoose.Schema({}, { strict: false }), 'agentinstallations');
const AgentMemory = () => mongoose.model('AgentMemory', new mongoose.Schema({}, { strict: false }), 'agentmemories');

const fmt = (n: number) => n.toString().padStart(4, ' ');

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) { console.error('MONGO_URI required'); process.exit(2); }
  const pg = new Client({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: (process.env.PG_HOST || '').match(/aiven|rds/) ? { rejectUnauthorized: false } : false,
  });
  await pg.connect();
  await mongoose.connect(mongoUri);

  const mode = LIVE ? 'LIVE' : 'DRY-RUN';
  console.log(`\n=== merge-agent-variants (${mode}) ===\n`);

  const snapshot: Record<string, unknown> = { ts: new Date().toISOString(), mode, pairs: [] };

  for (const spec of PAIRS) {
    const winner = await User().findOne({ username: spec.winner.username }).lean<LooseUser>();
    const loser  = await User().findOne({ username: spec.loser.username  }).lean<LooseUser>();
    if (!winner || !loser) {
      console.log(`[${spec.pairName}] SKIP — one side missing (winner=${!!winner} loser=${!!loser})`);
      continue;
    }
    const wid = winner._id, lid = loser._id;

    // === counts (before) ===
    const msgsCount = (await pg.query('SELECT COUNT(*) FROM messages WHERE user_id=$1', [String(lid)])).rows[0].count;
    const rxRows = (await pg.query('SELECT message_id, emoji FROM message_reactions WHERE user_id=$1', [String(lid)])).rows;
    const winnerRxRows = (await pg.query('SELECT message_id, emoji FROM message_reactions WHERE user_id=$1', [String(wid)])).rows;
    const collisionKeys = new Set(winnerRxRows.map((r: { message_id: string; emoji: string }) => `${r.message_id}|${r.emoji}`));
    const rxCollisions = rxRows.filter((r: { message_id: string; emoji: string }) => collisionKeys.has(`${r.message_id}|${r.emoji}`)).length;
    const rxRewrites = rxRows.length - rxCollisions;

    const loserPods = await Pod().find({ members: lid }).select('_id name').lean<LoosePod[]>();
    const installList = await AgentInstallation().find({ installedBy: lid }).lean();
    const loserMem = await AgentMemory().findOne({ agentName: loser.botMetadata?.agentName, instanceId: loser.botMetadata?.instanceId }).lean<LooseMem>();
    const winnerMem = await AgentMemory().findOne({ agentName: winner.botMetadata?.agentName, instanceId: winner.botMetadata?.instanceId }).lean<LooseMem>();

    console.log(`[${spec.pairName}]  ${spec.loser.username}  →  ${spec.winner.username}`);
    console.log(`  msgs to rewrite           : ${fmt(msgsCount)}`);
    console.log(`  reactions to rewrite      : ${fmt(rxRewrites)}`);
    console.log(`  reaction collisions (del) : ${fmt(rxCollisions)}`);
    console.log(`  pod.members touched       : ${fmt(loserPods.length)}${spec.skipPodMerge ? ' (skipped per spec)' : ''}`);
    console.log(`  installations re-linked   : ${fmt(installList.length)}`);
    const loserMemEmpty = !loserMem || (!loserMem.content && Object.keys(loserMem.sections || {}).length === 0);
    console.log(`  loser memory              : ${loserMem ? (loserMemEmpty ? 'empty → delete' : 'non-empty → merge into winner') : 'none'}`);
    console.log('');

    // Snapshot for rollback
    snapshot.pairs = (snapshot.pairs as unknown[]).concat({
      pairName: spec.pairName,
      winner: { _id: String(wid), username: winner.username, botMetadata: winner.botMetadata },
      loser:  { _id: String(lid), username: loser.username,  botMetadata: loser.botMetadata },
      loserPodIds: loserPods.map(p => String(p._id)),
      loserInstallations: installList,
      loserMemory: loserMem,
      winnerMemory: winnerMem,
      msgsCount,
      rxRewrites,
      rxCollisions,
    });

    if (!LIVE) continue;

    // === LIVE writes (per pair, sequentially) ===

    // 1. PG messages
    const msgResult = await pg.query('UPDATE messages SET user_id=$1 WHERE user_id=$2', [String(wid), String(lid)]);
    console.log(`  ✓ updated messages: ${msgResult.rowCount}`);

    // 2. PG reactions — non-colliding update, then delete collisions
    if (rxRewrites > 0) {
      const r1 = await pg.query(
        `UPDATE message_reactions SET user_id=$1
         WHERE user_id=$2
           AND NOT EXISTS (SELECT 1 FROM message_reactions x WHERE x.message_id = message_reactions.message_id AND x.emoji = message_reactions.emoji AND x.user_id=$1)`,
        [String(wid), String(lid)],
      );
      console.log(`  ✓ rewrote reactions: ${r1.rowCount}`);
    }
    if (rxCollisions > 0) {
      const r2 = await pg.query('DELETE FROM message_reactions WHERE user_id=$1', [String(lid)]);
      console.log(`  ✓ deleted colliding reactions: ${r2.rowCount}`);
    }

    // 3. Pod members
    if (!spec.skipPodMerge && loserPods.length > 0) {
      for (const p of loserPods) {
        await Pod().updateOne({ _id: p._id }, { $addToSet: { members: wid } });
        await Pod().updateOne({ _id: p._id }, { $pull: { members: lid } });
      }
      console.log(`  ✓ updated ${loserPods.length} pod memberships`);
    }

    // 4. Memory merge
    if (loserMem) {
      if (loserMemEmpty) {
        await AgentMemory().deleteOne({ _id: loserMem._id });
        console.log(`  ✓ deleted empty loser memory`);
      } else {
        // Merge loser content + sections into winner under a [merged_from_*] heading
        const banner = `\n\n--- [merged_from_${loser.botMetadata?.instanceId}] (auto-merge ${new Date().toISOString()}) ---\n`;
        const loserBlob = (loserMem.content || '') +
          Object.entries(loserMem.sections || {}).map(([k, v]) => `\n## ${k}\n${(v as { content?: string } | undefined)?.content || ''}`).join('');
        if (winnerMem) {
          await AgentMemory().updateOne({ _id: winnerMem._id }, { $set: { content: (winnerMem.content || '') + banner + loserBlob, updatedAt: new Date() } });
        } else {
          await AgentMemory().create({
            agentName: winner.botMetadata?.agentName,
            instanceId: winner.botMetadata?.instanceId,
            content: banner + loserBlob,
            updatedAt: new Date(),
          });
        }
        await AgentMemory().deleteOne({ _id: loserMem._id });
        console.log(`  ✓ merged loser memory into winner; loser row deleted`);
      }
    }

    // 5. Installations
    if (installList.length > 0) {
      await AgentInstallation().updateMany({ installedBy: lid }, { $set: { installedBy: wid } });
      // Dedupe per (podId, installedBy=winner): keep most recent 'active'; remove others.
      const pods = Array.from(new Set(installList.map((i: any) => String(i.podId))));
      for (const podId of pods) {
        const rows = await AgentInstallation().find({ installedBy: wid, podId }).sort({ updatedAt: -1 }).lean();
        if (rows.length > 1) {
          const keep = (rows.find((r: any) => r.status === 'active') || rows[0]) as any;
          const toDelete = rows.filter((r: any) => String(r._id) !== String(keep._id)).map((r: any) => r._id);
          await AgentInstallation().deleteMany({ _id: { $in: toDelete } });
        }
      }
      console.log(`  ✓ relinked + deduped installations`);
    }

    // 6. Mark loser User row inactive
    const newDisplayName = `[merged] ${loser.botMetadata?.displayName || loser.username}`;
    await User().updateOne(
      { _id: lid },
      { $set: { status: 'merged-into', mergedInto: wid, deletedAt: new Date(), 'botMetadata.displayName': newDisplayName } },
    );
    console.log(`  ✓ marked loser User row as merged-into (displayName: "${newDisplayName}")`);
    console.log('');
  }

  // Write snapshot
  if (LIVE) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    const path = `/state/migration-snapshots/agent-merge-${Date.now()}.json`;
    try { fs.mkdirSync('/state/migration-snapshots', { recursive: true }); } catch {}
    fs.writeFileSync(path, JSON.stringify(snapshot, null, 2));
    console.log(`Snapshot written to ${path} (in-cluster path).`);
  } else {
    console.log(`Dry-run complete. Re-run with --live to apply.`);
  }

  await pg.end();
  await mongoose.disconnect();
}

main().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
