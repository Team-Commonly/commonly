/**
 * claimReleaseFor — the ONE decision about how a finished turn releases its
 * ADR-018 attention claim.
 *
 * It lives here, extracted from two byte-identical copies in the run loop
 * (single-event and batch release), for the reason a second copy is always a
 * risk: the batch path is the one `message.posted` actually reaches, so a
 * change applied to only one of them would pass review and do nothing.
 *
 * Three outcomes, and the KERNEL decides what each one does with the wake
 * (TASK-099 ruling, corrected at 71194/71195/71210):
 *
 *   - `refused`   — the lease holder could not deliver. Nothing about the
 *                   agent's CHOICE happened: the model never ran (an upstream
 *                   429/502/401, named by TASK-096) or the server refused the
 *                   post. On a HUMAN wake the kernel hands the message to one
 *                   remaining listener exactly as it does for a decline — a
 *                   per-seat budget failure must not make a human's message
 *                   disappear — and records the refuser so the chain stays
 *                   finite. On any other wake it is terminal. The routing is
 *                   the kernel's: this module only names the outcome.
 *   - `declined`  — a silent, normally completed human broadcast. The agent
 *                   chose not to answer, so the kernel hands it to exactly one
 *                   remaining original listener.
 *   - `completed` — everything else that produced a result: a posted reply, or
 *                   a skip with a reason (`no-prompt`, `claim-held`,
 *                   `duplicate-delivery`) where nothing was refused.
 *
 * The refusal CLASS is an enum, not free text: `upstream-refused` (with the
 * HTTP status), `cascade-cap`, `delivery-refused`. The kernel stores the class
 * so refusals are countable, and rejects anything else with a 400. A producer
 * that cannot classify itself maps to `delivery-refused` before sending — the
 * mapping is here, in one place, rather than in each producer.
 *
 * A thrown turn returns no turnResult and releases with no outcome — the
 * legacy holder-only DELETE whose at-least-once redelivery is the correct
 * behaviour for a crashed spawn (the lid closed, the process died).
 */

/** The classes the kernel accepts. Mirrors `REFUSAL_REASONS` in agentsRuntime. */
export const REFUSAL_REASONS = ['upstream-refused', 'cascade-cap', 'delivery-refused'];

/** What an unclassifiable refusal is recorded as, rather than a fourth class. */
export const DEFAULT_REFUSAL_REASON = 'delivery-refused';

/**
 * @param {{type?: string, payload?: {senderIsHuman?: boolean}}} event
 * @param {{refused?: {reason?: string, status?: number}|true, outcome?: string, reason?: string}|undefined} turnResult
 * @returns {{outcome?: 'refused'|'declined'|'completed', reason?: string, status?: number}}
 */
export const claimReleaseFor = (event, turnResult) => {
  if (!turnResult) return { outcome: undefined };
  // `refused: true` is still honoured: it is what an older producer shape (and
  // a third-party wrapper following TASK-096's docs) sends, and it means the
  // same thing — `delivery-refused`, the class that claims the least.
  if (turnResult.refused) {
    const declared = typeof turnResult.refused === 'object' ? turnResult.refused : {};
    const reason = REFUSAL_REASONS.includes(declared.reason)
      ? declared.reason
      : DEFAULT_REFUSAL_REASON;
    // The status is the instance of the class, and only the upstream class has
    // one: a cap refusal or a refused post never saw an upstream HTTP status,
    // so sending its number would put a field on the record that cannot mean
    // what a reader would assume.
    const status = reason === 'upstream-refused' && Number.isInteger(declared.status)
      ? declared.status
      : undefined;
    return {
      outcome: 'refused',
      reason,
      ...(status !== undefined ? { status } : {}),
    };
  }
  if (event?.type === 'message.posted'
      && event.payload?.senderIsHuman === true
      && turnResult.outcome === 'no_action'
      && !turnResult.reason) {
    return { outcome: 'declined' };
  }
  return { outcome: 'completed' };
};

/**
 * `refused` is a LOCAL release marker: the producer sets it so the claim
 * release can name the outcome (see `claimReleaseFor`), and nothing else reads
 * it. The event ack is a wire payload with its own readers, and the information
 * that belongs there already reaches them as `reason` — so the marker is
 * dropped at the ack boundary rather than widening the ack with an internal
 * flag. Returns the result unchanged when there is no marker, so the common
 * path never sees a rebuilt object.
 *
 * @param {object|undefined} turnResult
 */
export const ackResultFor = (turnResult) => {
  if (!turnResult || !turnResult.refused) return turnResult;
  // ts-eslint's `arg`/`vars` ignore pattern is `^_`, and ignoreRestSiblings is
  // off in this repo's config — so the dropped key is renamed rather than
  // left to trip no-unused-vars.
  const { refused: _refused, ...rest } = turnResult;
  return rest;
};
