/**
 * Turn a grant into ctx.decidePermission: the answer to ACP's
 * session/request_permission, decided per tool call.
 *
 *   allow → the allow_once option
 *   deny  → the reject_once option, or cancelled when there is none
 *   ask   → approve({ toolCall, grantRule }) from the host. `true` allows,
 *           and so does an object whose `approved` is exactly true:
 *           { approved: true, by: <user id>, role?, decisionCardId? }.
 *           Anything else (false, 'yes', {approved: 1}, a throw, no answer in
 *           time) denies. `by`/`role`/`decisionCardId` are recorded either way.
 *           An answer whose role is `pod-member` decides nothing (ADR-033 D5):
 *           the call stays parked, and approve is called again with
 *           `refused: { by, role: 'pod-member', reason: 'not_owner' }` so the
 *           card can show why and wait for the owner.
 *
 * allow_always and reject_always are never chosen: either would be remembered
 * by the agent past this grant, so the next call would skip the check.
 * An allow rule with no allow_once option therefore denies.
 */
import { traceOf } from '../trace/events.js';
import { argsDigestOf, PARKED_CALL_ROLES, isUserId, policyActorId } from '../record/format.js';
import { matchToolCall, validateGrant } from './grant.js';

export const DEFAULT_APPROVE_TIMEOUT_MS = 5 * 60 * 1000;
// An approver that keeps handing back pod-member answers is broken; after this
// many the ask fails, and the policy's default decides, as for any broken approver.
export const MAX_REFUSED_ANSWERS = 10;

const optionOfKind = (options, kind) => (Array.isArray(options) ? options : [])
  .find((option) => option && option.kind === kind && typeof option.optionId === 'string');

const allowAnswer = (options) => {
  const option = optionOfKind(options, 'allow_once');
  return option ? { outcome: 'selected', optionId: option.optionId, kind: option.kind } : null;
};
const denyAnswer = (options) => {
  const option = optionOfKind(options, 'reject_once');
  return option ? { outcome: 'selected', optionId: option.optionId, kind: option.kind } : { outcome: 'cancelled' };
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;

/**
 * What an approver's answer says. Only `true`, or an object with
 * `approved === true`, approves; attribution is taken from an object either
 * way, and a malformed field is dropped rather than trusted.
 */
const readAnswer = (answer) => {
  if (answer === true) return { verdict: 'approved' };
  if (!isPlainObject(answer)) return { verdict: 'rejected' };
  return {
    verdict: answer.approved === true ? 'approved' : 'rejected',
    ...(isUserId(answer.by) ? { by: answer.by } : {}),
    ...(PARKED_CALL_ROLES.includes(answer.role) ? { role: answer.role } : {}),
    ...(isText(answer.decisionCardId) ? { decisionCardId: answer.decisionCardId } : {}),
  };
};

const isPodMemberAnswer = (answer) => isPlainObject(answer) && answer.role === 'pod-member';

/**
 * Wait for the host's approval, bounded. Resolves { verdict, by?, role?,
 * decisionCardId? }, verdict 'approved' | 'rejected' | 'timed_out' | 'failed'
 * | 'aborted'; never rejects, so a broken approver becomes a denial rather
 * than a hung or crashed turn.
 */
const awaitApproval = (approve, input, { timeoutMs, signal }) => new Promise((done) => {
  if (typeof approve !== 'function') { done({ verdict: 'failed' }); return; }
  if (signal?.aborted) { done({ verdict: 'aborted' }); return; }
  let finished = false;
  const finish = (verdict) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    done(verdict);
  };
  const onAbort = () => finish({ verdict: 'aborted' });
  const timer = setTimeout(() => finish({ verdict: 'timed_out' }), timeoutMs);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  let refusals = 0;
  const ask = (current) => Promise.resolve()
    .then(() => approve(current))
    .then((answer) => {
      if (finished) return;
      if (!isPodMemberAnswer(answer)) { finish(readAnswer(answer)); return; }
      // A pod member may not decide a parked call: the call stays parked and
      // the owner is asked again, with the refusal, inside the same timeout.
      refusals += 1;
      if (refusals > MAX_REFUSED_ANSWERS) { finish({ verdict: 'failed' }); return; }
      const refused = { by: isUserId(answer.by) ? answer.by : null, role: 'pod-member', reason: 'not_owner' };
      setTimeout(() => { if (!finished) ask({ ...input, refused }); }, 0);
    }, () => finish({ verdict: 'failed' }));
  ask(input);
});

/**
 * Who decided an ask, for the record. A person who answered is named by the
 * approver; no answer (timeout, failure, cancelled run) means the policy's
 * default decided. A bare true/false names nobody: decidedBy null.
 * Rule-decided calls carry no decidedBy here; the record writer fills in
 * "policy" for any decision whose rule list is not `ask`.
 */
