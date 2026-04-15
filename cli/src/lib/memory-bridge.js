/**
 * Memory bridge — ADR-005 §Memory bridge, ADR-003 Phase 2.
 *
 * Two thin CAP shims the run loop calls around every spawn cycle:
 *
 *   readLongTerm(client)            — GET  /api/agents/runtime/memory,
 *                                      returns sections.long_term.content or ''
 *   syncBack(client, { summary })   — POST /api/agents/runtime/memory/sync
 *                                      with mode:'patch', sourceRuntime:'local-cli'.
 *                                      No-op when summary is falsy.
 *
 * Identity (agentName, instanceId) is derived server-side from the runtime
 * token (agentRuntimeAuth), so neither helper needs to pass it. Keeping it
 * server-derived is invariant-preserving: a bug in the wrapper can't write
 * to the wrong agent's memory.
 *
 * ADR-003 invariant #9: the wrapper supplies `content` + `visibility` ONLY.
 * `byteSize`, `updatedAt`, and `schemaVersion` are server-stamped; supplying
 * them from the client is wasted bytes and the kernel discards them.
 */

export const SOURCE_RUNTIME = 'local-cli';

export const readLongTerm = async (client, { onError } = {}) => {
  try {
    const body = await client.get('/api/agents/runtime/memory');
    return body?.sections?.long_term?.content || '';
  } catch (err) {
    // A fresh agent has no memory row yet — treat as empty rather than fail
    // the spawn. The kernel upserts on first write. For anything OTHER than
    // a 404 (auth revoked, backend down, network out), surface via onError
    // so the user sees "something's wrong with memory" instead of a silently
    // context-less agent.
    if (err?.status && err.status !== 404) {
      onError?.(err);
    }
    return '';
  }
};

export const syncBack = async (client, { summary } = {}) => {
  if (!summary) return { skipped: true };
  await client.post('/api/agents/runtime/memory/sync', {
    mode: 'patch',
    sourceRuntime: SOURCE_RUNTIME,
    sections: {
      long_term: {
        content: summary,
        visibility: 'private',
      },
    },
  });
  return { skipped: false };
};
