// Channel connectors: the shapes the integrations and catalog routes return, and
// the pure helpers the channel hook and panels share. Moved whole from the
// retired channels page (TASK-733); nothing here renders.
import { V2Pod, V2PodMember } from '../hooks/useV2Pods';
import { MarkName } from '../icons/glyphs';

export interface ConnectorGate {
  enabled?: boolean;
  mode?: 'attention' | 'mirror';
  lead?: string;
  since?: string;
}

export interface ConnectorConfig {
  entryId?: string;
  revokePage?: string;
  chatTitle?: string;
  // A linked Slack stores its workspace name here (slackOAuthService), never in
  // chatTitle — so without this the row read "Slack · linked to …" beside the
  // word Slack (TASK-156).
  teamName?: string;
  connectCode?: string;
  connectCodeExpiresAt?: string;
  liveRelay?: boolean;
  relayAllAgentMessages?: boolean;
  leadAgentUsername?: string;
  gates?: Record<string, ConnectorGate>;
  // Projected by the server as { reason, at } only — the admin is never named.
  adminPause?: { reason?: string; at?: string };
  pendingBind?: {
    teamName?: string;
    slackUserName?: string;
    expiresAt?: string;
  };
}

export interface Connector {
  _id: string;
  installationId?: string;
  type: string;
  status: string;
  // A reason this connector needs attention. Two writers share the field: our
  // own classifier, and externalFeedService, which copies a provider's error
  // text or a raw `err.message` in here. `errorMessageUserFacing` is what tells
  // them apart, and only a message written for a person is rendered — the field
  // holding a value is not permission to show it.
  errorMessage?: string | null;
  errorMessageUserFacing?: boolean;
  scope?: 'user' | 'pod';
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
  config?: ConnectorConfig;
  podId?: { _id: string; name?: string } | string | null;
}

export interface CatalogInstallation {
  status: string;
  // The same pair the pod-scoped half reads, and the same rule: the field
  // holding a value is not permission to show it. A catalog failure is
  // `markProjectionFailure`'s raw exception message unless a writer says
  // otherwise, so the flag decides and the generic sentence is the fallback
  // (TASK-131).
  errorMessage?: string;
  errorMessageUserFacing?: boolean;
  boundPodId?: string;
  claimedAt?: string;
  updatedAt?: string;
  components?: { name?: string; status?: string; errorMessage?: string }[];
}

export interface CatalogEntry {
  installableId: string;
  // Two lists (tools plan, option A): this page draws channels; the
  // Tools page draws tool Installables, so a `tools` row never renders here.
  list?: 'channels' | 'tools';
  connectionType?: 'github-app' | 'hosted-mcp';
  label?: string;
  description?: string;
  available: boolean;
  // Capability vs offerability. `available` says this
  // instance holds the credentials; `offered` says a builtin Installable row
  // exists to install. Only both together may show an Add. Absent is read as
  // offered: the field's only producer always emits it, so a missing value
  // means a server older than this page, and defaulting the other way would
  // blank every channel for the length of a rolling update instead of briefly
  // restoring what this page did before the field existed.
  offered?: boolean;
  unavailableReason?: string;
  // Tool entries provide the provider name for the hosted connection row.
  entryId?: string;
  installation: CatalogInstallation | null;
  integration: Connector | null;
}

export interface CatalogResponse {
  installables?: CatalogEntry[];
}

export interface InstallResponse {
  status?: 'active' | 'installing' | 'activating' | 'uninstalling';
  boundPodId?: string;
}

export interface InstallErrorResponse {
  code?: string;
  error?: string;
  boundPodId?: string;
}

export interface SlackAuthorizeResponse {
  authorizeUrl?: string;
}

export type ConnectorAction =
  | 'manage' | 'show-code' | 'new-code' | 'authorize' | 'confirm'
  | 'connect' | 'cancel' | 'retry' | 'retry-remove' | 'pick-pod';