const decider = (approval) => {
  if (approval.verdict === 'approved' || approval.verdict === 'rejected') {
    return {
      decidedBy: approval.by ?? null,
      decidedByRole: approval.role ?? null,
      ...(approval.decisionCardId ? { decisionCardId: approval.decisionCardId } : {}),
    };
  }
  return { decidedBy: 'policy', decidedByRole: 'policy' };
};

const isAsker = (value) => isPlainObject(value) && isUserId(value.id) && PARKED_CALL_ROLES.includes(value.role);

/**
 * Who an ask goes to, for permission.requested. `askedOf` is {id, role} or
 * ({toolCall, grantRule}) => {id, role, decisionCardId?}. A call a
 * rule decides is asked of the grant's policy. A function that throws or
 * answers malformed is recorded as asked of the policy too: the record does
 * not name a person it cannot vouch for.
 */
const askOf = (askedOf, input, policy) => {
  if (input.grantRule?.list !== 'ask') return policy;
  let answer = askedOf;
  if (typeof askedOf === 'function') {
    try { answer = askedOf(input); } catch { answer = null; }
  }
  if (!isAsker(answer)) return policy;
  return {
    id: answer.id,
    role: answer.role,
    ...(isText(answer.decisionCardId) ? { decisionCardId: answer.decisionCardId } : {}),
  };
};

/**
 * createPermissionPolicy(grant, { approve?, trace?, approveTimeoutMs?, signal?, grantId?, askedOf? })
 *   → (request) => Promise<{outcome:'selected', optionId} | {outcome:'cancelled'}>
 *
 * `signal` is the run's AbortSignal: a cancelled run answers a pending ask
 * with cancelled, which is what ACP asks of a client after session/cancel.
 * `grantId` is recorded on each decision, to tie it to its grant.issued.
 * With `askedOf` (above), each request is recorded first as
 * permission.requested: the question (the tool call's title), who it is
 * asked of, and the card it rides on. The approver receives that card id.
 * When the tool call carries `rawInput`, both entries carry its argsDigest.
 */
export const createPermissionPolicy = (grant, {
  approve, trace, approveTimeoutMs = DEFAULT_APPROVE_TIMEOUT_MS, signal, grantId, askedOf,
} = {}) => {
  const valid = validateGrant(grant);
  const hook = traceOf({ trace });
  if (askedOf !== undefined && typeof askedOf !== 'function' && !isAsker(askedOf)) {
    throw new Error('askedOf must be {id: <user id>, role: <decidedByRole>} or a function returning one');
  }
  const policy = { id: policyActorId(grantId), role: 'policy' };
  return async (request = {}) => {
    const toolCall = request?.toolCall || {};
    const options = request?.options;
    const { decision, rule } = matchToolCall(valid, toolCall);
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null;
    const argsDigest = argsDigestOf(toolCall.rawInput);
    let asker = null;
    if (askedOf !== undefined) {
      asker = askOf(askedOf, { toolCall, grantRule: rule }, policy);
      const fallback = `${isText(toolCall.kind) ? toolCall.kind : 'tool'} call`;
      hook.emit('permission.requested', {
        toolCallId,
        options: (Array.isArray(options) ? options : []).filter(isPlainObject).map(({ optionId, kind }) => ({ optionId, kind })),
        question: isText(toolCall.title) ? toolCall.title : fallback,
        askedOf: { id: asker.id, role: asker.role },
        ...(grantId ? { grantId } : {}),
        ...(asker.decisionCardId ? { decisionCardId: asker.decisionCardId } : {}),
        ...(argsDigest ? { argsDigest } : {}),
      });
    }
    let approval;
    let answer;
    if (decision === 'ask') {
      const input = { toolCall, grantRule: rule, ...(asker?.decisionCardId ? { decisionCardId: asker.decisionCardId } : {}) };
      approval = await awaitApproval(approve, input, { timeoutMs: approveTimeoutMs, signal });
      if (approval.verdict === 'aborted') answer = { outcome: 'cancelled' };
      else answer = approval.verdict === 'approved' ? allowAnswer(options) : null;
    } else if (decision === 'allow') {
      answer = allowAnswer(options);
    }
    if (!answer) answer = denyAnswer(options);
    hook.emit('permission.decided', {
      outcome: answer.outcome,
      ...(answer.optionId ? { optionId: answer.optionId, kind: answer.kind } : {}),
      toolCallId,
      rule,
      ...(approval ? { approval: approval.verdict, ...decider(approval) } : {}),
      ...(grantId ? { grantId } : {}),
      ...(argsDigest ? { argsDigest } : {}),
    });
    return answer.outcome === 'selected' ? { outcome: 'selected', optionId: answer.optionId } : { outcome: 'cancelled' };
  };
};
