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
export const buildMemoryPreamble = (prompt, memoryLongTerm, { freshSession = false } = {}) => {
  // `null` is the UNREADABLE signal, and it is deliberately not the same value
  // as `''`. Telling a seat whose token was revoked that "nothing has ever been
  // saved here" is a false claim about its own history, and it is the same
  // defect this cue exists to fix — one state over. When we could not read, say
  // that, and say nothing about what is stored.
  let context;
  if (memoryLongTerm === null) {
    context = `=== Context (your persistent memory) ===\n`
      + `(unreadable this turn — the memory read failed, so this says NOTHING `
      + `about what you have saved. Do not treat it as empty and do not re-save `
      + `state you may already hold.)`;
  } else if (memoryLongTerm) {
    context = `=== Context (your persistent memory) ===\n${memoryLongTerm}`;
  } else {
    context = `=== Context (your persistent memory) ===\n`
      + `(empty — nothing has ever been saved here)\n`
      + `Only the \`long_term\` section is read back into this prompt. To make `
      + `something survive your next session, call commonly_save_my_memory({ `
      + `section: 'long_term', content: '...' }). A write to any other section `
      + `succeeds and is never shown to you again.`;
  }

  if (!freshSession) return `${context}\n=== Current turn ===\n${prompt}`;

  // This belongs on a fresh underlying CLI session, rather than every turn:
  // a resumed session already carries the earlier instruction in its own
  // transcript. Repeating it on each wake spends prompt budget while making
  // the cue easier to ignore. The wrapper cannot know the final event of a
  // session in advance, so it gives the end-of-session reminder while the
  // agent can still act on it.
  const freshReadCue = '=== Fresh session ===\n'
    + 'This is a fresh session. Read the persistent memory context above before acting; '
    + 'it carries durable state from prior sessions.\n';
  let sessionEndCue = '=== Before this session ends ===\n';
  if (memoryLongTerm === null) {
    sessionEndCue += 'Memory was unreadable on this fresh session. Do not treat it as empty or '
      + 'write a replacement based on this cue.';
  } else if (memoryLongTerm) {
    sessionEndCue += 'At a natural end to meaningful work, save durable working state — '
      + 'gates held, decisions pending, and task context, not a transcript — with '
      + "commonly_save_my_memory({ section: 'long_term', content: '...' }).";
  } else {
    sessionEndCue += 'At a natural end to meaningful work, save durable working state — '
      + 'gates held, decisions pending, and task context, not a transcript — using '
      + 'the long_term write above.';
  }
  return `${context}\n${freshReadCue}\n=== Current turn ===\n${prompt}\n${sessionEndCue}`;
};

export const readLongTerm = async (client, { onError } = {}) => {
  try {
    const body = await client.get('/api/agents/runtime/memory');
    return body?.sections?.long_term?.content || '';
  } catch (err) {
    // A 404 is the ONLY error that means what '' means: a fresh agent with no
    // memory row yet. The kernel upserts on first write, so this is genuine
    // absence and the empty cue is true.
    if (err?.status === 404) return '';
    // Everything else — auth revoked, 500, connection refused — is a failure to
    // READ, which tells us nothing about what is stored. Returning '' here made
    // the caller assert emptiness on no evidence.
    //
    // `err.status` is undefined for a transport failure, so the old guard
    // (`err?.status && err.status !== 404`) skipped onError precisely when the
    // backend was unreachable: the loudest condition was the silent one, and
    // nothing contradicted the false cue.
    onError?.(err);
    return null;
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
