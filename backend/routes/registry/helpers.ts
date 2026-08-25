// Shared helper utilities — extracted from registry.js (GH#112)
const User = require('../../models/User');
const Gateway = require('../../models/Gateway');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { isK8sMode } = require('../../services/agentProvisionerService');
const AgentIdentityService = require('../../services/agentIdentityService').default;
const { PRESET_DEFINITIONS } = require('./presets');

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

const buildIdentityContent = (name: any, persona: any) => {
  const toneMap = {
    friendly: 'Warm, approachable, supportive.',
    professional: 'Precise, measured, focused.',
    sarcastic: 'Dry, sardonic, irreverent.',
    educational: 'Patient, explanatory, thorough.',
    humorous: 'Playful, witty, light.',
  };
  const vibe = (toneMap as any)[persona?.tone] || persona?.tone || '';
  const specialties = Array.isArray(persona?.specialties)
    ? persona.specialties.join(', ')
    : String(persona?.specialties || '');
  const lines = [
    '# IDENTITY.md',
    '',
    `- **Name:** ${name || ''}`,
    `- **Vibe:** ${vibe}`,
  ];
  if (specialties) lines.push(`- **Domain:** ${specialties}`);
  if (persona?.customInstructions) {
    lines.push('', '## Notes', '', persona.customInstructions);
  }
  lines.push('');
  return lines.join('\n');
};

const parseVerifiedFilter = (value: any) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

const escapeRegExp = (value: any) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getUserId = (req: any) => req.userId || req.user?.id || req.user?._id;

