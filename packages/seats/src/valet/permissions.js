/**
 * Turn a grant into ctx.decidePermission: the answer to ACP's
 * session/request_permission, decided per tool call.
 *
 *   allow → the allow_once option
 *   deny  → the reject_once option, or cancelled when there is none
 *   ask   → approve({ toolCall, grantRule }) from the host; true allows,
 *           anything else (false, a throw, no answer in time) denies
 *
 * allow_always and reject_always are never chosen: either would be remembered
 * by the agent past this grant, so the next call would skip the check.
 * An allow rule with no allow_once option therefore denies.
 */
import { traceOf } from '../trace/events.js';
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

/**
 * Wait for the host's approval, bounded. Resolves 'approved' | 'rejected' |
 * 'timed_out' | 'failed' | 'aborted'; never rejects, so a broken approver
 * becomes a denial rather than a hung or crashed turn.
 */
const awaitApproval = (approve, input, { timeoutMs, signal }) => new Promise((done) => {
  if (typeof approve !== 'function') { done('failed'); return; }
  if (signal?.aborted) { done('aborted'); return; }
  let finished = false;
  const finish = (verdict) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    done(verdict);
  };
  const onAbort = () => finish('aborted');
  const timer = setTimeout(() => finish('timed_out'), timeoutMs);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  Promise.resolve()
    .then(() => approve(input))
    .then((answer) => finish(answer === true ? 'approved' : 'rejected'), () => finish('failed'));
});

/**
 * createPermissionPolicy(grant, { approve?, trace?, approveTimeoutMs?, signal? })
 *   → (request) => Promise<{outcome:'selected', optionId} | {outcome:'cancelled'}>
 *
 * `signal` is the run's AbortSignal: a cancelled run answers a pending ask
 * with cancelled, which is what ACP asks of a client after session/cancel.
 */
export const createPermissionPolicy = (grant, {
  approve, trace, approveTimeoutMs = DEFAULT_APPROVE_TIMEOUT_MS, signal,
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
      if (approval === 'aborted') answer = { outcome: 'cancelled' };
      else answer = approval === 'approved' ? allowAnswer(options) : null;
    } else if (decision === 'allow') {
      answer = allowAnswer(options);
    }
    if (!answer) answer = denyAnswer(options);
    hook.emit('permission.decided', {
      outcome: answer.outcome,
      ...(answer.optionId ? { optionId: answer.optionId, kind: answer.kind } : {}),
      toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null,
      rule,
      ...(approval ? { approval } : {}),
    });
    return answer.outcome === 'selected' ? { outcome: 'selected', optionId: answer.optionId } : { outcome: 'cancelled' };
  };
};
