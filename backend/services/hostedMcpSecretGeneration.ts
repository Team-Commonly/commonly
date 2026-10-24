/**
 * The write generation a hosted-MCP stable secret ref is fenced on.
 *
 * `connectorSecrets.put` lands a write only when the stored `writeGeneration`
 * is absent or no greater than the incoming one. An authorization generation
 * alone cannot order two refreshes that belong to ONE authorization, so a
 * superseded refresh could still replace a newer refresh's pair. Packing the
 * refresh generation in below the authorization generation orders every writer:
 * a callback is refresh 0 of its own authorization, a refresh is refresh N of
 * the authorization it read, and a newer /start raises the authorization, which
 * outranks every refresh of the old one.
 *
 * The stride must exceed the refresh count of any single authorization. Crossing
 * it is refused, not wrapped into an older authorization's range.
 */
export const HOSTED_MCP_SECRET_WRITE_STRIDE = 1_000_000;

export const secretWriteGeneration = (authGeneration: number, refreshGeneration: number): number => {
  if (!Number.isSafeInteger(authGeneration) || authGeneration < 0) {
    throw new Error('hosted MCP authorization generation must be a non-negative integer');
  }
  if (!Number.isSafeInteger(refreshGeneration) || refreshGeneration < 0
    || refreshGeneration >= HOSTED_MCP_SECRET_WRITE_STRIDE) {
    throw new Error('hosted MCP refresh generation is outside its secret write range');
  }
  return authGeneration * HOSTED_MCP_SECRET_WRITE_STRIDE + refreshGeneration;
};
