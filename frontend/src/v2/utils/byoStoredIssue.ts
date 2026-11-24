// F572: the BYO page keeps the line it issued for this tab, so a reload shows
// it again instead of asking to replace a key nobody used. Only the connect
// code and non-secret fields are kept, never the key. A connect code can
// still be redeemed for the key until it runs out, so the entries go on
// sign-out (AuthContext) and any other user's go when the page opens.
// Storage can be disabled or full: every access is guarded, and the page
// works the same without it.

export interface StoredIssue {
  connectCode: string;
  connectCodeExpiresAt: number;
  issuedAt: number;
  // The server's createdAt for the key this line was issued with. An
  // existing:true answer names the current key's, so a key replaced from
  // another tab or device never brings back a dead line.
  keyCreatedAt: string;
  adapter: string;
  os: string;
}

const PREFIX = 'byo-issued:';
// The shape the command builder accepts (connectSnippet).
const CONNECT_CODE = /^cmc_[A-Za-z0-9_-]{22}$/;

export const storedIssueKey = (userId: string, podId: string, agentName: string, instanceId?: string | null): string => (
  `${PREFIX}${userId}:${podId}:${agentName}:${instanceId || 'default'}`
);

export const forgetIssue = (key: string): void => {
  try { sessionStorage.removeItem(key); } catch { /* Storage can be disabled. */ }
};

export const saveIssue = (key: string, entry: StoredIssue): void => {
  try { sessionStorage.setItem(key, JSON.stringify(entry)); } catch { /* Storage can be disabled. */ }
};

// The entry under `key`, or null. One that is malformed or ran out is removed.
export const readStoredIssue = (key: string): StoredIssue | null => {
  let entry: Partial<StoredIssue> | null = null;
  try {
    entry = JSON.parse(sessionStorage.getItem(key) || 'null');
  } catch {
    forgetIssue(key);
    return null;
  }
  if (!entry) return null;
  if (typeof entry.connectCode !== 'string' || !CONNECT_CODE.test(entry.connectCode)
    || typeof entry.connectCodeExpiresAt !== 'number' || entry.connectCodeExpiresAt <= Date.now()
    || typeof entry.issuedAt !== 'number' || typeof entry.keyCreatedAt !== 'string'
    || typeof entry.adapter !== 'string' || typeof entry.os !== 'string') {
    forgetIssue(key);
    return null;
  }
  return entry as StoredIssue;
};

// True when two server timestamps name the same instant.
export const sameKeyCreatedAt = (stored: string, current: unknown): boolean => {
  if (typeof current !== 'string') return false;
  const a = Date.parse(stored);
  return Number.isFinite(a) && a === Date.parse(current);
};

// Removes every stored line except `keepUserId`'s; with none kept, all of them.
export const forgetStoredIssues = (keepUserId?: string | null): void => {
  try {
    const keep = keepUserId ? `${PREFIX}${keepUserId}:` : null;
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(PREFIX) && !(keep && key.startsWith(keep))) doomed.push(key);
    }
    doomed.forEach((key) => sessionStorage.removeItem(key));
  } catch { /* Storage can be disabled. */ }
};
