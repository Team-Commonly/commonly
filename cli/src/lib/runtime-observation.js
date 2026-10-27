// controlsFromArguments and observeSpawn live in the seats runtime package;
// the reporter below posts to a Commonly instance, so it stays in the CLI.
export { controlsFromArguments, observeSpawn } from '@commonlyai/seats/runtime-observation';

export const createRuntimeReporter = ({ client, harness, detect }) => {
  let queue = Promise.resolve();
  const send = (body) => {
    // Serialize so a fast process cannot have its settled report overtake its
    // spawn report. Old backends and diagnostic outages don't stop a turn.
    queue = queue.then(() => client.post('/api/agents/runtime/observation', body)).catch(() => {});
    return queue;
  };
  return {
    async connect() {
      return send({ event: 'connected' });
    },
    spawn: ({ model, effort, at }) => {
      const receipt = { event: 'spawn', harness, version: null, model, effort, ...(at ? { at } : {}) };
      queue = queue.then(async () => {
        try { receipt.version = (await detect())?.version || null; } catch { /* unavailable */ }
        await client.post('/api/agents/runtime/observation', receipt);
      }).catch(() => {});
      return queue;
    },
    settled: (outcome = null) => send({ event: 'settled', ...(outcome ? { outcome } : {}) }),
  };
};
