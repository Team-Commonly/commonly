import { escapeRegExp } from '../../utils/escape';
// Shared helper utilities — extracted from registry.js (GH#112)
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { RUNTIME_IDENTITY_KEYS, declaredRuntimeIdentity } = require('../../utils/runtimeIdentity');
const AgentIdentityService = require('../../services/agentIdentityService').default;
const { resolveAgentDisplayLabel } = require('../../services/agentIdentityService');
const { PRESET_DEFINITIONS } = require('./presets');
const { hostedEngineInEffect } = require('../../services/hostedEngine');
const { PLACEHOLDER_AGENT_DESCRIPTION } = require('../../services/agentInstallationIdentity');
const { listeningInvite } = require('../../services/installIntroCopy');
const { isPersonalPodType } = require('../../services/podTypePolicyService');

// Build an in-memory map of presetId → category once at module load.
// Powers the `category` field on the agent payload — the V2 inspector
// renders this as a small role chip in the member list, and the Your Team
// page uses it to filter agents by function (Development / Design /
// Strategy / etc.). PRESET_DEFINITIONS is the only authoritative source;
// individual installations carry just `presetId`, not the category.
const PRESET_CATEGORY_BY_ID: Record<string, string> = (PRESET_DEFINITIONS as any[])
  .reduce((acc: Record<string, string>, p: any) => {
    if (p?.id && p?.category) acc[String(p.id)] = String(p.category);
    return acc;
  }, {});

const parseVerifiedFilter = (value: any) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

const getUserId = (req: any) => req.userId || req.user?.id || req.user?._id;

// Both browser JWT and API-token auth supply req.user.username. Preserve the
// agentUser shape for registry callers that pass one explicitly.
const resolveUsername = (req: any): string | null => (
  req.user?.username || req.agentUser?.username || null
);

// `config.hosted` may still be a Mongoose Map when read off a document.
const readHostedAbout = (hosted: any): string => {
  const value = hosted instanceof Map ? hosted.get('about') : hosted?.about;
  return typeof value === 'string' ? value : '';
};

const normalizeConfigMap = (config: any) => {
  if (!config) return null;
  if (config instanceof Map) {
    return Object.fromEntries(config.entries());
  }
  if (typeof config === 'object') {
    return config;
  }
  return null;
};

const normalizeRuntimeAuthProfiles = (profiles: any) => {
  if (!profiles || typeof profiles !== 'object') return null;
  const normalized = {};
  Object.entries(profiles).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const v = value as any;
    const provider = String(v.provider || '').trim().toLowerCase();
    const rawKey = String(v.key || '').trim();
    if (!provider || !rawKey) return;
    const type = String(v.type || 'api_key').trim().toLowerCase();
    if (type !== 'api_key') return;
    const profileId = String(key || `${provider}:default`).trim();
    (normalized as any)[profileId || `${provider}:default`] = {
      type: 'api_key',
      provider,
      key: rawKey,
    };
  });
  return Object.keys(normalized).length ? normalized : null;
};

