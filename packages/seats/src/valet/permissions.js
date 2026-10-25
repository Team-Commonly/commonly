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
 *
 * allow_always and reject_always are never chosen: either would be remembered
 * by the agent past this grant, so the next call would skip the check.
 * An allow rule with no allow_once option therefore denies.
 */
import { traceOf } from '../trace/events.js';
import { DECIDED_BY_ROLES, isUserId } from '../record/format.js';
import { matchToolCall, validateGrant } from './grant.js';

export const DEFAULT_APPROVE_TIMEOUT_MS = 5 * 60 * 1000;

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
    ...(DECIDED_BY_ROLES.includes(answer.role) ? { role: answer.role } : {}),
    ...(isText(answer.decisionCardId) ? { decisionCardId: answer.decisionCardId } : {}),
  };
};

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
  Promise.resolve()
    .then(() => approve(input))
    .then((answer) => finish(readAnswer(answer)), () => finish({ verdict: 'failed' }));
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

/**
 * createPermissionPolicy(grant, { approve?, trace?, approveTimeoutMs?, signal?, grantId? })
 *   → (request) => Promise<{outcome:'selected', optionId} | {outcome:'cancelled'}>
 *
 * `signal` is the run's AbortSignal: a cancelled run answers a pending ask
 * with cancelled, which is what ACP asks of a client after session/cancel.
 * `grantId` is recorded on each decision, to tie it to its grant.issued.
 */
export const createPermissionPolicy = (grant, {
  approve, trace, approveTimeoutMs = DEFAULT_APPROVE_TIMEOUT_MS, signal, grantId,
} = {}) => {
  const valid = validateGrant(grant);
  const hook = traceOf({ trace });
  return async (request = {}) => {
    const toolCall = request?.toolCall || {};
    const options = request?.options;
    const { decision, rule } = matchToolCall(valid, toolCall);
    let approval;
    let answer;
    if (decision === 'ask') {
      approval = await awaitApproval(approve, { toolCall, grantRule: rule }, { timeoutMs: approveTimeoutMs, signal });
      if (approval.verdict === 'aborted') answer = { outcome: 'cancelled' };
      else answer = approval.verdict === 'approved' ? allowAnswer(options) : null;
    } else if (decision === 'allow') {
      answer = allowAnswer(options);
    }
    if (!answer) answer = denyAnswer(options);
    hook.emit('permission.decided', {
      outcome: answer.outcome,
      ...(answer.optionId ? { optionId: answer.optionId, kind: answer.kind } : {}),
      toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null,
      rule,
      ...(approval ? { approval: approval.verdict, ...decider(approval) } : {}),
      ...(grantId ? { grantId } : {}),
    });
    return answer.outcome === 'selected' ? { outcome: 'selected', optionId: answer.optionId } : { outcome: 'cancelled' };
  };
};
