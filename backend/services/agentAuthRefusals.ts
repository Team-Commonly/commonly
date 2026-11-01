// Refusals from agentRuntimeAuth (TASK-712). Every refusal branch used to return
// 401 with no log line and no counter, so nothing server-side could say whether an
// agent had tried to connect and failed. This module logs one structured line per
// reason and token fingerprint, rate-limited, and keeps a per-reason count that an
// admin can read.
//
// It never carries a token. The fingerprint is the first 8 hex of the token's
// sha256, the same hash the credential lookups already use: a correlation handle,
// not a credential. The route is the mount prefix plus the route pattern, never
// originalUrl, so ids and query strings stay out of the line.

export const AGENT_AUTH_REFUSAL_REASONS = [
  'missing_token',
  'invalid_token',
  'agent_not_installed',
  'session_expired',
  'credential_invalid',
  'token_revoked',
  'credential_owner_deleting',
  'issuing_credential_revoked',
  'machine_access_revoked',
] as const;

export type AgentAuthRefusalReason = typeof AGENT_AUTH_REFUSAL_REASONS[number];

// The credential gate answers with fixed strings. Map each to a bounded code so
// the reason is a dimension the log and the count can group on.
const CREDENTIAL_REFUSAL_REASONS: Record<string, AgentAuthRefusalReason> = {
  'Invalid agent credential': 'credential_invalid',
  'Token revoked': 'token_revoked',
  'Credential owner is being deleted': 'credential_owner_deleting',
  'Session token expired': 'session_expired',
  'Issuing credential revoked': 'issuing_credential_revoked',
  'Machine access revoked': 'machine_access_revoked',
};

export const credentialRefusalReason = (message: string): AgentAuthRefusalReason => (
  CREDENTIAL_REFUSAL_REASONS[message] || 'credential_invalid'
);

// A stuck client polling every few seconds gets one line per minute per
// (reason, fingerprint); the repeats are counted and reported on the next line.
// A spray of distinct tokens gets one line per fingerprint, so a global budget
// caps the line rate too. Counts are never rate-limited.
const LOG_WINDOW_MS = 60_000;
const LOG_BUDGET_PER_WINDOW = 100;
const MAX_TRACKED_KEYS = 5_000;

const counts: Record<AgentAuthRefusalReason, number> = Object.fromEntries(
  AGENT_AUTH_REFUSAL_REASONS.map((reason) => [reason, 0]),
) as Record<AgentAuthRefusalReason, number>;
const startedAt = new Date().toISOString();
const lastLogged = new Map<string, { at: number; suppressed: number }>();
let budgetWindowStart = 0;
let budgetUsed = 0;

export const refusalFingerprint = (tokenHash?: string | null): string => (
  tokenHash ? tokenHash.slice(0, 8) : 'none'
);

export const refusalRoute = (req: { baseUrl?: string; route?: { path?: unknown } }): string => {
  const pattern = typeof req.route?.path === 'string' ? req.route.path : '';
  const route = `${req.baseUrl || ''}${pattern}`;
  return route || 'unknown';
};

export const recordAgentAuthRefusal = ({
  reason, route, method, tokenHash, now = Date.now(),
}: {
  reason: AgentAuthRefusalReason;
  route: string;
  method?: string;
  tokenHash?: string | null;
  now?: number;
}): void => {
  counts[reason] += 1;
  const fingerprint = refusalFingerprint(tokenHash);
  const key = `${reason}:${fingerprint}`;

  const entry = lastLogged.get(key);
  if (entry && now - entry.at < LOG_WINDOW_MS) {
    entry.suppressed += 1;
    return;
  }
  if (now - budgetWindowStart >= LOG_WINDOW_MS) {
    budgetWindowStart = now;
    budgetUsed = 0;
  }
  if (budgetUsed >= LOG_BUDGET_PER_WINDOW) return;
  budgetUsed += 1;

  lastLogged.delete(key);
  lastLogged.set(key, { at: now, suppressed: 0 });
  if (lastLogged.size > MAX_TRACKED_KEYS) {
    const oldest = lastLogged.keys().next().value;
    if (oldest !== undefined) lastLogged.delete(oldest);
  }

  console.warn('[agent-auth-refused]', JSON.stringify({
    reason,
    route,
    method: method || null,
    fingerprint,
    repeatsSinceLastLog: entry?.suppressed ?? 0,
  }));
};

// Per-reason counts since this backend process started. Per replica, like the
// rate-limit watermark: a fleet total needs a sum across replicas.
export const agentAuthRefusalCounts = () => ({
  since: startedAt,
  counts: { ...counts },
});

// Test seam: clears the rate-limit state and counts so each test starts clean.
export const resetAgentAuthRefusalsForTest = (): void => {
  for (const reason of AGENT_AUTH_REFUSAL_REASONS) counts[reason] = 0;
  lastLogged.clear();
  budgetWindowStart = 0;
  budgetUsed = 0;
};