const normalizeSkillEnvEntries = (entries: any) => {
  if (!entries || typeof entries !== 'object') return null;
  const normalized = {};
  Object.entries(entries).forEach(([skillName, value]) => {
    const name = String(skillName || '').trim();
    if (!name || !value || typeof value !== 'object') return;
    const va = value as any;
    const env = va.env && typeof va.env === 'object' ? va.env : {};
    const envEntries = Object.entries(env)
      .map(([key, val]) => [String(key || '').trim(), String((val as any) ?? '').trim()])
      .filter(([key, val]) => key && val);
    const apiKey = String(va.apiKey ?? '').trim();
    if (!envEntries.length && !apiKey) return;
    (normalized as any)[name] = {
      ...(envEntries.length ? { env: Object.fromEntries(envEntries) } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  });
  return Object.keys(normalized).length ? normalized : null;
};

// Resolve `runtimeType` + `host` for the API/UI from whatever the install
// row carries. Three input shapes are normalized:
//   1. New shape (post-2026-05-04): `{ runtimeType: '<identity>', host: 'cloud' | 'byo' }`
//      — passed through. CLI attach writes this.
//   2. Legacy CLI shape: `{ runtimeType: 'local-cli', wrappedCli: '<cli>' }`
//      — rewritten to `{ runtimeType: <wrappedCli>, host: 'byo' }`. No data
//      migration; this resolver fixes it on read.
//   3. Empty/null `config.runtime` (most pre-CLI installs of built-in
//      agents) — `runtimeType` is filled from `AGENT_TYPES[agentName]`,
//      `host` defaults to `'cloud'` (the only host that exists for
//      first-party / cloud-deployed built-ins today).
//
// Identity-rename map — collapses CLI adapter names + provider-leaning
// legacy values onto the canonical runtimeType set used by AGENT_TYPES
// and the V2 inspector badge resolver. Examples:
//   - `claude` (CLI adapter `name`, written by pre-2026-05-04 attach)
//      → `claude-code` (AGENT_TYPES + frontend badge match)
//   - `openai` (older AGENT_TYPES `runtime`)
//      → `codex` (matches the CLI adapter and the frontend badge)
// Adding a new adapter that uses a different CLI name than its canonical
// runtimeType? Add a row here to keep the read path consistent for
// installs that landed before the adapter exposed `runtimeType`.
const LEGACY_RUNTIME_RENAME: Record<string, string> = {
  openai: 'codex',
  claude: 'claude-code',
};

// Runtime secrets follow the same explicit key-list rule as Integration
// config. Keep the response projection here so a member of a pod can inspect
// runtime metadata without receiving the webhook signing secret.
const AGENT_RUNTIME_SECRET_CONFIG_KEYS = ['webhookSecret'];

const normalizeRuntimeIdentity = (rest: any, agentName?: string) => {
  let runtimeType: string | undefined = rest.runtimeType ? String(rest.runtimeType) : undefined;
  let host: 'cloud' | 'byo' | undefined = rest.host === 'byo' || rest.host === 'cloud' ? rest.host : undefined;

  // Legacy CLI shape — `local-cli` + `wrappedCli` predates the two-field
  // model. Treat `wrappedCli` as the identity and stamp host=byo.
  // The wrappedCli value is the CLI adapter `name` (`claude`, `codex`),
  // which the rename map below collapses onto the canonical runtimeType
  // (`claude-code`, `codex`) so the frontend badge resolver matches.
  if (runtimeType === 'local-cli') {
    const cli = String(rest.wrappedCli || '').trim();
    if (cli) runtimeType = cli;
    if (!host) host = 'byo';
  }

  // No runtime info at all → fall back to AGENT_TYPES. Built-ins are
  // assumed cloud/first-party. CLI agents always set both fields, so
  // they never hit this branch.
  if (!runtimeType && agentName) {
    const typeConfig = AgentIdentityService.getAgentTypeConfig(agentName);
    if (typeConfig?.runtime) runtimeType = typeConfig.runtime;
    if (!host) host = 'cloud';
  }

  // Apply the identity rename (claude → claude-code, openai → codex).
  if (runtimeType && LEGACY_RUNTIME_RENAME[runtimeType]) {
    runtimeType = LEGACY_RUNTIME_RENAME[runtimeType];
  }

  return { runtimeType, host };
};

const sanitizeRuntimeConfig = (runtimeConfig: any, agentName?: string) => {
  const cfg = runtimeConfig && typeof runtimeConfig === 'object' ? runtimeConfig : {};
  const { authProfiles, skillEnv, ...rest } = cfg;
  AGENT_RUNTIME_SECRET_CONFIG_KEYS.forEach((key) => { delete rest[key]; });
  const providers = authProfiles && typeof authProfiles === 'object'
    ? Array.from(new Set(
      Object.values(authProfiles)
        .map((profile: any) => String(profile?.provider || '').trim().toLowerCase())
        .filter(Boolean),
    ))
    : [];
  const skillKeys = skillEnv && typeof skillEnv === 'object'
    ? Object.keys(skillEnv).map((key) => String(key || '').trim()).filter(Boolean)
    : [];
  // `rest` must still carry `wrappedCli` so normalizeRuntimeIdentity can
  // read it for the legacy `local-cli` rewrite. The pre-fix version
  // destructured wrappedCli out before this call → legacy installs (local
  // wrapper seats) stayed as runtimeType:'local-cli' on the wire and
  // the inspector showed "Local CLI · BYO" instead of "Codex · BYO".
  const { runtimeType, host } = normalizeRuntimeIdentity(rest, agentName);
  // Strip `wrappedCli` from the response only AFTER normalization so
  // downstream consumers see the canonical two-field shape. The frontend
  // resolver retains a defensive `wrappedCli` branch as belt-and-
  // suspenders against future regressions, but the field shouldn't be
  // present on the wire by design.
  const { wrappedCli: _legacyWrappedCli, ...passthrough } = rest;
  return {
    ...passthrough,
    ...(runtimeType ? { runtimeType } : {}),
    ...(host ? { host } : {}),
    authProviders: providers,
    hasCustomAuthProfiles: providers.length > 0,
    hasCustomSkillEnv: skillKeys.length > 0,
    skillEnvKeys: skillKeys,
  };
};

/**
 * The install intro, composed so its promise matches reality.
 *
 * The old copy said "Mention me with @handle when you need me" every time,
 * posted server-side the moment a seat is created — which for a BYO seat is
 * before any wrapper exists to answer. Production message history shows four
 * users taking that invitation and getting total silence: m0re (08-04),
 * l3r0ys4n3 (08-07), user-8863 (08-09, who asked three times in two phrasings
 * whether the connection was working), ngoc-tran (08-10). None came back.
 *
 * Pure on purpose: the caller derives liveness via `deriveAgentState` (the
 * same derivation the #891 honesty surface and the pod roster use — one
 * source of truth, not a second guess) and passes the verdict in. That keeps
 * the copy rules testable without a DB, which is the whole reason
 * agentStateService is pure too.
 *
 * F651: when nothing runs the agent (`never-connected`, `gone-dark`) there is
 * no intro at all. Those arms used to post, in the agent's own voice, "As I
 * post this, nothing is running me yet" plus a copy-paste start command. On
 * prod 11-26 that note sat at the top of a new pod before Codex had run,
 * handed every member a command only the installer can use, and read wrong a
 * minute later. The installer already gets that command where only they see
 * it (the pod roster's `fixCommand`, sent to the installer only and shown in
 * the agent inspector, the composer's mention warning and Your Team), and the
 * stalled-connect nudge follows up if they never run it. The room hears from
 * the agent when the agent is there.
 *
 * The intro's purpose, per the call site, is that "the room learns the new
 * member without having to wait for their first heartbeat", so an agent that
 * is (or may be) running gets one short hello in the listening form, and the
 * caller marks it so the shell adds no "is connected now" line under it.
 * The listening words live in services/installIntroCopy.ts, shared with the
 * first-listen rewrite (F576), which still settles intros posted before F651.
 *
 * This plan says which intro, if any, an install posts: 'invite' is the
 * listening hello, 'no-listener' is the stable declaration of an identity that
 * only calls the API, and 'none' posts nothing. The caller reads it to mark
 * the payload, and `composeInstallIntro` to pick the words, so the two cannot
 * disagree.
 */
const installIntroPlan = ({ state, listens = true }: { state: string; listens?: boolean }): 'invite' | 'no-listener' | 'none' => {
  // A measured check-in (listening, or a push webhook that answered)
  // contradicts a declaration of no listener and wins.
  if (state === 'listening' || state === 'reachable') return 'invite';
  // Declared with no listener: a stable fact about the identity, not a state,
  // so it is true whenever it is read and names no command.
  if (listens === false) return 'no-listener';
  // Nothing runs it: no note in its voice (F651). The installer's surfaces
  // carry the command.
  if (state === 'never-connected' || state === 'gone-dark') return 'none';
  // unknown — anything we cannot show to be down keeps the invitation.
  // Wrongly telling a live agent's room that nothing listens is the opposite
  // lie.
  return 'invite';
};

const composeInstallIntro = ({
  displayName, blurb, handle, state, listens = true,
}: {
  displayName: string;
  blurb?: string;
  handle: string;
  // The `deriveAgentState` enum, passed WHOLE rather than flattened to a
  // boolean, so `unknown` (keep the invitation) stays apart from the two
  // states that post nothing.
  state: string;
  // False when the install declared `config.runtime.listens: false`: it calls
  // Commonly over its API or MCP and runs no listener, so no command makes a
  // mention reach it.
  listens?: boolean;
}): string | null => {
  const plan = installIntroPlan({ state, listens });
  if (plan === 'none') return null;
  // Older CLI versions seeded description from displayName, producing intros
  // like "Hi all — I'm bot. bot Ping me ...". Drop a blurb that just repeats
  // the name.
  const trimmed = String(blurb || '').trim().replace(/\s+/g, ' ');
  const meaningless = !trimmed
    || trimmed === PLACEHOLDER_AGENT_DESCRIPTION
    || trimmed.toLowerCase() === String(displayName).toLowerCase();
  const lead = meaningless
    ? `Hi all — I'm ${displayName}, just joined the pod.`
    : `Hi all — I'm ${displayName}. ${trimmed}`;

  if (plan === 'no-listener') {
    return `${lead} I call Commonly over its API and run no listener, so mentioning me won't wake me. `
      + 'I see what was said here the next time I work in this pod.';
  }
  return `${lead} ${listeningInvite(handle)}`;
};

// Internal ops/smoke/demo seats (spec §1.1, BEND-3 follow-up #1377):
// the roster hides these behind a disclosure. The classification lives HERE,
// at the boundary, so every consumer reads one `internal: true` flag instead
// of curating its own name list — the client-side constant this replaces was
// accepted for exactly one release. An explicit `config.internal: true` on
// the installation wins; the name patterns cover the seats scripts already
// create without the flag.
// A seat is one runtime, but attach writes its runtime identity only onto the
// install where it ran, so the seat's installs in other pods keep an older
// identity or none (TASK-569: Sprint Review read claude-code in one pod and
// nothing in Core runtime). Every pod therefore reads the seat's identity from
// its most recently written install that declares one. Most recent, never the
// first match, so a harness swap made in one pod shows in all of them.
// The four keys move as a group: an older install's adapter must not outlive
// a newer install's runtimeType, which would bring back the stale chip.
// When that newest install names no adapter, its poller's report (reportedCli,
// display only) rides along. Without it the overlay drops a pod's own adapter
// and the chip falls back to the bare runtimeType: a seat declared claude-code
// that runs opencode read "claude" in exactly the pods that named its adapter.
const runtimeIdentityKey = (agentName: any, instanceId: any) => `${agentName}:${instanceId || 'default'}`;

const resolveSeatRuntimeIdentities = async (installations: any[]): Promise<Map<string, Record<string, unknown>>> => {
  const resolved = new Map<string, Record<string, unknown>>();
  const seats = new Map<string, { agentName: any; instanceId: string }>();
  for (const i of installations || []) {
    if (!i?.agentName) continue;
    seats.set(runtimeIdentityKey(i.agentName, i.instanceId), {
      agentName: i.agentName, instanceId: i.instanceId || 'default',
    });
  }
  if (seats.size === 0) return resolved;
  const rows = await AgentInstallation.find({
    status: 'active',
    $or: Array.from(seats.values()),
  })
    // Newest attach wins (TASK-569). Not updatedAt: the skill-load report and
    // every settings save move it, which revived a stale harness in other pods.
    // Rows from before runtimeIdentityAt sort after it, by their creation.
    .select('agentName instanceId config.runtime runtimeIdentityAt createdAt')
    .sort({ runtimeIdentityAt: -1, createdAt: -1, _id: -1 })
    .lean();
  for (const row of rows as any[]) {
    const key = runtimeIdentityKey(row.agentName, row.instanceId);
    if (resolved.has(key)) continue;
    const identity = declaredRuntimeIdentity(row.config);
    if (!identity) continue;
    const reportedCli = row.config?.runtime?.reportedCli;
    if (reportedCli && !identity.adapter && !identity.wrappedCli) identity.reportedCli = reportedCli;
    resolved.set(key, identity);
  }
  return resolved;
};

const withSeatRuntimeIdentity = (runtime: any, identity: Record<string, unknown> | null | undefined) => {
  if (!identity) return runtime;
  const base = runtime && typeof runtime === 'object' ? { ...runtime } : {};
  RUNTIME_IDENTITY_KEYS.forEach((key: string) => { delete base[key]; });
  return { ...base, ...identity };
};

const INTERNAL_SEAT_EXACT = new Set(['hosted-smoke', 'run-here-smoke', 'commonly-summarizer']);
const INTERNAL_SEAT_PREFIXES = ['smoke-', 'recorder-', 'adr-', 'demo-'];
const isInternalSeat = (agentName: any, normalizedConfig: any): boolean => {
  if (normalizedConfig?.internal === true) return true;
  const n = String(agentName || '').toLowerCase();
  return INTERNAL_SEAT_EXACT.has(n) || INTERNAL_SEAT_PREFIXES.some((p) => n.startsWith(p));
};

// The card shows one line of it; shipping the median 2,700-char agent message
// per roster row is payload waste, so trim at the boundary.
const SNIPPET_MAX = 200;
const toSnippet = (content: any): string => {
  const collapsed = String(content || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > SNIPPET_MAX ? `${collapsed.slice(0, SNIPPET_MAX - 1)}…` : collapsed;
};

const buildAgentInstallationPayload = (installation: any, {
  profile = null,
  iconUrl = '',
  lastHeartbeatAt = null,
  lastActiveAt = null,
  user = null,
  lastMessage = null,
  revealWebhookUrl = false,
  runtimeIdentity = null,
}: {
  profile?: any; iconUrl?: string; lastHeartbeatAt?: any; lastActiveAt?: any; user?: any;
  lastMessage?: { content?: any; createdAt?: any } | null;
  /**
   * Only the installer and instance admins see a push webhook's URL. Every
   * pod member reads this payload, and a URL can carry a credential in its
   * query string (`?secret=`), so it is withheld unless the caller opts in.
   */
  revealWebhookUrl?: boolean;
  /** The seat's identity from resolveSeatRuntimeIdentities, over this install's own. */
  runtimeIdentity?: Record<string, unknown> | null;
} = {}) => {
  if (!installation) return null;
  const normalizedConfig = normalizeConfigMap(installation.config);
  const sanitizedRuntime = sanitizeRuntimeConfig(
    withSeatRuntimeIdentity(normalizedConfig?.runtime || installation.config?.runtime || null, runtimeIdentity),
    installation.agentName,
  );
  const runtimeConfig = (() => {
    if (revealWebhookUrl || !sanitizedRuntime || !('webhookUrl' in sanitizedRuntime)) return sanitizedRuntime;
    const { webhookUrl: _withheld, ...rest } = sanitizedRuntime as Record<string, unknown>;
    return rest;
  })();
  // Settings may edit these model controls, and the daemon prefers an explicit
  // ADR-008 environment over the runtime overlay. Expose only these benign
  // scalar fields; never project environment secrets or tool declarations.
  const environmentSettings = normalizedConfig?.environment;
  const editableEnvironment = environmentSettings && typeof environmentSettings === 'object'
    ? Object.fromEntries(['model', 'effort', 'adapter']
      .filter((key) => typeof environmentSettings[key] === 'string')
      .map((key) => [key, environmentSettings[key]]))
    : {};
  if (typeof environmentSettings?.sandbox?.mode === 'string') {
    editableEnvironment.sandbox = { mode: environmentSettings.sandbox.mode };
  }
  // Chat attributes this seat through the User principal. Use that same
  // resolver for the listing; scoped names are only a fallback for installs
  // that have no User row yet. A scoped name equal to the agentName is the
  // runtime or type label, not a name, so the listing never carries it (TASK-551).
  const profileDisplayName = typeof profile?.name === 'string' ? profile.name.trim() : '';
  const installationDisplayName = typeof installation.displayName === 'string'
    ? installation.displayName.trim()
    : '';
  const identityFallback = installation.agentName || '';
  const scopedDisplayName = [profileDisplayName, installationDisplayName]
    .find((name) => name && name !== identityFallback) || '';
  const displayName = user
    ? resolveAgentDisplayLabel(user, identityFallback)
    : scopedDisplayName;
  return {
    name: installation.agentName,
    instanceId: installation.instanceId || 'default',
    displayName,
    iconUrl,
    version: installation.version,
    status: installation.status,
    scopes: installation.scopes,
    installedAt: installation.createdAt,
    lastHeartbeatAt,
    // Latest proof of life across every runtime class: delivered heartbeat
    // events (gateway moltbots), runtime-token use (BYO wrappers/MCP), and
    // AgentRun starts (native). `lastHeartbeatAt` alone reads as "Never
    // connected" for native agents that talked minutes ago (#915).
    lastActiveAt: lastActiveAt || lastHeartbeatAt,
    usage: installation.usage,
    internal: isInternalSeat(installation.agentName, normalizedConfig),
    // Spec §1.1 line 2: what the agent last said, pre-trimmed. Null when
    // it has never spoken in this pod (or the PG lookup was skipped/failed —
    // the roster never fails over a snippet).
    lastMessage: lastMessage && toSnippet(lastMessage.content)
      ? { snippet: toSnippet(lastMessage.content), at: lastMessage.createdAt || null }
      : null,
    installedBy: installation.installedBy?.toString?.() || installation.installedBy,
    // The portable principal's id, so a client can key per-agent attention
    // (AttentionItem.actorUserId) on it instead of matching names — three
    // writers store three different name shapes.
    userId: user?._id ? String(user._id) : null,
    // Chat reads this image from the same User principal. Installation and
    // registry artwork must not stand in for an agent's account avatar.
    profilePicture: user?.profilePicture || null,
    // Direction C Your Team card, line 3: one sentence from the curated
    // `botMetadata.description`. Null when unset — the card renders no line,
    // never a quote.
    description: typeof user?.botMetadata?.description === 'string' && user.botMetadata.description.trim()
      ? user.botMetadata.description.trim()
      : null,
    runtime: runtimeConfig,
    // TASK-780: a hosted agent's editable description (config.hosted.about);
    // absent for every other runtime, which has no such field to edit.
    ...(String(normalizedConfig?.runtime?.runtimeType || '').trim().toLowerCase() === 'hosted'
      && hostedEngineInEffect(installation) === 'native' ? {
      about: readHostedAbout(normalizedConfig?.hosted),
    } : {}),
    // Resolved at the boundary so the frontend doesn't need to know
    // about presets — `category` is the human-readable role family
    // (Development, Design, Strategy, …) used by the V2 inspector role
    // chip and the Your Team filter tabs. Falls back to an explicit
    // `config.role` override (rare; user-configured) before defaulting
    // to `null` for installs without a known preset.
    category: (normalizedConfig?.role && String(normalizedConfig.role))
      || PRESET_CATEGORY_BY_ID[String(normalizedConfig?.presetId || '')]
      || null,
    config: normalizedConfig ? {
      presetId: normalizedConfig.presetId || null,
      customizations: normalizedConfig.customizations || null,
      heartbeat: normalizedConfig.heartbeat || null,
      wakeOnMessage: normalizedConfig.wakeOnMessage || null,
      boardWake: normalizedConfig.boardWake || null,
      autonomy: normalizedConfig.autonomy || null,
      errorRouting: normalizedConfig.errorRouting || null,
      heartbeatChecklist: normalizedConfig.heartbeatChecklist || '',
      skillSync: normalizedConfig.skillSync || null,
      environment: editableEnvironment,
    } : null,
    profile: profile
      ? {
        displayName: profile.name,
        purpose: profile.purpose,
        isDefault: profile.isDefault,
        modelPreferences: profile.modelPreferences,
        instructions: profile.instructions,
        persona: profile.persona,
        toolPolicy: profile.toolPolicy,
        contextPolicy: profile.contextPolicy,
      }
      : null,
  };
};

const normalizeInstanceId = (raw: any) => {
  let normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  if (normalized.startsWith('-')) normalized = normalized.slice(1);
  if (normalized.endsWith('-')) normalized = normalized.slice(0, -1);
  return normalized || 'default';
};

const normalizeDisplayName = (value: any) => String(value || '').trim().toLowerCase();

const isGlobalAdminUser = async (userId: any) => {
  const user = await User.findById(userId).select('role').lean();
  return Boolean(user && user.role === 'admin');
};

const userHasPodAccess = (pod: any, userId: any) => {
  if (!pod || !userId) return false;
  const userIdStr = userId.toString();
  if (pod.createdBy?.toString() === userIdStr) return true;
  return Boolean(pod.members?.some((m: any) => (m.userId?.toString?.() || m.toString()) === userIdStr));
};

// An agent-room or agent-admin pod is private to its members, admins included,
// the same line getPodById draws (callerMayReadPod): there the admin role
// counts only for an admin who is a member. agent-dm keeps the admin reach
// getPodById gives it. Every route that lets the admin role act on one pod's
// agent asks this, rather than the bare role.
const adminRoleReachesPod = (pod: any, userId: any) => {
  const membersOnly = isPersonalPodType(pod?.type) && pod?.type !== 'agent-dm';
  return !membersOnly || userHasPodAccess(pod, userId);
};

const adminMayActOnPod = async (pod: any, userId: any) => (
  adminRoleReachesPod(pod, userId) && isGlobalAdminUser(userId)
);

// The instance a per-agent route acts on: the query string for a GET, the body
// otherwise. An object or function is refused here so it never reaches a
// Mongo query as an operator.
const getRequestedInstanceId = (req: any): string => {
  const rawInstanceId = req.method === 'GET' ? req.query.instanceId : req.body?.instanceId;
  if (rawInstanceId && (typeof rawInstanceId === 'object' || typeof rawInstanceId === 'function')) {
    const error: any = new Error('Invalid instance ID');
    error.status = 400;
    throw error;
  }
  return String(rawInstanceId || 'default');
};

// One authorization boundary for routes that act on one installed agent: its
// runtime, its workspace files, its persona. Pod access is a precondition, not
// an authority; the caller must have installed this exact instance, or be an
// instance admin by the role stored on their user row. The installation is
// matched on its exact instanceId with no fallback to a sibling instance, and
// an uninstalled row does not count. Errors carry `status` (and `code` for
// the installer refusal, the same `installer_only` the config PATCH answers).
// On an agent-room or agent-admin pod the admin role counts only for a member
// (adminMayActOnPod).
const resolveAuthorizedInstallation = async ({ podId, name, instanceId, userId }: any) => {
  const pod = await Pod.findById(podId).lean();
  if (!pod) {
    const error: any = new Error('Pod not found');
    error.status = 404;
    throw error;
  }
  const isAdmin = await adminMayActOnPod(pod, userId);
  if (!isAdmin && !userHasPodAccess(pod, userId)) {
    const error: any = new Error('Access denied');
    error.status = 403;
    throw error;
  }
  const installation = await AgentInstallation.findOne({
    agentName: String(name).toLowerCase(), podId, instanceId, status: { $ne: 'uninstalled' },
  });
  if (!installation) {
    const error: any = new Error('Agent installation not found');
    error.status = 404;
    throw error;
  }
  if (!isAdmin && installation.installedBy?.toString() !== userId.toString()) {
    const error: any = new Error('Access denied');
    error.status = 403;
    error.code = 'installer_only';
    throw error;
  }
  return installation;
};

const parseJsonFromText = (text: any) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
};

const serializeRuntimeTokens = (tokens: any[] = []) => tokens.map((token: any) => ({
  id: token._id?.toString(),
  label: token.label,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
}));

const parseEnvFlag = (value: any) => {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'no', 'off', 'disabled', 'none'].includes(normalized);
};

const hasAnyEnv = (keys = []) => keys.some((key) => parseEnvFlag(process.env[key]));

const buildAgentProfileId = (agentName: any, instanceId: any) => (
  `${agentName.toLowerCase()}:${normalizeInstanceId(instanceId)}`
);

const resolveRuntimeInstanceId = ({ agentName, requestedInstanceId, installation }: { agentName: any; requestedInstanceId: any; installation: any }) => {
  // Runtime identity must follow the installed instance exactly.
  // Do not derive a different runtime instance from displayName, otherwise
  // shared tokens can drift and runtime pod authorization fails.
  const installedInstanceId = normalizeInstanceId(installation?.instanceId);
  if (installedInstanceId) return installedInstanceId;
  return normalizeInstanceId(requestedInstanceId);
};

const resolveInstallation = async ({ agentName, podId, instanceId }: { agentName: any; podId: any; instanceId: any }) => {
  const normalizedInstanceId = normalizeInstanceId(instanceId);
  let installation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId: normalizedInstanceId,
  });

  if (installation) {
    return { installation, instanceId: normalizedInstanceId };
  }

  // Fallback: if instanceId is default and there is exactly one install, use it.
  if (normalizedInstanceId === 'default') {
    const installs = await AgentInstallation.find({
      agentName: agentName.toLowerCase(),
      podId,
      status: { $ne: 'uninstalled' },
    }).limit(2);
    if (installs.length === 1) {
      return { installation: installs[0], instanceId: installs[0].instanceId || 'default' };
    }
  }

  // Fallback: if a specific instanceId was provided but there is exactly one active install,
  // use it to avoid hard failures when the UI doesn't know the instanceId.
  const activeInstalls = await AgentInstallation.find({
    agentName: agentName.toLowerCase(),
    podId,
    status: { $ne: 'uninstalled' },
  }).limit(2);
  if (activeInstalls.length === 1) {
    return { installation: activeInstalls[0], instanceId: activeInstalls[0].instanceId || 'default' };
  }

  return { installation: null, instanceId: normalizedInstanceId };
};

module.exports = {
  parseVerifiedFilter,
  escapeRegExp,
  getUserId,
  resolveUsername,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  sanitizeRuntimeConfig,
  buildAgentInstallationPayload,
  resolveSeatRuntimeIdentities,
  isInternalSeat,
  toSnippet,
  normalizeInstanceId,
  normalizeDisplayName,
  isGlobalAdminUser,
  adminRoleReachesPod,
  adminMayActOnPod,
  userHasPodAccess,
  getRequestedInstanceId,
  resolveAuthorizedInstallation,
  parseJsonFromText,
  serializeRuntimeTokens,
  parseEnvFlag,
  hasAnyEnv,
  resolveInstallation,
  buildAgentProfileId,
  resolveRuntimeInstanceId,
  composeInstallIntro,
  installIntroPlan,
};

export {};
