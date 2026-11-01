// Tool connectors: the shapes the installables and grants routes return, and the
// pure helpers the tool hook and panels share. Moved from the retired
// tools list component (TASK-733); nothing here renders.
import { relativeParts } from '../utils/localizeRelativeTime';

export type GrantWriteMode = 'read' | 'write' | 'write-with-confirm';

export interface ToolGrant {
  grantId: string;
  installationId: string;
  target: { kind: 'pod' | 'seat'; id: string };
  tools: string[];
  writeMode: GrantWriteMode;
  budget: { calls?: number; windowMs?: number } | null;
  effectiveAudience: string[];
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  parentGrantId: string | null;
  rootGrantId: string | null;
  createdAt: string;
  grantedBy: string | null;
  /**
   * The connector the server reads from the grant's tool namespace (TASK-753).
   * It still names a grant whose catalogue entry is hidden or gone, which
   * `entryCovers` can no longer match; null when the tools name no single
   * known connector.
   */
  connector?: { id: string; label: string } | null;
}

/** `superseded` is a DERIVED read-only value the server reports for a parked
 * request whose approval has since resolved: the call itself is the row beside
 * it (ok / refused / failed), and this row is only the ask. It is never stored,
 * so it is never what a write sends. */
export type ToolOutcome = 'ok' | 'refused' | 'pending_approval' | 'failed' | 'superseded';

export interface ToolCallLine {
  callId: string;
  agentUserId: string;
  tool: string;
  outcome: ToolOutcome;
  reason: string | null;
  approvalId: string | null;
  argsDigest: string;
  at: string | null;
  durationMs: number | null;
}

export interface ToolTrail {
  grantId: string;
  calls: ToolCallLine[];
  counts: { total: number; ok: number; refused: number; pending_approval: number; failed: number };
}

/** A tool Installable as GET /api/installables lists it (list: 'tools', #1670). */
export interface ToolCatalogEntry {
  installableId: string;
  list?: 'channels' | 'tools';
  label: string;
  description: string;
  connectNotice?: string;
  /**
   * Where the person chooses, at the vendor, what the connection can reach
   * (GitHub: the App's install page, which picks the repositories).
   */
  accessPage?: string;
  /**
   * The connection type this row's tools run through, and — on a hosted entry —
   * the catalogue entry the start route takes. `entryId` is absent on
   * `github-app`, whose connections are not per entry.
   */
  connectionType?: 'github-app' | 'hosted-mcp';
  entryId?: string;
  available: boolean;
  unavailableReason?: string;
  broker?: { id: string };
  tools: Array<{ name: string; description?: string; requiredWriteMode: GrantWriteMode; irreversible: boolean }>;
  connections: ToolConnection[];
}

/** A hosted row also says when it was made and, for an operator key, its agent,
 *  so two of them can be told apart. */
export interface ToolConnection {
  connectionId: string;
  owner: string;
  repo: string;
  connectedAt?: string;
  /** The bot User a key row is bound to; absent on the OAuth sign-in. */
  agentId?: string;
}

export interface HiddenToolConnection {
  connectionId: string;
  entryId: string;
  label: string;
  status: string;
  revokePage: string | null;
}

export interface HostedMcpManualRevokeNotice {
  connectionId: string;
  entryId: string;
  provider: string;
  revokePage: string;
}

export interface PodSeat { userId: string | null; displayName?: string; name: string; internal?: boolean }


export interface DraftGrant {
  entry: ToolCatalogEntry;
  podId: string;
  connectionId: string;
  writeMode: GrantWriteMode;
  audience: string[];
  expiryDays: 7 | 30 | 90;
  /** Change access: the grant this one replaces (revoked after the mint). */
  replaces: string | null;
}

export interface GithubAppSetup {
  installationId: string;
  owner: string;
  repo: string;
}

export interface GithubAppIntegrationResponse {
  integration?: {
    createdBy?: string | { _id?: string } | null;
  };
}

export const USED_RECENTLY_MS = 10 * 60 * 1000;
export const MODE_RANK: Record<GrantWriteMode, number> = { read: 0, 'write-with-confirm': 1, write: 2 };
// The two option sets the aside renders as buttons. They live here, not inline in the
// JSX, because eslint's i18next/no-literal-string (jsx-only) reads an array literal in
// a JSX expression as copy — and these are ids, not words (TASK-164).
export const WRITE_MODES: GrantWriteMode[] = ['read', 'write-with-confirm', 'write'];

/**
 * The age as a unit-suffixed number ("23d", "5m", "just now"). Rounds through
 * relativeParts, the same rule as the "revoked … ago" line, so one timestamp
 * pair never reads "1d" in one place and "2d" in the other (TASK-649).
 */
export const shortAge = (date: string | null | undefined, now: number, t: (key: string, options?: Record<string, unknown>) => string): string => {
  const parts = relativeParts(date, { includeFuture: false, now });
  if (parts.kind !== 'rel') return t('time.age.justNow', { defaultValue: 'just now' });
  if (parts.unit === 'minute') return t('time.age.minutes', { defaultValue: '{{n}}m', n: parts.count });
  if (parts.unit === 'hour') return t('time.age.hours', { defaultValue: '{{n}}h', n: parts.count });
  return t('time.age.days', { defaultValue: '{{n}}d', n: parts.count });
};

// Both surfaces used to carry their own copy of this grammar; the locale family
// lives in one place now (TASK-164). Re-exported so the module's surface is
// unchanged for anything importing it from here.

export const isExpired = (grant: ToolGrant, now = Date.now()): boolean => new Date(grant.expiresAt).getTime() <= now;
// Callers that decide what a render SHOWS pass that render's `now`; the read
// path (`load`) leaves the default, because there the question is what is
// live at the moment of the read.
export const isDead = (grant: ToolGrant, now = Date.now()): boolean => Boolean(grant.revokedAt) || isExpired(grant, now);

// A catalogue entry is an Installable; a grant carries tool names and an
// `installationId` that names an install, not a catalogue id. The names are the
// only key both sides share, so an entry is the one whose tools the grant names.
export const entryCovers = (entry: ToolCatalogEntry, grant: ToolGrant): boolean => (
  (grant.tools || []).some((name) => (entry.tools || []).some((tool) => tool.name === name))
);
// A grant that names no tool of this entry grants nothing on it — that is what
// the enforcement path does (roomGrantService refuses any tool the grant does
// not list), so the page must not read such an entry as granted.
export const entryIsGranted = (entry: ToolCatalogEntry, grants: ToolGrant[], now: number): boolean => (
  grants.some((grant) => !isDead(grant, now) && entryCovers(entry, grant))
);

export const PER_ENTRY_REVOKE_COPY = new Set(['supabase', 'linear', 'sentry']);
