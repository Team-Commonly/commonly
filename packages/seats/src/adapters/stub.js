/**
 * Stub adapter — the no-op reference implementation of the ADR-005 adapter
 * contract. Used by `commonly agent attach stub` and the Phase-1a test
 * harness so the run loop can be reviewed end-to-end without a real CLI
 * on PATH.
 *
 * Contract (ADR-005 §Adapter pattern):
 *   detect(): Promise<{ path, version } | null>
 *   spawn(prompt, ctx): Promise<{ text, newSessionId?, memorySummary? }>
 *
 * The adapter MUST be pure: input (argv + env + prompt) → output (text + optional
 * next session-id + optional memory summary). No direct network, no direct API
 * calls, no hidden state. The run loop handles all Commonly-facing I/O.
 */

export default {
  name: 'stub',
  async detect() {
    return { path: '(builtin)', version: '0.0.0' };
  },
  async spawn(prompt, _ctx) {
    return { text: `(stub) received: ${String(prompt ?? '').slice(0, 200)}` };
  },
};
