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
  /** F214: the grant holds pull-request access. Its PR tools park every call for the connection owner. */
  prWrite?: boolean;
  /** On the owner's own read only: the catalogue's key for the connection this grant was minted on. */
  connectionId?: string;
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
  /**
   * F94: the granter's own agents that run outside Commonly, named on this
   * grant, and the consent that named them with each one's sandbox
   * state as it was recorded then.
   */
  byoAgents?: string[];
  byoConsent?: { by: string; at: string; version: string; agents: Array<{ userId: string; sandbox: ByoSandbox }> };
}

export type ByoSandbox = 'confined' | 'unconfined' | 'unknown';

/** One of the viewer's agents in a pod that runs outside Commonly (GET /api/grants/byo-candidates). */
export interface ByoCandidate {
  userId: string;
  agentName: string;
  instanceId: string;
  nameable: boolean;
  reason?: 'unconfined_host' | 'adapter_unsupported';
  sandbox: ByoSandbox;
  /** F179: placed on a machine whose daemon hasn't picked it up yet, so its sandbox isn't known. */
  awaitingMachine?: boolean;
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
  /**
   * How a hosted entry is connected. Absent means OAuth (the start route); an
   * operator-key entry takes one pasted key per agent at its own route, and its
   * start route answers 404.
   */
  credentialMode?: 'operator_key';
  /** F221: a person can connect a repository of their own here (GET and POST /github-app/repositories). */
  repositoryConnect?: boolean;
  available: boolean;
  unavailableReason?: string;
  broker?: { id: string };
  tools: Array<{
    name: string;
    description?: string;
    requiredWriteMode: GrantWriteMode;
    irreversible: boolean;
    /** Held only on a `prWrite` grant, whatever the mode. The server names these, so the form copies no list. */
    prWrite?: boolean;
  }>;
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
  /** TASK-782: at connect, the account could see nothing to search (Sentry with no projects). */
  reach?: 'none';
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

export interface PodSeat {
  userId: string | null;
  displayName?: string;
  name: string;
  instanceId?: string;
  internal?: boolean;
  /** Who installed the seat in this pod: the roster's own field. */
  installedBy?: string | null;
  // Set by the pod roster: connector grants reach more than one of this seat's pods.
  runtimeNarrowedByMultipleGrantPods?: boolean;
  // Set by the pod roster: exactly one of this seat's several pods has a grant,
  // so it can post only there.
  runtimeNarrowedToOnePod?: boolean;
  // The roster could not run its grant census, so posting status is unknown.
  runtimeNarrowingUnavailable?: boolean;
}


export interface DraftGrant {
  entry: ToolCatalogEntry;
  podId: string;
  connectionId: string;
  writeMode: GrantWriteMode;
  /** F214: add pull-request access. The mint then goes out as write-with-confirm with `prWrite`. */
  prWrite: boolean;
  /** Change access: the PR tools the old grant named, so the change never adds one. */
  prTools?: string[] | null;
  /** Change access: this mint would not keep the old grant's pull-request access. */
  losesPrWrite?: boolean;
  audience: string[];
  expiryDays: 7 | 30 | 90;
  /** Change access: the grant this one replaces (revoked after the mint). */
  replaces: string | null;
  /**
   * F94: the named agents the person consented for, as a key. A consent covers
   * exactly the agents it was given for, so checking another one clears it.
   */
  byoConsentFor?: string | null;
}

/** The last Grant that went through, for the confirmation the drawer shows. */
export interface GrantNotice {
  grantId: string;
  installableId: string;
  tool: string;
  pod: string;
  agents: string;
  /** Change access: a new grant that replaced an old one. */
  changed: boolean;
}

export interface ConnectableRepository {
  installationId: string;
  owner: string;
  repo: string;
  private: boolean;
}

/** F221: the step that connects one of the person's own repositories. */
export interface RepositoryConnect {
  status: 'loading' | 'ready' | 'needsGithub' | 'failed';
  repositories: ConnectableRepository[];
  /** GitHub's listing was cut short, so a missing repository may still exist. */
  truncated: boolean;
  /** `owner/repo` of the picked row. */
  selected: string;
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
// F213 stopgap, for connections other than hosted MCP: this form offers them
// read, because a named agent's grant must be read, any other outside agent in
// the pod refuses the mint, and `write` refuses on every pod. F214 added
// pull-request access beside this, on a GitHub App connection. F215 lets a
// hosted connection offer ask-first, since a hosted run parks those writes for
// the owner; turning this on brings the other modes back, `write` included.
export const FORM_OFFERS_WRITES: boolean = false;

/**
 * Offered on a GitHub App connection whose tools include opening the pull
 * request, the one the mint requires (prWriteMintRefusal).
 */
export const entryOffersPrWrite = (entry: ToolCatalogEntry): boolean => (
  entry.connectionType === 'github-app'
  && entry.tools.some((tool) => tool.prWrite && tool.name === 'github.create_pull_request')
);

/** Under a minute old: `shortAge` reads "just now", which zh can't put before 前. */
export const isJustNow = (date: string | null | undefined, now: number): boolean => (
  relativeParts(date, { includeFuture: false, now }).kind !== 'rel'
);

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
/**
 * The agent an operator-key connection belongs to, or null for any other
 * connection. The grant route refuses a grant on a key connection unless its
 * audience is exactly this agent (operatorKeyAudienceRefusal in
 * backend/services/hostedMcpOperatorKey.ts), so the draft starts there and
 * offers no one else.
 */
export const boundAgentOf = (entry: ToolCatalogEntry, connectionId: string): string | null => {
  if (entry.credentialMode !== 'operator_key') return null;
  return entry.connections.find((connection) => connection.connectionId === connectionId)?.agentId || null;
};

// A grant that names no tool of this entry grants nothing on it — that is what
// the enforcement path does (roomGrantService refuses any tool the grant does
// not list), so the page must not read such an entry as granted.
export const entryIsGranted = (entry: ToolCatalogEntry, grants: ToolGrant[], now: number): boolean => (
  grants.some((grant) => !isDead(grant, now) && entryCovers(entry, grant))
);

/**
 * The one thing a hosted entry's panel says about writing, for what is on
 * screen. A hosted grant is read or ask-first: the mint refuses `write`, so a
 * hosted write always parks for the connection's owner. An offer has no grant
 * to describe, so it says what a grant can be. `liveGrants` is the viewer's own
 * connections' grants on this entry only, so the copy speaks for this connection:
 * another GitHub, or another member's grant, is out of its sight.
 */
export type AccessStatement = 'offerRead' | 'offerAsk' | 'grantedRead' | 'grantedAsk' | 'grantedMixed';

export const accessStatement = (modes: GrantWriteMode[], liveGrants: ToolGrant[]): AccessStatement => {
  if (liveGrants.length === 0) return modes.some((mode) => mode !== 'read') ? 'offerAsk' : 'offerRead';
  const writing = liveGrants.filter((grant) => grant.writeMode !== 'read').length;
  if (writing === 0) return 'grantedRead';
  return writing === liveGrants.length ? 'grantedAsk' : 'grantedMixed';
};

/** How many of these tool names are writes. A name the entry does not list counts as none. */
export const writeToolCount = (entry: ToolCatalogEntry, tools: string[]): number => (entry.tools || [])
  .filter((tool) => tool.requiredWriteMode !== 'read' && tools.includes(tool.name)).length;

export const PER_ENTRY_REVOKE_COPY = new Set(['supabase', 'linear', 'sentry']);
