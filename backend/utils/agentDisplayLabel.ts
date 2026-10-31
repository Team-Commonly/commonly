// agentNames that name a shared runtime, not an agent. Only these can leak
// their runtime name as a displayName. A product agent that happens to share
// its name with its curated label keeps that label: 'Scout' on agentName 'scout'
// (TASK-551). commonly-bot and commonly-summarizer are product agents too, so
// their displayName shows even when it equals their agentName. A codex seat
// created without a displayName takes the officialDisplayName 'Codex'
// (agentIdentityService.ts), and a claude-code seat takes 'Claude Code', so both
// must stay here.
const SHARED_RUNTIME_AGENT_NAMES = new Set(['openclaw', 'codex', 'claude-code']);

// Equal names ignoring case, spaces and hyphens, so the officialDisplayName
// 'Claude Code' is the same leak as the agentName 'claude-code'.
const sameName = (a: string, b: string): boolean => (
  a.toLowerCase().replace(/[\s-]/g, '') === b.toLowerCase().replace(/[\s-]/g, '')
);

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
  // equality alone does not prove a runtime leak there. The `<name> (<instance>)`
  // form counts only for a shared runtime: a product agent's collision label
  // ("Scout (Scout-Demo)", TASK-551) is its own label, and treating it as a leak
  // would show the raw instance id.
  const sharedRuntime = SHARED_RUNTIME_AGENT_NAMES.has(agentName.toLowerCase());
  const leakedPattern = (
    !!display
    && !!agentName
    && (
      (!!instanceId && instanceId !== 'default'
        && sharedRuntime
        && sameName(display, agentName))
      || (
        !!instanceId
        && sharedRuntime
        && display.toLowerCase() === `${agentName.toLowerCase()} (${instanceId.toLowerCase()})`
      )
    )
  );
  if (display && !leakedPattern) return display;
  if (instanceId && instanceId !== 'default') return instanceId;
  if (user.username) return user.username;
  return safeFallback;
}

