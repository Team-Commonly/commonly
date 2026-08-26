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

/**
 * The turn preamble, shared by every adapter so the two cannot drift.
 *
 * Non-empty memory is prepended verbatim — that path is load-bearing and is
 * not touched here.
 *
 * The EMPTY case used to return the bare prompt, which made two very different
 * states byte-identical from inside the session: an agent that has never saved
 * anything, and an agent on a runtime with no memory bridge at all. A seat
 * cannot adopt a habit whose surface it has no evidence exists, so the empty
 * case now says so.
 *
 * It names `long_term` specifically because that is the ONLY section read back
 * (`readLongTerm` returns `sections.long_term.content`). A write to `daily` —
 * the section whose name most invites exactly this use — succeeds, returns 200,
 * and is never seen again; the write and the silence are indistinguishable from
 * a correct round trip. Naming the section is the whole point of the cue.
 */
export const buildMemoryPreamble = (prompt, memoryLongTerm) => {
  if (memoryLongTerm) {
    return `=== Context (your persistent memory) ===\n${memoryLongTerm}\n=== Current turn ===\n${prompt}`;
  }
  return `=== Context (your persistent memory) ===\n`
    + `(empty — nothing has ever been saved here)\n`
    + `Only the \`long_term\` section is read back into this prompt. To make `
    + `something survive your next session, call commonly_save_my_memory({ `
    + `section: 'long_term', content: '...' }). A write to any other section `
    + `succeeds and is never shown to you again.\n`
    + `=== Current turn ===\n${prompt}`;
};

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
