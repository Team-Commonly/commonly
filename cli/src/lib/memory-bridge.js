/**
 * Memory bridge — ADR-005 §Memory bridge, ADR-003 Phase 2.
 *
 * Two thin CAP shims the run loop calls around every spawn cycle:
 *
 *   readLongTerm(client)            — GET  /api/agents/runtime/memory,
 *                                      returns sections.long_term.content,
 *                                      falling back to legacy content
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

import { KEEP_PROCESS_ENV } from '@commonlyai/seats/turn-processes';

export const SOURCE_RUNTIME = 'local-cli';

/**
 * Row slicing, the runtime-agnostic half of TASK-545. A row too large
 * for one turn drifts when one seat carries it whole, so the seat splits it on
 * the board before any code. It names the exact call and field for the reason
 * the memory cue below names `long_term`: a seat adopts a habit through a
 * surface it can see. Each adapter decides whether to pass it.
 */
export const ROW_SLICING_CUE = 'Slicing: when a row is too large for one turn, split it before '
  + 'writing any code. Post each slice as a child row (commonly_create_task with parentTask set '
  + "to the row's taskId) with one assignee, a written file or area boundary, and its own "
  + 'acceptance line.';

// The turn's leftovers are stopped when it ends (@commonlyai/seats/turn-processes),
// so a seat that means to reuse a server has to say so when it starts it.
export const BACKGROUND_PROCESS_CUE = 'Background processes: anything you start in the background is '
  + 'stopped when this turn ends, including a server that starts on first use, such as tmux, and an agent you '
  + 'restart with nohup. To keep one for a later turn, such as a dev server you will reuse, start it '
  + `with ${KEEP_PROCESS_ENV}=1 set, and stop it yourself when you are done with it.`;

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
 * It names `long_term` specifically because that is the only v2 section read
 * back. Legacy `content` is a fallback for records without that section. A write to `daily` —
 * the section whose name most invites exactly this use — succeeds, returns 200,
 * and is never seen again; the write and the silence are indistinguishable from
 * a correct round trip. Naming the section is the whole point of the cue.
 *
 * `workCues` are working habits an adapter teaches on a fresh session, beside
 * the memory cues and under the same once-per-session rule. An adapter passes
 * only the habits its CLI can act on; passing none leaves the preamble as it
 * was.
 */
export const buildMemoryPreamble = (
  prompt,
  memoryLongTerm,
  { freshSession = false, workCues = [], memoryWithheld = false } = {},
) => {
  // `null` is the UNREADABLE signal, and it is deliberately not the same value
  // as `''`. Telling a seat whose token was revoked that "nothing has ever been
  // saved here" is a false claim about its own history, and it is the same
  // defect this cue exists to fix — one state over. When we could not read, say
  // that, and say nothing about what is stored.
  let context;
  if (memoryWithheld) {
    // A workspace seat's turn that runs public: not unreadable and not empty,
    // so neither of those cues is true. Its memory tools are off as well.
    context = `=== Context (your persistent memory) ===\n`
      + `(withheld this turn — this turn runs as a public seat because not every `
      + `pod you answer in is confirmed private, so your memory stays out of it and `
      + `the memory tools are off. This says nothing about what you have saved.)`;
  } else if (memoryLongTerm === null) {
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
  if (memoryWithheld) {
    sessionEndCue += 'Memory is withheld this turn, so there is nothing to save.';
  } else if (memoryLongTerm === null) {
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
  const workCue = workCues.length
    ? `\n=== Working a row ===\n${workCues.map((cue) => `- ${cue}`).join('\n')}\n`
    : '';
  return `${context}\n${freshReadCue}${workCue}\n=== Current turn ===\n${prompt}\n${sessionEndCue}`;
};

export const readLongTerm = async (client, { onError } = {}) => {
  try {
    const body = await client.get('/api/agents/runtime/memory');
    return body?.sections?.long_term?.content ?? body?.content ?? '';
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
