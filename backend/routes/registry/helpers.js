// Shared helper utilities — extracted from registry.js (GH#112)
const User = require('../../models/User');
const Gateway = require('../../models/Gateway');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { isK8sMode } = require('../../services/agentProvisionerService');

const buildIdentityContent = (name, persona) => {
  const toneMap = {
    friendly: 'Warm, approachable, supportive.',
    professional: 'Precise, measured, focused.',
    sarcastic: 'Dry, sardonic, irreverent.',
    educational: 'Patient, explanatory, thorough.',
    humorous: 'Playful, witty, light.',
  };
  const vibe = toneMap[persona?.tone] || persona?.tone || '';
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

const parseVerifiedFilter = (value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getUserId = (req) => req.userId || req.user?.id || req.user?._id;

const normalizeConfigMap = (config) => {
  if (!config) return null;
  if (config instanceof Map) {
    return Object.fromEntries(config.entries());
  }
  if (typeof config === 'object') {
    return config;
  }
  return null;
};

const normalizeRuntimeAuthProfiles = (profiles) => {
  if (!profiles || typeof profiles !== 'object') return null;
  const normalized = {};
  Object.entries(profiles).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const provider = String(value.provider || '').trim().toLowerCase();
    const rawKey = String(value.key || '').trim();
    if (!provider || !rawKey) return;
    const type = String(value.type || 'api_key').trim().toLowerCase();
    if (type !== 'api_key') return;
    const profileId = String(key || `${provider}:default`).trim();
    normalized[profileId || `${provider}:default`] = {
      type: 'api_key',
      provider,
      key: rawKey,
    };
  });
  return Object.keys(normalized).length ? normalized : null;
};

