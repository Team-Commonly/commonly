/**
 * A seat whose key or login stops working goes quiet (2026-11-06).
 *
 * The turn fails with a 401, the run loop opens the circuit and retries in 15
 * minutes, and the only trace is a line in a terminal the person in the pod may
 * not own. They see their @mention go unanswered, with no reason. The wrapper,
 * not the model, posts one plain line instead, since no model turn can run. It
 * names the cause and who can fix it. It never quotes the error text, which is
 * vendor output and can carry key material.
 */
import { classifySpawnFailure, SPAWN_FAILURE_CLASS } from './spawn-retry.js';

const NOT_INSTALLED_RE = /(?:ENOENT|command not found|not on PATH)/;
const LOGIN_FAILED_RE = /\b401\b|unauthori[sz]ed|authentication|invalid api key|expired key|not logged in|login required/i;

const AGAIN = 'After that, send your message again if I still haven’t answered.';

export const LOGIN_NOTICE = 'I can’t answer right now: the AI provider rejected the key or login on the computer '
  + `I run on. Whoever runs me needs to renew it and start me again. ${AGAIN}`;

export const NOT_INSTALLED_NOTICE = 'I can’t answer right now: the tool I run on wouldn’t start on my computer. '
  + `Whoever runs me needs to fix that and start me again. ${AGAIN}`;

/**
 * The line for a failure a person has to fix, or null. A 403 is not one of them:
 * F178 (model-unavailable.js) owns the 403 that names a model, and any other 403
 * can be a route's own refusal, which says nothing about the key.
 */
export const cantAnswerNotice = (error) => {
  if (classifySpawnFailure(error) !== SPAWN_FAILURE_CLASS.CONFIGURATION) return null;
  const text = `${error?.message}\n${error?.stderr}`;
  if (error?.code === 'ENOENT' || NOT_INSTALLED_RE.test(text)) return NOT_INSTALLED_NOTICE;
  return error?.status === 401 || LOGIN_FAILED_RE.test(text) ? LOGIN_NOTICE : null;
};
