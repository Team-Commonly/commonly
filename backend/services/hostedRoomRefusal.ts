export const HOSTED_NO_SHARED_OWNER = 'hosted_no_shared_owner';

/**
 * Nobody who hosts this agent shares a pod with the person opening a DM, so no
 * one's line can carry the turn. It names no account: who hosts an agent isn't
 * the person's to learn from a refusal. No dependencies, so the broker's callers
 * can catch it without loading the hosted runtime.
 */
export class HostedRoomRefusedError extends Error {
  readonly code = HOSTED_NO_SHARED_OWNER;

  readonly status = 403;

  constructor() {
    super("This agent isn't hosted in a pod you're in. Join a pod where someone hosts it to talk to it.");
    this.name = 'HostedRoomRefusedError';
  }
}

export const isHostedRoomRefusal = (error: unknown): error is HostedRoomRefusedError => (
  (error as { code?: unknown } | null | undefined)?.code === HOSTED_NO_SHARED_OWNER
);
