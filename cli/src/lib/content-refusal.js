/**
 * A model provider that refuses a request's CONTENT (2026-10-16).
 *
 * A security-gate seat on codex was asked to review a PR whose request carried
 * SSRF, exfiltration and ReDoS test cases. The provider refused every turn
 * ("flagged for possible cybersecurity risk"). The run loop classed that as a
 * transient runtime failure, so it never acked and re-sent the same content on
 * backoff, five refusals in 52 minutes on a login every codex seat shares. The
 * seat handled nothing else until the kernel's requeue cap retired the event.
 *
 * A content refusal is deterministic: the same content is refused again. So it
 * is acked once, as refused, and never retried. A refused request addressed to
 * the seat is not dropped silently either: the wrapper, not the model, posts one
 * line naming the request (PR, head, message id, sender) and, when the seat is
 * run with `--refusal-handoff <agent>`, @mentions that agent to take it. The
 * line repeats nothing else from the request: the flagged text stays out of
 * the pod.
 */
import { classifySpawnFailure, SPAWN_FAILURE_CLASS } from './spawn-retry.js';

/** The ack reason, so the event ledger counts refusals by name. */
export const CONTENT_REFUSED_REASON = 'provider-refused';

export const isContentRefusal = (error) => (
  classifySpawnFailure(error) === SPAWN_FAILURE_CLASS.CONTENT_REFUSED
);

/**
 * The turn result for a refused item. `refused` releases its claim as
 * `upstream-refused` (claim-outcome.js): on a human broadcast the kernel hands
 * the message to one remaining listener, as it does for any upstream refusal.
 * `outcome: 'error'` is terminal on the kernel side; the event is acked, not
 * requeued.
 */
export const contentRefusedResult = (error = null) => ({
  outcome: 'error',
  refused: { reason: 'upstream-refused' },
  reason: CONTENT_REFUSED_REASON,
  details: {
    failureClass: SPAWN_FAILURE_CLASS.CONTENT_REFUSED,
    // Only a supervised run can see a refusal the CLI dropped; name it so the
    // ledger can tell the two apart. Absent otherwise.
    ...(error?.kind === 'refusal_dropped' ? { failureKind: 'refusal_dropped' } : {}),
  },
});

// A full 40-hex commit id. Shorter hex runs are not taken: the server's pod
// context frame carries 24-hex pod ids, and a short match would name one as
// the head.
const FULL_SHA_RE = /\b[0-9a-f]{40}\b/g;
const PR_REF_RE = /#\d{2,6}\b/;
const MAX_HEADS = 3;

/** An agent handle as the server resolves mentions; anything else is dropped. */
export const sanitizeHandoffAgent = (value) => {
  const name = String(value ?? '').trim().replace(/^@/, '');
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) ? name : null;
};

/**
 * What the notice may name about a refused request: identifiers only. The PR is
 * the first `#N`; the heads are every distinct full commit id (a request that
 * names two is reported with both, rather than guessing which one is current).
 */
export const refusedItemRef = (event) => {
  const payload = event?.payload || {};
  const content = String(payload.content || '');
  const pr = content.match(PR_REF_RE)?.[0] || null;
  const heads = [...new Set(content.match(FULL_SHA_RE) || [])].slice(0, MAX_HEADS);
  const rawMessageId = String(payload.messageId ?? '');
  const messageId = /^[A-Za-z0-9]{1,40}$/.test(rawMessageId) ? rawMessageId : null;
  const from = String(payload.username || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || null;
  return { pr, heads, messageId, from };
};

const describeItem = ({ pr, heads, messageId, from }) => {
  const subject = pr ? `${pr}${heads.length ? ` at ${heads.map((head) => `\`${head}\``).join(' or ')}` : ' (no head named)'}` : 'a request';
  const source = [messageId ? `message ${messageId}` : null, from ? `from ${from}` : null]
    .filter(Boolean).join(' ');
  return source ? `${subject} (${source})` : subject;
};

/**
 * The one line the wrapper posts. `mention` is false in a DM, where @mentioning
 * a third agent would pull it toward a 1:1 conversation it cannot join.
 */
export const composeRefusalHandoff = ({ items, handoff = null, mention = true }) => {
  const agent = sanitizeHandoffAgent(handoff);
  const one = items.length === 1;
  const what = one ? describeItem(items[0]) : `${items.length} requests: ${items.map(describeItem).join('; ')}`;
  const lead = `The model provider refused the content of ${what}, so I could not read ${one ? 'it' : 'them'} and will not retry ${one ? 'it' : 'them'}.`;
  if (agent && mention) return `${lead} @${agent}, please take ${one ? 'it' : 'them'}.`;
  return `${lead} ${one ? 'It needs' : 'They need'} another reader.`;
};
