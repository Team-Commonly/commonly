import AgentCredential from '../models/AgentCredential';

// Keep a short window for diagnosing a finished spawn, then remove its leaf
// credential. Authorization already stops at expiresAt; this is storage GC.
export const SPAWN_CREDENTIAL_RETENTION_MS = 60 * 60 * 1000;

export async function reapSpawnCredentials(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SPAWN_CREDENTIAL_RETENTION_MS);
  const result = await AgentCredential.deleteMany({
    scopes: 'spawn',
    expiresAt: { $lte: cutoff },
  });
  return result.deletedCount || 0;
}

module.exports = { SPAWN_CREDENTIAL_RETENTION_MS, reapSpawnCredentials };
Object.assign(module.exports, exports);
