/**
 * Named run failures. Every way a run can end badly has one kind, so a trace,
 * a retry policy and a dashboard all read the same word. A kind is a contract:
 * add one here, never mint one at a call site.
 */
import { scrubAdapterFailure } from './upstream-refusal.js';

export const FAILURE_KINDS = Object.freeze({
  stuck: { retryable: true, meaning: 'no progress signal within the liveness window' },
  timeout: { retryable: true, meaning: 'the run exceeded its wall-clock budget' },
  exited: { retryable: true, meaning: 'the CLI process ended before the turn settled' },
  protocol: { retryable: false, meaning: 'the CLI broke its wire protocol' },
  provider_unsupported: { retryable: false, meaning: 'the CLI cannot be pointed at the run\'s OpenAI- or Anthropic-compatible provider' },
  refusal: { retryable: false, meaning: 'the model or provider refused; never retried' },
  max_tokens: { retryable: false, meaning: 'the turn hit its token limit' },
  max_turn_requests: { retryable: false, meaning: 'the turn hit its request limit' },
  cancelled: { retryable: false, meaning: 'the run was cancelled' },
  credential_denied: { retryable: false, meaning: 'the run asked for a credential its grant does not allow' },
  unsupported: { retryable: false, meaning: 'the CLI or its version is outside what this adapter supports' },
  // The harness cannot serve anyone right now. Retrying on the same harness is
  // pointless; a run config's fallback moves to its next entry (harness-plan.js).
  not_authenticated: { retryable: false, meaning: 'the CLI is not signed in, or its sign-in was rejected' },
  quota: { retryable: false, meaning: 'the account behind the CLI is out of quota or credits' },
  provider_unsupported: { retryable: false, meaning: 'the provider does not serve this model to this account' },
  capacity: { retryable: true, meaning: 'every entry the run config allows is at a host cap or held; it may run once one frees' },
});

export class RunFailure extends Error {
  constructor(kind, detail, { cause } = {}) {
    if (!FAILURE_KINDS[kind]) throw new Error(`unknown failure kind: ${kind}`);
    super(detail ? `${kind}: ${detail}` : kind, cause ? { cause } : undefined);
    this.name = 'RunFailure';
    this.kind = kind;
    this.retryable = FAILURE_KINDS[kind].retryable;
    this.detail = detail || '';
  }
}

/** Build a failure whose detail has known credentials and secret shapes scrubbed. */
export const runFailure = (kind, text, { credentials = [], limit } = {}) => {
  const { detail } = scrubAdapterFailure(String(text ?? ''), { credentials, limit });
  return new RunFailure(kind, detail);
};

export const failureKindOf = (error) => (error instanceof RunFailure ? error.kind : null);
