/**
 * F167: the install route's narrowing confirmation (F164), from the CLI.
 *
 * Joining a pod can confine a seat's writes in its other pods (an
 * outside-writable grant narrows it; backend agentRuntimeAuth). Before the
 * install is written the route answers 409 with this code and a sentence naming
 * what would change. The installer confirms by sending `confirmNarrowing: true`.
 * The server's text ends with that API advice, so the CLI swaps it for its own
 * flag.
 */

// Mirrors backend services/outsiderGrantNarrowingPreview.ts NARROWING_CONFIRM_CODE.
export const NARROWING_CONFIRM_CODE = 'outsider_grant_narrowing_confirm_required';

const API_ADVICE = /\s*Send confirmNarrowing: true to install anyway\.\s*$/;
const CLI_ADVICE = 'Re-run with --confirm-narrowing to install anyway.';

/** The install body field for --confirm-narrowing: present only when set. */
export const narrowingConfirmBody = (confirm) => (confirm === true ? { confirmNarrowing: true } : {});

/**
 * The same refusal, telling a CLI user the flag instead of the API field. Any
 * other error is returned as it came.
 */
export const explainNarrowing = (error) => {
  if (error?.status !== 409 || error?.body?.code !== NARROWING_CONFIRM_CODE) return error;
  const said = String(error.body.message || error.message || '').replace(API_ADVICE, '').trim();
  const explained = new Error(said ? `${said} ${CLI_ADVICE}` : CLI_ADVICE);
  explained.status = error.status;
  explained.body = error.body;
  explained.code = NARROWING_CONFIRM_CODE;
  return explained;
};
