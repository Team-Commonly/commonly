/**
 * The adapter contract (ADR-005 §Adapter pattern). An adapter turns one prompt
 * into one CLI run and one reply. It owns argv, env and output parsing for its
 * CLI; the caller owns everything that talks to a Commonly instance.
 *
 * @typedef {object} Adapter
 * @property {string} name
 * @property {string} [runtimeType]
 * @property {string} [providerKeyEnv]  host env var the adapter's provider key arrives in
 * @property {() => Promise<{ path: string, version: string } | null>} detect
 * @property {(environment: object) => Promise<void>} [validateEnvironment]  refuse before spawn
 * @property {(prompt: string, ctx: object) => Promise<SpawnResult>} spawn
 *
 * @typedef {object} SpawnResult
 * @property {string} text
 * @property {string} [newSessionId]
 * @property {number} [contextTokens]
 * @property {string} [memorySummary]
 *
 * Adapters that need host policy are built by a factory that takes a SeatHost.
 * Every field is optional; an absent field takes the neutral default named.
 *
 * @typedef {object} SeatHost
 * @property {(prompt: string, longTerm: string | null | undefined, opts: { freshSession: boolean }) => string} [memoryPreamble]  default: the prompt unchanged
 * @property {(trust: string | undefined) => string | undefined} [effectiveTrust]  default: the declared trust unchanged
 * @property {() => boolean} [seatModelRequired]  default: false
 */

/**
 * @param {Adapter[]} adapters
 */
export const createRegistry = (adapters) => {
  const byName = {};
  for (const adapter of adapters) {
    if (!adapter?.name) throw new Error('every adapter needs a name');
    if (byName[adapter.name]) throw new Error(`duplicate adapter name: ${adapter.name}`);
    byName[adapter.name] = adapter;
  }
  return {
    adapters: byName,
    names: () => Object.keys(byName),
    get: (name) => byName[name] || null,
  };
};

export const providerKeyEnvNames = (adapters) => [...new Set(
  Object.values(adapters).map((adapter) => adapter.providerKeyEnv).filter(Boolean),
)];