export interface ConnectorRow {
  action: ConnectorAction | null;
  actionLabel?: string;
  detail: string;
  dot: 'live' | 'idle' | 'pending' | 'empty' | 'not-yet';
  line: string;
  // Direction A: relay mode is a category, so it is a mark on the row. `label`
  // is the sentence (title + aria-label); `word` is what the 390 kicker shows,
  // where tooltips do not exist.
  mark?: { name: MarkName; label: string; word: string };
  muted?: boolean;
  notEnabled?: boolean;
  // TASK-024: a row whose provider is built but not offered here. It shares
  // `notEnabled`'s row class and Ask link, and must not share its kicker —
  // "not enabled" claims a missing credential this state does not have.
  notConnectable?: boolean;
  pulse: boolean;
  secondary?: boolean;
  when: string;
}

// One list, two sources: the catalog keys a row per provider the instance
// knows about; legacy pod-scoped rows (no installation) render as before.
export type ListItem =
  | { kind: 'catalog'; key: string; entry: CatalogEntry; connector: Connector | null }
  | { kind: 'legacy'; key: string; connector: Connector };

export const TYPE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  groupme: 'GroupMe',
  x: 'X',
  instagram: 'Instagram',
  // Human-readable fallback only. These tool connections are still excluded
  // from Channels by type in allItems below.
  'github-app': 'GitHub App',
  'hosted-mcp': 'Hosted tool',
};

export const TOOL_ONLY_CONNECTION_TYPES = new Set(['github-app', 'hosted-mcp']);

export const mappedTypeLabel = (type: string): string | null => TYPE_LABELS[type] || null;

// The onboarding sentence for a provider you can connect right now. Keyed by
// provider and deliberately without a default: an unmapped provider renders no
// detail line at all. The two-branch ternary this replaces gave every provider
// that was not telegram Slack's "one click in your workspace", so a stranger
// reading a Discord row was told to click something in a workspace they may not
// have.
export const CONNECT_DETAIL: Record<string, { key: string; defaultValue: string }> = {
  telegram: { key: 'connectors.availableTelegram', defaultValue: 'one message' },
  slack: { key: 'connectors.availableSlack', defaultValue: 'one click in your workspace' },
};

// Fallback only: when the catalog cannot be read the page still offers the
// two providers it can drive, exactly as it did before the catalog existed.
export const ADD_PLATFORMS = [
  { type: 'telegram', enabled: true },
  { type: 'slack', enabled: true },
];
// Providers we have not built at all. This is NOT the same claim as either
// state the catalog can report: "not enabled on this instance" is a missing
// credential, and "not connectable yet" is a provider we have built and this
// instance cannot offer because no builtin Installable row carries it. Both of
// those arrive through the catalog, with their own state line, so this list
// holds only the providers that have no manifest to arrive through. Discord
// used to sit here, which made the page say "we don't build this" about a
// shipping connector (routes/discord.ts) whose only defect was a missing
// readiness() declaration; it now renders the roster state line instead.
export const UNAVAILABLE_PLATFORM_LABELS = ['WhatsApp'];

export const BOT_HANDLE = process.env.REACT_APP_TELEGRAM_BOT_HANDLE || '';
export const RECENT_MS = 10 * 60_000;
// Mirrors INSTALL_LOCK_TTL_MS on the server: Cancel appears exactly when the
// lifecycle verb would honour it (a stale claim), never before.
export const INSTALL_LOCK_TTL_MS = 60_000;
export const TRANSIENT_STATUSES = ['installing', 'activating', 'uninstalling'];

export const installableLifecyclePath = (type: string): string => (
  `/api/installables/${encodeURIComponent(type)}/install`
);

export const installErrorResponse = (error: unknown): { status?: number; data?: InstallErrorResponse } => (
  (error as { response?: { status?: number; data?: InstallErrorResponse } })?.response || {}
);

