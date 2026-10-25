// Resolve the human-readable label for an agent User row. The fallback
// chain is intentional and load-bearing for any UI / pod-naming surface
// that shows agent identity (agent-dm pod names, sidebar member rows):
//
//   1. `botMetadata.displayName`  — the curated label the registry/preset
//      sets ("Pixel", "Strategist (Aria)"). This is what humans actually
//      recognize.
//   2. `botMetadata.instanceId`   — when displayName is missing AND the
//      instanceId carries identity (i.e. != 'default'). For OpenClaw-driven
//      agents the User row stores `agentName: 'openclaw'` (the RUNTIME) +
//      `instanceId: 'aria' | 'pixel' | ...` (the identity), so falling back
//      to instanceId here beats falling back to the runtime label.
//   3. `username`                 — last-resort identifier; always set.
//   4. fallback string            — for the non-User case (e.g. resolved-
//      by-alias before the User row is loaded).
//
// Why NOT fall back to `botMetadata.agentName`: that field can be the
// runtime name ('openclaw') rather than the agent's identity. Falling
// back to it produces "openclaw ↔ openclaw" pod names where what we want
// is "Pixel ↔ Strategist (Aria)".
export function resolveAgentDisplayLabel(
  user: {
    username?: string;
    botMetadata?: { displayName?: string; instanceId?: string; agentName?: string };
  } | null | undefined,
  fallback?: string,
): string {
  const safeFallback = fallback || 'agent';
  if (!user) return safeFallback;
  const meta = user.botMetadata;
  const display = meta?.displayName?.trim();
  const agentName = meta?.agentName?.trim() || '';
  const instanceId = meta?.instanceId?.trim() || '';
  // Leak-pattern detection. If displayName is literally `<agentName> (<instanceId>)`
  // (e.g. "openclaw (nova)"), it's the runtime label leaking through — some
  // historical writer formatted displayName as `${agentName} (${instanceId})`
  // instead of using the curated label. Treat these as if displayName were
  // missing and fall through to instanceId. Matches both the
  // `<runtime> (<instance>)` form and the bare `<runtime>` form
  // (e.g. displayName === 'openclaw') for a non-default instance. A default
  // agent can have a curated label equal to its name ('Pixel'), so bare
  // equality alone does not prove a runtime leak there.
  const leakedPattern = (
    !!display
    && !!agentName
    && (
      (!!instanceId && instanceId !== 'default' && display.toLowerCase() === agentName.toLowerCase())
      || (
        !!instanceId
        && display.toLowerCase() === `${agentName.toLowerCase()} (${instanceId.toLowerCase()})`
      )
    )
  );
  if (display && !leakedPattern) return display;
  if (instanceId && instanceId !== 'default') return instanceId;
  if (user.username) return user.username;
  return safeFallback;
}

