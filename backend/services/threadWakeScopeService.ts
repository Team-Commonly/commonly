/**
 * Who a threaded reply wakes (W-T, TASK-029, 3/4).
 *
 * Ambient-only scoping, per fable's #1045 ruling: activity inside a thread is
 * AMBIENT to the channel. It does not wake non-followers, and it does not bump
 * the channel row above rooms with addressed items.
 *
 *     effective = (participants ∪ explicitFollowers) − muted
 *
 * The three terms, and why they are three:
 *
 *  - `participants` — anyone who authored a message in the thread. Derived at
 *    read from `messages`, never stored: it is a fact about the conversation,
 *    and materialising it would mean a second writer that can disagree with
 *    the first. This is the `following IS NULL` case from the tri-state.
 *  - `explicitFollowers` — `following IS TRUE`. Someone who used the header
 *    toggle, or who was @-mentioned in the thread (the mention writes the row
 *    at the moment it happens, via ThreadUserState.followByParticipation,
 *    rather than being re-derived from history forever).
 *  - `muted` — `following IS FALSE`. Subtracted LAST, because an explicit mute
 *    outranks participation. A participant who muted must stay muted.
 *
 * SCOPING ONLY NARROWS. This never adds a wake target that would not have been
 * woken anyway — it removes the ones a thread should not reach. Threading is
 * an additive feature and must not start delivering to seats that never opted
 * in to anything.
 *
 * NOT the addressing path. An explicit @mention still wakes its target whether
 * or not they follow the thread, and whether or not they muted it: a mute
 * scopes ambient activity, never addressing. That path never reaches this
 * service, because `isRouted` short-circuits before the ambient branch.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const { pool } = require('../config/db-pg');

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

/**
 * The effective follower set for one thread, as user ids.
 *
 * One query, not three. The three terms are correlated — muted must be
 * subtracted from the union of the other two — and doing that in JS would mean
 * three round trips on a path that runs for every threaded reply.
 */
export async function effectiveFollowerIds(threadRootId: number): Promise<Set<string>> {
  const { rows } = await (pool as PgPool).query(
    `WITH participants AS (
       SELECT DISTINCT user_id FROM messages
        WHERE thread_root_id = $1 OR id = $1
     ),
     explicit AS (
       SELECT user_id FROM thread_user_state
        WHERE thread_root_id = $1 AND following IS TRUE
     ),
     muted AS (
       SELECT user_id FROM thread_user_state
        WHERE thread_root_id = $1 AND following IS FALSE
     )
     SELECT user_id FROM (
       SELECT user_id FROM participants
       UNION
       SELECT user_id FROM explicit
     ) candidates
     WHERE user_id NOT IN (SELECT user_id FROM muted)`,
    [threadRootId],
  );
  return new Set(rows.map((r) => String(r.user_id)));
}

/**
 * Narrow an already-computed wake target list to the thread's effective
 * followers. Returns the input unchanged when the message is not threaded, so
 * a caller can apply it unconditionally.
 *
 * `identify` maps a target to the user id thread state is keyed on — for an
 * AgentInstallation that is `installedBy`, the bot's User row. A target whose
 * id cannot be resolved is KEPT, deliberately: an unresolvable identity must
 * degrade to today's behaviour (delivered) rather than to silence. Threading
 * dropping a wake it could not classify is the failure nobody would notice.
 */
export async function narrowToThread<T>(
  threadRootId: number | null | undefined,
  targets: T[],
  identify: (t: T) => string | null,
): Promise<T[]> {
  if (!threadRootId) return targets;
  if (!targets.length) return targets;
  let effective: Set<string>;
  try {
    effective = await effectiveFollowerIds(Number(threadRootId));
  } catch (error) {
    // Same reasoning as an unresolvable id, one level up: a scoping failure
    // must not silently mute a whole thread.
    console.warn('[thread-scope] falling back to unscoped delivery:', (error as Error).message);
    return targets;
  }
  return targets.filter((t) => {
    const id = identify(t);
    if (!id) return true;
    return effective.has(id);
  });
}

module.exports = { effectiveFollowerIds, narrowToThread };
Object.assign(module.exports, exports);