// `middleware/auth.ts` dispatches on the token and the two branches leave
// DIFFERENT shapes on `req.user`: the `cm_` API-token path assigns
// `{ id, username, email, role }` (`:51`), the browser-JWT path assigns
// `{ id }` (`:81`). Neither errors, so `req.user.username` is simply
// `undefined` for every browser session — and `publisher.name: undefined`
// persists into the registry with nothing going red. Load it when the token
// did not carry it. `routes/marketplace-api.ts` already resolves the same way;
// this is that resolution moved next to `getUserId`, which both registry
// writers already import. See AX audit entry 42.
const resolveUsername = async (req: any): Promise<string | null> => {
  if (req.user?.username) return req.user.username;
  if (req.agentUser?.username) return req.agentUser.username;
  const userId = getUserId(req);
  if (!userId) return null;
  const user = await User.findById(userId).select('username').lean();
  return user?.username || null;
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
  // destructured wrappedCli out before this call → legacy installs (sam-
  // local-codex et al) stayed as runtimeType:'local-cli' on the wire and
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

const buildOpenClawIntegrationChannels = (integrations: any[] = []) => {
  const channels: any = {
    discord: [],
    slack: [],
    telegram: [],
  };
  integrations.forEach((integration: any) => {
    if (!integration || typeof integration !== 'object') return;
    const id = String(integration._id || '').trim();
    const type = String(integration.type || '').trim().toLowerCase();
    const config = integration.config && typeof integration.config === 'object' ? integration.config : {};
    const name = String(
      config.channelName
      || config.groupName
      || config.chatTitle
      || integration.name
      || `${type}-${id}`,
    ).trim();
    if (type === 'discord') {
      const token = String(config.botToken || process.env.DISCORD_BOT_TOKEN || '').trim();
      if (!id || !token) return;
      channels.discord.push({
        accountId: id,
        name,
        token,
      });
      return;
    }
    if (type === 'slack') {
      const botToken = String(config.botToken || process.env.SLACK_BOT_TOKEN || '').trim();
      const appToken = String(config.appToken || process.env.SLACK_APP_TOKEN || '').trim();
      const signingSecret = String(config.signingSecret || process.env.SLACK_SIGNING_SECRET || '').trim();
      if (!id || !botToken) return;
      channels.slack.push({
        accountId: id,
        name,
        botToken,
        ...(appToken ? { appToken } : {}),
        ...(signingSecret ? { signingSecret } : {}),
        ...(config.channelId ? { channelId: String(config.channelId) } : {}),
      });
      return;
    }
    if (type === 'telegram') {
      const botToken = String(config.botToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();
      const webhookSecret = String(config.secretToken || process.env.TELEGRAM_SECRET_TOKEN || '').trim();
      if (!id || !botToken) return;
      channels.telegram.push({
        accountId: id,
        name,
        botToken,
        ...(webhookSecret ? { webhookSecret } : {}),
        ...(config.chatId ? { chatId: String(config.chatId) } : {}),
      });
    }
  });
  return channels;
};

// Mirror of agentIdentityService.resolveAgentDisplayLabel — duplicated here
// to avoid pulling that ESM/CJS-mixed module into a CJS helper. Stays in
// sync via the same fallback chain: botMetadata.displayName → instanceId
// (when not 'default') → username → fallback. Never falls back to
// botMetadata.agentName (runtime-leaning).
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
 */
const composeInstallIntro = ({
  displayName, blurb, handle, state, fixCommand,
}: {
  displayName: string;
  blurb?: string;
  handle: string;
  // The `deriveAgentState` enum, passed WHOLE rather than flattened to a
  // boolean. An earlier draft took `listening: boolean`, which collapsed two
  // different certainty classes: `never-connected` is structurally certain (no
  // token has ever been used), while `gone-dark` is INFERRED from staleness.
  // Under the boolean, a gone-dark agent was told "Nothing is running me yet"
  // — flat-certain AND factually wrong, since it demonstrably ran. Asserting a
  // guess in the agent's own voice is the very defect this function exists to
  // remove, so the hedge is not decoration (ux-lead, fleet review 2026-08-14).
  state: string;
  fixCommand: string;
}): string => {
  // Older CLI versions seeded description from displayName, producing intros
  // like "Hi all — I'm bot. bot Ping me ...". Drop a blurb that just repeats
  // the name.
  const trimmed = String(blurb || '').trim().replace(/\s+/g, ' ');
  const meaningless = !trimmed
    || trimmed.toLowerCase() === String(displayName).toLowerCase();
  const lead = meaningless
    ? `Hi all — I'm ${displayName}, just joined the pod.`
    : `Hi all — I'm ${displayName}. ${trimmed}`;

  // Certain, and never ran: flat declarative.
  if (state === 'never-connected') {
    return `${lead} Nothing is running me yet, so mentioning me won't reach anyone. `
      + `Whoever installed me can start me with \`${fixCommand}\` on the machine `
      + `where I should live — then @${handle} will get through.`;
  }
  // Inferred, and it DID run: hedge the claim, keep the instruction.
  if (state === 'gone-dark') {
    return `${lead} I don't look connected right now — I was running earlier and `
      + `have gone quiet, so a mention may not reach me. Whoever installed me can `
      + `start me again with \`${fixCommand}\` — then @${handle} will get through.`;
  }
  // reachable / listening / unknown — anything we cannot show to be down keeps
  // the invitation. Wrongly telling a live agent's room that nothing listens is
  // the opposite lie.
  return `${lead} Mention me with @${handle} when you need me.`;
};

const resolveDisplayLabelFromUser = (user: any, fallback: string): string => {
  if (!user) return fallback;
  const meta = user.botMetadata || {};
  const display = typeof meta.displayName === 'string' ? meta.displayName.trim() : '';
  if (display) return display;
  const instanceId = typeof meta.instanceId === 'string' ? meta.instanceId.trim() : '';
  if (instanceId && instanceId !== 'default') return instanceId;
  if (typeof user.username === 'string' && user.username) return user.username;
  return fallback;
};

const buildAgentInstallationPayload = (installation: any, {
  profile = null,
  iconUrl = '',
  lastHeartbeatAt = null,
  lastActiveAt = null,
  user = null,
}: {
  profile?: any; iconUrl?: string; lastHeartbeatAt?: any; lastActiveAt?: any; user?: any;
} = {}) => {
  if (!installation) return null;
  const normalizedConfig = normalizeConfigMap(installation.config);
  const runtimeConfig = sanitizeRuntimeConfig(
    normalizedConfig?.runtime || installation.config?.runtime || null,
    installation.agentName,
  );
  // The profile and installation are scoped to this pod; the User is the
  // portable principal. Read the scoped labels first. Reversing that order
  // makes a label written in one pod bleed into every other pod that renders
  // this same principal.
  const profileDisplayName = typeof profile?.name === 'string' ? profile.name.trim() : '';
  const installationDisplayName = typeof installation.displayName === 'string'
    ? installation.displayName.trim()
    : '';
  const identityFallback = installation.agentName || '';
  const displayName = profileDisplayName
    || installationDisplayName
    || (user ? resolveDisplayLabelFromUser(user, identityFallback) : identityFallback);
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
    installedBy: installation.installedBy?.toString?.() || installation.installedBy,
    runtime: runtimeConfig,
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
      autonomy: normalizedConfig.autonomy || null,
      errorRouting: normalizedConfig.errorRouting || null,
      heartbeatChecklist: normalizedConfig.heartbeatChecklist || '',
      skillSync: normalizedConfig.skillSync || null,
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

const normalizePluginIdentifier = (value: any) => String(value || '').trim().toLowerCase();

const getPluginSpecBase = (spec: any) => {
  const normalized = normalizePluginIdentifier(spec);
  if (!normalized) return '';
  if (normalized.startsWith('@')) {
    const parts = normalized.split('@');
    if (parts.length >= 2 && parts[1]) {
      return `@${parts[1]}`;
    }
    return normalized;
  }
  return normalized.split('@')[0];
};

const normalizeInstanceId = (raw: any) => {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
};

const normalizeDisplayName = (value: any) => String(value || '').trim().toLowerCase();

const buildRuntimeLogFilters = ({ runtimeType, agentName, instanceId }: { runtimeType: any; agentName: any; instanceId: any }) => {
  if (runtimeType !== 'moltbot') return [];
  const normalizedInstance = normalizeInstanceId(instanceId);
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const accountId = normalizedAgent === 'openclaw'
    ? normalizedInstance
    : `${normalizedAgent}-${normalizedInstance}`;
  const tokens = [normalizedInstance, accountId, normalizedAgent].filter(Boolean);
  return Array.from(new Set(tokens));
};

const resolveGatewayForRequest = async ({ gatewayId, userId }: { gatewayId: any; userId: any }) => {
  if (!gatewayId) return null;
  const user = await User.findById(userId).select('role').lean();
  if (!user || user.role !== 'admin') {
    const error: any = new Error('Global admin required to select a gateway');
    error.status = 403;
    throw error;
  }
  const gateway = await Gateway.findById(gatewayId).lean();
  if (!gateway) {
    const error: any = new Error('Gateway not found');
    error.status = 404;
    throw error;
  }
  const gw = gateway as any;
  if (gw.status && gw.status !== 'active') {
    const error: any = new Error('Gateway is not active');
    error.status = 400;
    throw error;
  }
  if (isK8sMode() && gw.mode !== 'k8s') {
    const error: any = new Error('Gateway must be K8s mode in this environment');
    error.status = 400;
    throw error;
  }
  return gateway;
};

const isGlobalAdminUser = async (userId: any) => {
  const user = await User.findById(userId).select('role').lean();
  return Boolean(user && user.role === 'admin');
};

const resolveGatewayForInstallation = async ({ gatewayId }: { gatewayId: any }) => {
  if (!gatewayId) return null;
  const gateway = await Gateway.findById(gatewayId).lean();
  if (!gateway) {
    const error: any = new Error('Gateway not found');
    error.status = 404;
    throw error;
  }
  const gw2 = gateway as any;
  if (gw2.status && gw2.status !== 'active') {
    const error: any = new Error('Gateway is not active');
    error.status = 400;
    throw error;
  }
  if (isK8sMode() && gw2.mode !== 'k8s') {
    const error: any = new Error('Gateway must be K8s mode in this environment');
    error.status = 400;
    throw error;
  }
  return gateway;
};

const userHasPodAccess = (pod: any, userId: any) => {
  if (!pod || !userId) return false;
  const userIdStr = userId.toString();
  if (pod.createdBy?.toString() === userIdStr) return true;
  return Boolean(pod.members?.some((m: any) => (m.userId?.toString?.() || m.toString()) === userIdStr));
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
  buildIdentityContent,
  parseVerifiedFilter,
  escapeRegExp,
  getUserId,
  resolveUsername,
  normalizeConfigMap,
  normalizeRuntimeAuthProfiles,
  normalizeSkillEnvEntries,
  sanitizeRuntimeConfig,
  buildOpenClawIntegrationChannels,
  buildAgentInstallationPayload,
  normalizePluginIdentifier,
  getPluginSpecBase,
  normalizeInstanceId,
  normalizeDisplayName,
  buildRuntimeLogFilters,
  resolveGatewayForRequest,
  isGlobalAdminUser,
  resolveGatewayForInstallation,
  userHasPodAccess,
  parseJsonFromText,
  serializeRuntimeTokens,
  parseEnvFlag,
  hasAnyEnv,
  resolveInstallation,
  buildAgentProfileId,
  resolveRuntimeInstanceId,
  composeInstallIntro,
};

export {};
