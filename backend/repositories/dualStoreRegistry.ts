/**
 * The models that have adopted the dual-store helper (ADR-034 step 2 or
 * later), by the name their STORE_MODE_<NAME> is read under. The repair job
 * and scripts/dual-store-backfill.ts reach a model's store only through here.
 * A model joins this list in the PR that adopts the helper.
 */
import { storeMode, type DualStore } from './dualStore';

export const DUAL_STORED_MODELS: Record<string, () => DualStore> = {
  // Loaded on use, so importing the registry loads no model.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  AgentPodReadCursor: () => require('./agentPodReadCursorRepository').readCursorStore,
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  AgentFirstContact: () => require('./agentFirstContactRepository').firstContactStore(),
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  AgentDigestState: () => require('./agentDigestStateRepository').digestStateStore(),
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  AgentTaskWakeState: () => require('./agentTaskWakeStateRepository').taskWakeStateStore(),
};

type RepairCounts = Awaited<ReturnType<DualStore['repair']>>;

/**
 * One repair pass per model whose mode writes both stores (dual, pg-read).
 * mongo makes no Postgres call, and pg has no Mongo side to repair from.
 * Lease-free: every repair step is conditional on a version in both stores
 * (the adapter's version guard, the marker cleared by version), so two
 * replicas running it at once repeat work and change nothing twice.
 * Logs only non-zero counts, and never an id.
 */
export async function repairDualStoredModels(): Promise<Record<string, RepairCounts>> {
  const results: Record<string, RepairCounts> = {};
  for (const [name, store] of Object.entries(DUAL_STORED_MODELS)) {
    const mode = storeMode(name);
    if (mode === 'dual' || mode === 'pg-read') {
      try {
        // eslint-disable-next-line no-await-in-loop -- one model at a time
        const counts = await store().repair();
        results[name] = counts;
        if (Object.values(counts).some((n) => n > 0)) {
          const listed = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
          console.log(`[dual-store] repair model=${name} ${listed}`);
        }
      } catch (error) {
        console.error(`[dual-store] repair failed model=${name}:`, (error as Error).message);
      }
    }
  }
  return results;
}
