/**
 * The moltbot (OpenClaw) runtime is retired (ADR-021 Part B). No gateway runs
 * in Helm, in compose or on the VM, so an install, provision or reprovision of
 * one would record an agent that never starts. Every entry point refuses it
 * with the same 410 body, before it writes anything.
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
