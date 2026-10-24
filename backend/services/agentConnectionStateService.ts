// A connection is proven by the credential's use, not by an agent message or
// a task claim. Keep this verdict separate from the activity shown in pods.
export const BYO_STALE_MS = 5 * 60 * 1000;
export const MACHINE_STALE_MS = 90 * 1000;

type Credential = { tokenHash?: string; kind?: string; status?: string; lastUsedAt?: Date | string | null; expiresAt?: Date | string | null };

export const deriveAgentConnection = ({
  runtimeType, credentials, embeddedTokens = [], machineLastSeenAt = null, now = Date.now(),
  machineCredentials = [],
}: {
  runtimeType?: string;
  credentials: Credential[];
  machineCredentials?: Credential[];
  embeddedTokens?: Credential[];
  machineLastSeenAt?: Date | string | null;
  now?: number;
}) => {
  const isMachine = runtimeType === 'wrapper';
  const active = credentials.filter((credential) => credential.status === 'active'
    && (!credential.expiresAt || new Date(credential.expiresAt).getTime() > now));
  const activeMachine = machineCredentials.filter((credential) => credential.status === 'active'
    && (!credential.expiresAt || new Date(credential.expiresAt).getTime() > now));
  // An embedded copy is usable only when no ledger row exists or its ledger
  // row is active. Runtime auth applies the same ledger-first rule.
  const ledgerByHash = new Map(credentials.filter((credential) => credential.tokenHash)
    .map((credential) => [credential.tokenHash, credential]));
  const usableEmbedded = embeddedTokens.filter((token) => {
    const ledger = token.tokenHash ? ledgerByHash.get(token.tokenHash) : undefined;
    return (!ledger || (ledger.kind !== 'daemon' && ledger.status === 'active'
      && (!ledger.expiresAt || new Date(ledger.expiresAt).getTime() > now)))
      && (!token.expiresAt || new Date(token.expiresAt).getTime() > now);
  });
  const hasEmbedded = usableEmbedded.length > 0;
  if (!active.length && !hasEmbedded && credentials.some((credential) => credential.status === 'revoked')) {
    return { state: 'revoked', lastSeenAt: null };
  }
  if (isMachine && !activeMachine.length
    && machineCredentials.some((credential) => credential.status === 'revoked')) {
    return { state: 'revoked', lastSeenAt: null };
  }
  // A live daemon heartbeat only proves that the computer is online. The
  // agent itself is not connected until it holds a usable runtime key.
  if (isMachine && !active.length && !hasEmbedded) {
    return { state: 'never', lastSeenAt: null };
  }
  const dates = isMachine
    ? [machineLastSeenAt]
    : [...active, ...usableEmbedded].map((credential) => credential.lastUsedAt);
  const lastSeen = dates.reduce<number>((latest, value) => {
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
  if (!lastSeen) return { state: 'never', lastSeenAt: null };
  return {
    state: now - lastSeen > (isMachine ? MACHINE_STALE_MS : BYO_STALE_MS) ? 'stale' : 'connected',
    lastSeenAt: new Date(lastSeen).toISOString(),
  };
};
