/**
 * The moltbot (OpenClaw) runtime is retired (ADR-021 Part B). No gateway runs
 * in Helm, in compose or on the VM, so an install, provision or reprovision of
 * one would record an agent that never starts. The install route (add-to-pod
 * included) and the provision route refuse it with the same 410 body, before
 * they write anything; reprovision skips it; a DM room opened with a stored
 * moltbot agent gets no installation row. Paths that need the agent itself to
 * be running (runtime-token self-installs, scheduled auto-join) cannot fire.
 *
 * The runtime type itself stays known: it still describes historical rows, and
 * those rows keep loading (their User, memory and pod memberships stay).
 */

export const RUNTIME_RETIRED_BODY = Object.freeze({
  code: 'runtime_retired',
  message: 'OpenClaw agents were retired. Use a native agent, or attach a local CLI.',
});

export const moltbotRuntimeRetired = (runtimeType: unknown): boolean => (
  String(runtimeType || '').trim().toLowerCase() === 'moltbot'
);