// Row C: the Slack authorize and bind verbs refuse with a `code` the server
// already sends (`slackError` in backend/routes/installables.ts), so the row
// can say which refusal it was rather than one generic apology. An unlisted
// code falls back to the server's own sentence, then to the generic copy.
export const SLACK_REFUSALS: Record<string, { key: string; defaultValue: string }> = {
  slack_already_authorized: { key: 'connectors.slackAlreadyAuthorized', defaultValue: 'Slack is already awaiting confirmation or connected.' },
  slack_authorization_unavailable: { key: 'connectors.slackAuthorizationUnavailable', defaultValue: 'Slack authorization is no longer available.' },
  slack_installation_not_found: { key: 'connectors.slackInstallationNotFound', defaultValue: 'Slack installation not found.' },
  slack_bind_missing: { key: 'connectors.slackBindMissing', defaultValue: 'There is no Slack authorization to confirm.' },
  slack_bind_expired: { key: 'connectors.slackBindExpired', defaultValue: 'Slack authorization expired. Start again.' },
  slack_lead_invalid: { key: 'connectors.slackLeadInvalid', defaultValue: 'Choose an agent in the active pod.' },
  slack_pod_access_denied: { key: 'connectors.slackPodAccessDenied', defaultValue: 'You no longer have access to this pod.' },
};

export const connectorPodId = (connector: Connector | null | undefined): string | null => {
  if (!connector || !connector.podId) return null;
  return typeof connector.podId === 'object' ? String(connector.podId._id || '') || null : String(connector.podId);
};

export const groupCode = (code: string): string => (code.match(/.{1,4}/g) || [code]).join(' ');

// Mirrors `PERSONAL_POD_TYPES` in `backend/services/podTypePolicyService.ts` —
// private conversation surfaces, not rooms a channel should join by default.
// `/api/pods` returns the caller's own 1:1 room first, so TASK-155 shipped with
// the picker defaulting to "Scout (Default)", an agent-room. The pods stay in
// the list (a DM is a legal target) — they just never become the default.
export const PERSONAL_POD_TYPES = new Set(['agent-admin', 'agent-room', 'agent-dm']);

export const defaultPodForChannel = (pods: V2Pod[]): string => (
  (pods.find((pod) => !PERSONAL_POD_TYPES.has(String(pod.type))) || pods[0])?._id || ''
);

export const codeIsLive = (connector: Connector): boolean => Boolean(
  connector.config?.connectCode
  && connector.config?.connectCodeExpiresAt
  && new Date(connector.config.connectCodeExpiresAt).getTime() > Date.now(),
);

export const codeExpiresInMinutes = (connector: Connector): number => {
  const expiry = connector.config?.connectCodeExpiresAt
    ? new Date(connector.config.connectCodeExpiresAt).getTime()
    : NaN;
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(1, Math.ceil((expiry - Date.now()) / 60_000));
};

// One connector's age as English prose uses this profile; the gate line below
// needed the same parts (TASK-164).
export const connectorRelativeTimeOptions = { includeFuture: false, missing: 'just now', rounding: 'floor' } as const;

export const claimIsStale = (installation: CatalogInstallation): boolean => {
  const claimedAt = installation.claimedAt ? new Date(installation.claimedAt).getTime() : NaN;
  if (!Number.isFinite(claimedAt)) return true;
  return Date.now() - claimedAt >= INSTALL_LOCK_TTL_MS;
};

export const projectionMissing = (entry: CatalogEntry): boolean => (
  !entry.integration
  || entry.integration.isActive === false
  || (entry.installation?.components || []).some((component) => component.status === 'stale')
);

export const botMembers = (pod: V2Pod | undefined): V2PodMember[] => (
  (pod?.members || []).filter((member): member is V2PodMember => (
    typeof member === 'object' && member !== null && Boolean(member.isBot) && Boolean(member.username)
  ))
);
