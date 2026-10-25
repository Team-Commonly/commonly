/**
 * D76 read-only census. Do not migrate models until OpenRouter routing is ready.
 * Run: npx ts-node scripts/census-anthropic-installations.ts
 * Requires MONGO_URI. Every argument (including --apply) is refused before DB access.
 * Uses a raw collection read: no model/index initialization, notices or updates.
 */
/* eslint-disable no-console */
import mongoose from 'mongoose';

const HOSTED_RUNTIME_TYPES = new Set(['native', 'hosted', 'internal', 'moltbot', 'managed-agents']);
type Installation = {
  config?: {
    runtime?: { runtimeType?: unknown; model?: unknown };
    environment?: { model?: unknown };
  };
};

const isClaudeModel = (value: unknown): boolean => typeof value === 'string'
  && /^(?:(?:anthropic|openrouter)\/)?(?:anthropic\/)?claude-/i.test(value.trim());

export const censusAnthropicInstallations = (rows: Installation[]) => {
  let hostedCandidates = 0;
  let excluded = 0;
  const byRuntime: Record<string, number> = {};
  for (const row of rows) {
    const runtime = row.config?.runtime;
    if (!isClaudeModel(runtime?.model) && !isClaudeModel(row.config?.environment?.model)) continue;
    const runtimeType = String(runtime?.runtimeType || '').trim().toLowerCase();
    byRuntime[runtimeType || 'unset'] = (byRuntime[runtimeType || 'unset'] || 0) + 1;
    if (HOSTED_RUNTIME_TYPES.has(runtimeType)) hostedCandidates += 1;
    else excluded += 1; // Local CLI, webhook and unknown tiers must never be reclassified by model name.
  }
  return { dryRun: true, scanned: rows.length, hostedCandidates, excludedByoOrUnknown: excluded, byRuntime };
};

export const main = async (args = process.argv.slice(2)): Promise<void> => {
  if (args.length) throw new Error('Read-only census: no arguments accepted; --apply is unavailable (D76).');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  const connection = mongoose.createConnection(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try {
    await connection.asPromise();
    const rows = await connection.collection('agentinstallations').find({}, {
      projection: { _id: 0, 'config.runtime.runtimeType': 1, 'config.runtime.model': 1, 'config.environment.model': 1 },
    }).toArray();
    console.log(JSON.stringify(censusAnthropicInstallations(rows as Installation[]), null, 2));
    console.log('DRY RUN ONLY: no installations changed and no owner notices sent. OpenRouter routing pending.');
  } finally {
    await connection.close();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Anthropic installation census failed:', error.message);
    process.exitCode = 1;
  });
}