const normalizeSkillEnvEntries = (entries) => {
  if (!entries || typeof entries !== 'object') return null;
  const normalized = {};
  Object.entries(entries).forEach(([skillName, value]) => {
    const name = String(skillName || '').trim();
    if (!name || !value || typeof value !== 'object') return;
    const env = value.env && typeof value.env === 'object' ? value.env : {};
    const envEntries = Object.entries(env)
      .map(([key, val]) => [String(key || '').trim(), String(val ?? '').trim()])
      .filter(([key, val]) => key && val);
    const apiKey = String(value.apiKey ?? '').trim();
    if (!envEntries.length && !apiKey) return;
    normalized[name] = {
      ...(envEntries.length ? { env: Object.fromEntries(envEntries) } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  });
  return Object.keys(normalized).length ? normalized : null;
};

const sanitizeRuntimeConfig = (runtimeConfig) => {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') return runtimeConfig;
  const { authProfiles, skillEnv, ...rest } = runtimeConfig;
  const providers = authProfiles && typeof authProfiles === 'object'
    ? Array.from(new Set(
      Object.values(authProfiles)
        .map((profile) => String(profile?.provider || '').trim().toLowerCase())
        .filter(Boolean),
    ))
    : [];
  const skillKeys = skillEnv && typeof skillEnv === 'object'
    ? Object.keys(skillEnv).map((key) => String(key || '').trim()).filter(Boolean)
    : [];
  return {
    ...rest,
    authProviders: providers,
    hasCustomAuthProfiles: providers.length > 0,
    hasCustomSkillEnv: skillKeys.length > 0,
    skillEnvKeys: skillKeys,
  };
};

const buildOpenClawIntegrationChannels = (integrations = []) => {
  const channels = {
    discord: [],
    slack: [],
    telegram: [],
  };
  integrations.forEach((integration) => {
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

const buildAgentInstallationPayload = (installation, {
  profile = null,
  iconUrl = '',
  lastHeartbeatAt = null,
} = {}) => {
  if (!installation) return null;
  const normalizedConfig = normalizeConfigMap(installation.config);
  const runtimeConfig = sanitizeRuntimeConfig(normalizedConfig?.runtime || installation.config?.runtime || null);
  return {
    name: installation.agentName,
    instanceId: installation.instanceId || 'default',
    displayName: installation.displayName,
    iconUrl,
    version: installation.version,
    status: installation.status,
    scopes: installation.scopes,
    installedAt: installation.createdAt,
    lastHeartbeatAt,
    usage: installation.usage,
    installedBy: installation.installedBy?.toString?.() || installation.installedBy,
    runtime: runtimeConfig,
    config: normalizedConfig ? {
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

const normalizePluginIdentifier = (value) => String(value || '').trim().toLowerCase();

const getPluginSpecBase = (spec) => {
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

const normalizeInstanceId = (raw) => {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
};

const normalizeDisplayName = (value) => String(value || '').trim().toLowerCase();

const buildRuntimeLogFilters = ({ runtimeType, agentName, instanceId }) => {
  if (runtimeType !== 'moltbot') return [];
  const normalizedInstance = normalizeInstanceId(instanceId);
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const accountId = normalizedAgent === 'openclaw'
    ? normalizedInstance
    : `${normalizedAgent}-${normalizedInstance}`;
  const tokens = [normalizedInstance, accountId, normalizedAgent].filter(Boolean);
  return Array.from(new Set(tokens));
};

const resolveGatewayForRequest = async ({ gatewayId, userId }) => {
  if (!gatewayId) return null;
  const user = await User.findById(userId).select('role').lean();
  if (!user || user.role !== 'admin') {
    const error = new Error('Global admin required to select a gateway');
    error.status = 403;
    throw error;
  }
  const gateway = await Gateway.findById(gatewayId).lean();
  if (!gateway) {
    const error = new Error('Gateway not found');
    error.status = 404;
    throw error;
  }
  if (gateway.status && gateway.status !== 'active') {
    const error = new Error('Gateway is not active');
    error.status = 400;
    throw error;
  }
  if (isK8sMode() && gateway.mode !== 'k8s') {
    const error = new Error('Gateway must be K8s mode in this environment');
    error.status = 400;
    throw error;
  }
  return gateway;
};

const isGlobalAdminUser = async (userId) => {
  const user = await User.findById(userId).select('role').lean();
  return Boolean(user && user.role === 'admin');
};

const resolveGatewayForInstallation = async ({ gatewayId }) => {
  if (!gatewayId) return null;
  const gateway = await Gateway.findById(gatewayId).lean();
  if (!gateway) {
    const error = new Error('Gateway not found');
    error.status = 404;
    throw error;
  }
  if (gateway.status && gateway.status !== 'active') {
    const error = new Error('Gateway is not active');
    error.status = 400;
    throw error;
  }
  if (isK8sMode() && gateway.mode !== 'k8s') {
    const error = new Error('Gateway must be K8s mode in this environment');
    error.status = 400;
    throw error;
  }
  return gateway;
};

const userHasPodAccess = (pod, userId) => {
  if (!pod || !userId) return false;
  const userIdStr = userId.toString();
  if (pod.createdBy?.toString() === userIdStr) return true;
  return Boolean(pod.members?.some((m) => (m.userId?.toString?.() || m.toString()) === userIdStr));
};

const parseJsonFromText = (text) => {
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

const serializeRuntimeTokens = (tokens = []) => tokens.map((token) => ({
  id: token._id?.toString(),
  label: token.label,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
}));

const parseEnvFlag = (value) => {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'no', 'off', 'disabled', 'none'].includes(normalized);
};

const hasAnyEnv = (keys = []) => keys.some((key) => parseEnvFlag(process.env[key]));

const buildAgentProfileId = (agentName, instanceId) => (
  `${agentName.toLowerCase()}:${normalizeInstanceId(instanceId)}`
);

const resolveRuntimeInstanceId = ({ agentName, requestedInstanceId, installation }) => {
  // Runtime identity must follow the installed instance exactly.
  // Do not derive a different runtime instance from displayName, otherwise
  // shared tokens can drift and runtime pod authorization fails.
  const installedInstanceId = normalizeInstanceId(installation?.instanceId);
  if (installedInstanceId) return installedInstanceId;
  return normalizeInstanceId(requestedInstanceId);
};

const resolveInstallation = async ({ agentName, podId, instanceId }) => {
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
};
