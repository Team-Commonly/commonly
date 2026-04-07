// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const adminAuth = require('../middleware/adminAuth');
// eslint-disable-next-line global-require
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentProfile = require('../models/AgentProfile');
// eslint-disable-next-line global-require
const Activity = require('../models/Activity');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Gateway = require('../models/Gateway');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const AgentTemplate = require('../models/AgentTemplate');
// eslint-disable-next-line global-require
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line global-require
const AgentEventService = require('../services/agentEventService');
// eslint-disable-next-line global-require
const DMService = require('../services/dmService');
// eslint-disable-next-line global-require
const { generateText } = require('../services/llmService');
// eslint-disable-next-line global-require
const {
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  clearAgentRuntimeSessions,
  isK8sMode,
  listOpenClawPlugins,
  listOpenClawBundledSkills,
  installOpenClawPlugin,
  writeOpenClawHeartbeatFile,
  readOpenClawHeartbeatFile,
  readOpenClawIdentityFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
  syncOpenClawSkills,
  resolveOpenClawAccountId,
} = require('../services/agentProvisionerService');
// eslint-disable-next-line global-require
const { hash, randomSecret } = require('../utils/secret');
// eslint-disable-next-line global-require
const {
  ManifestValidationError,
  normalizePublishPayload,
} = require('../utils/agentManifestRegistry');

interface AuthReq {
  userId?: string;
  user?: { id?: string; _id?: unknown; role?: string; username?: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

interface GatewayError extends Error {
  status?: number;
}

interface AgentPersona {
  tone?: string;
  specialties?: string[] | string;
  customInstructions?: string;
}

interface RuntimeAuthProfile {
  provider: string;
  key: string;
  type?: string;
}

interface SkillEnvEntry {
  env?: Record<string, string>;
  apiKey?: string;
}

interface RuntimeConfig {
  authProfiles?: Record<string, RuntimeAuthProfile>;
  skillEnv?: Record<string, SkillEnvEntry>;
  [key: string]: unknown;
}

interface NormalizedInstallation {
  agentName?: string;
  instanceId?: string;
  displayName?: string;
  version?: string;
  status?: string;
  scopes?: string[];
  createdAt?: unknown;
  usage?: unknown;
  installedBy?: unknown;
  config?: { runtime?: RuntimeConfig; heartbeat?: unknown; autonomy?: unknown; errorRouting?: unknown; heartbeatChecklist?: string; skillSync?: unknown } & Record<string, unknown>;
}

interface PluginCapability {
  name: string;
  spec: string;
  version: string;
}

interface GatewayCapabilities {
  generatedAt: string;
  pluginStatus: string;
  plugins: PluginCapability[];
  llmProviders: Record<string, boolean>;
  integrations: Record<string, boolean>;
}

interface DiscordChannelEntry {
  accountId: string;
  name: string;
  token: string;
}

interface SlackChannelEntry {
  accountId: string;
  name: string;
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  channelId?: string;
}

interface TelegramChannelEntry {
  accountId: string;
  name: string;
  botToken: string;
  webhookSecret?: string;
  chatId?: string;
}

interface IntegrationChannels {
  discord: DiscordChannelEntry[];
  slack: SlackChannelEntry[];
  telegram: TelegramChannelEntry[];
}

const router: ReturnType<typeof express.Router> = express.Router();

const buildIdentityContent = (name: string | undefined, persona: AgentPersona | undefined): string => {
  const toneMap: Record<string, string> = {
    friendly: 'Warm, approachable, supportive.',
    professional: 'Precise, measured, focused.',
    sarcastic: 'Dry, sardonic, irreverent.',
    educational: 'Patient, explanatory, thorough.',
    humorous: 'Playful, witty, light.',
  };
  const vibe = toneMap[persona?.tone || ''] || persona?.tone || '';
  const specialties = Array.isArray(persona?.specialties)
    ? persona.specialties.join(', ')
    : String(persona?.specialties || '');
  const lines = ['# IDENTITY.md', '', `- **Name:** ${name || ''}`, `- **Vibe:** ${vibe}`];
  if (specialties) lines.push(`- **Domain:** ${specialties}`);
  if (persona?.customInstructions) lines.push('', '## Notes', '', persona.customInstructions);
  lines.push('');
  return lines.join('\n');
};

const parseVerifiedFilter = (value: string | undefined): boolean | null => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getUserId = (req: AuthReq): unknown => req.userId || req.user?.id || req.user?._id;

const normalizeConfigMap = (config: unknown): Record<string, unknown> | null => {
  if (!config) return null;
  if (config instanceof Map) return Object.fromEntries(config.entries());
  if (typeof config === 'object') return config as Record<string, unknown>;
  return null;
};

const normalizeRuntimeAuthProfiles = (profiles: unknown): Record<string, RuntimeAuthProfile> | null => {
  if (!profiles || typeof profiles !== 'object') return null;
  const normalized: Record<string, RuntimeAuthProfile> = {};
  Object.entries(profiles as Record<string, unknown>).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    const provider = String(v.provider || '').trim().toLowerCase();
    const rawKey = String(v.key || '').trim();
    if (!provider || !rawKey) return;
    const type = String(v.type || 'api_key').trim().toLowerCase();
    if (type !== 'api_key') return;
    const profileId = String(key || `${provider}:default`).trim();
    normalized[profileId || `${provider}:default`] = { type: 'api_key', provider, key: rawKey };
  });
  return Object.keys(normalized).length ? normalized : null;
};

const normalizeSkillEnvEntries = (entries: unknown): Record<string, SkillEnvEntry> | null => {
  if (!entries || typeof entries !== 'object') return null;
  const normalized: Record<string, SkillEnvEntry> = {};
  Object.entries(entries as Record<string, unknown>).forEach(([skillName, value]) => {
    const name = String(skillName || '').trim();
    if (!name || !value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    const env = v.env && typeof v.env === 'object' ? v.env as Record<string, unknown> : {};
    const envEntries = Object.entries(env)
      .map(([k, val]) => [String(k || '').trim(), String(val ?? '').trim()] as [string, string])
      .filter(([k, val]) => k && val);
    const apiKey = String(v.apiKey ?? '').trim();
    if (!envEntries.length && !apiKey) return;
    normalized[name] = {
      ...(envEntries.length ? { env: Object.fromEntries(envEntries) } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  });
  return Object.keys(normalized).length ? normalized : null;
};

const sanitizeRuntimeConfig = (runtimeConfig: RuntimeConfig | null): Record<string, unknown> | null => {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') return runtimeConfig;
  const { authProfiles, skillEnv, ...rest } = runtimeConfig;
  const providers = authProfiles && typeof authProfiles === 'object'
    ? Array.from(new Set(Object.values(authProfiles).map((p) => String(p?.provider || '').trim().toLowerCase()).filter(Boolean)))
    : [];
  const skillKeys = skillEnv && typeof skillEnv === 'object'
    ? Object.keys(skillEnv).map((k) => String(k || '').trim()).filter(Boolean)
    : [];
  return { ...rest, authProviders: providers, hasCustomAuthProfiles: providers.length > 0, hasCustomSkillEnv: skillKeys.length > 0, skillEnvKeys: skillKeys };
};

const buildOpenClawIntegrationChannels = (integrations: Array<Record<string, unknown>> = []): IntegrationChannels => {
  const channels: IntegrationChannels = { discord: [], slack: [], telegram: [] };
  integrations.forEach((integration) => {
    if (!integration || typeof integration !== 'object') return;
    const id = String(integration._id || '').trim();
    const type = String(integration.type || '').trim().toLowerCase();
    const config = integration.config && typeof integration.config === 'object' ? integration.config as Record<string, unknown> : {};
    const name = String(config.channelName || config.groupName || config.chatTitle || integration.name || `${type}-${id}`).trim();
    if (type === 'discord') {
      const token = String(config.botToken || process.env.DISCORD_BOT_TOKEN || '').trim();
      if (!id || !token) return;
      channels.discord.push({ accountId: id, name, token });
    } else if (type === 'slack') {
      const botToken = String(config.botToken || process.env.SLACK_BOT_TOKEN || '').trim();
      if (!id || !botToken) return;
      const appToken = String(config.appToken || process.env.SLACK_APP_TOKEN || '').trim();
      const signingSecret = String(config.signingSecret || process.env.SLACK_SIGNING_SECRET || '').trim();
      channels.slack.push({ accountId: id, name, botToken, ...(appToken ? { appToken } : {}), ...(signingSecret ? { signingSecret } : {}), ...(config.channelId ? { channelId: String(config.channelId) } : {}) });
    } else if (type === 'telegram') {
      const botToken = String(config.botToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();
      if (!id || !botToken) return;
      const webhookSecret = String(config.secretToken || process.env.TELEGRAM_SECRET_TOKEN || '').trim();
      channels.telegram.push({ accountId: id, name, botToken, ...(webhookSecret ? { webhookSecret } : {}), ...(config.chatId ? { chatId: String(config.chatId) } : {}) });
    }
  });
  return channels;
};

const buildAgentInstallationPayload = (installation: NormalizedInstallation | null, { profile = null as Record<string, unknown> | null, iconUrl = '', lastHeartbeatAt = null as Date | null } = {}): Record<string, unknown> | null => {
  if (!installation) return null;
  const normalizedConfig = normalizeConfigMap(installation.config);
  const runtimeConfig = sanitizeRuntimeConfig((normalizedConfig?.runtime as RuntimeConfig) || (installation.config?.runtime as RuntimeConfig) || null);
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
    installedBy: (installation.installedBy as { toString?: () => string })?.toString?.() || installation.installedBy,
    runtime: runtimeConfig,
    config: normalizedConfig ? { heartbeat: normalizedConfig.heartbeat || null, autonomy: normalizedConfig.autonomy || null, errorRouting: normalizedConfig.errorRouting || null, heartbeatChecklist: normalizedConfig.heartbeatChecklist || '', skillSync: normalizedConfig.skillSync || null } : null,
    profile: profile ? { displayName: profile.name, purpose: profile.purpose, isDefault: profile.isDefault, modelPreferences: profile.modelPreferences, instructions: profile.instructions, persona: profile.persona, toolPolicy: profile.toolPolicy, contextPolicy: profile.contextPolicy } : null,
  };
};

const normalizePluginIdentifier = (value: unknown): string => String(value || '').trim().toLowerCase();

const getPluginSpecBase = (spec: unknown): string => {
  const normalized = normalizePluginIdentifier(spec);
  if (!normalized) return '';
  if (normalized.startsWith('@')) {
    const parts = normalized.split('@');
    if (parts.length >= 2 && parts[1]) return `@${parts[1]}`;
    return normalized;
  }
  return normalized.split('@')[0];
};

const normalizeInstanceId = (raw: unknown): string => {
  const normalized = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
};

const normalizeDisplayName = (value: unknown): string => String(value || '').trim().toLowerCase();

const buildRuntimeLogFilters = ({ runtimeType, agentName, instanceId }: { runtimeType: string; agentName: string; instanceId: string }): string[] => {
  if (runtimeType !== 'moltbot') return [];
  const normalizedInstance = normalizeInstanceId(instanceId);
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const accountId = normalizedAgent === 'openclaw' ? normalizedInstance : `${normalizedAgent}-${normalizedInstance}`;
  return Array.from(new Set([normalizedInstance, accountId, normalizedAgent].filter(Boolean)));
};

const resolveGatewayForRequest = async ({ gatewayId, userId }: { gatewayId: unknown; userId: unknown }): Promise<Record<string, unknown> | null> => {
  if (!gatewayId) return null;
  const user = await User.findById(userId).select('role').lean() as { role?: string } | null;
  if (!user || user.role !== 'admin') { const error = new Error('Global admin required to select a gateway') as GatewayError; error.status = 403; throw error; }
  const gateway = await Gateway.findById(gatewayId).lean() as Record<string, unknown> | null;
  if (!gateway) { const error = new Error('Gateway not found') as GatewayError; error.status = 404; throw error; }
  if ((gateway.status as string) && gateway.status !== 'active') { const error = new Error('Gateway is not active') as GatewayError; error.status = 400; throw error; }
  if (isK8sMode() && gateway.mode !== 'k8s') { const error = new Error('Gateway must be K8s mode in this environment') as GatewayError; error.status = 400; throw error; }
  return gateway;
};

const isGlobalAdminUser = async (userId: unknown): Promise<boolean> => {
  const user = await User.findById(userId).select('role').lean() as { role?: string } | null;
  return Boolean(user && user.role === 'admin');
};

const resolveGatewayForInstallation = async ({ gatewayId }: { gatewayId: unknown }): Promise<Record<string, unknown> | null> => {
  if (!gatewayId) return null;
  const gateway = await Gateway.findById(gatewayId).lean() as Record<string, unknown> | null;
  if (!gateway) { const error = new Error('Gateway not found') as GatewayError; error.status = 404; throw error; }
  if ((gateway.status as string) && gateway.status !== 'active') { const error = new Error('Gateway is not active') as GatewayError; error.status = 400; throw error; }
  if (isK8sMode() && gateway.mode !== 'k8s') { const error = new Error('Gateway must be K8s mode in this environment') as GatewayError; error.status = 400; throw error; }
  return gateway;
};

const userHasPodAccess = (pod: { createdBy?: { toString: () => string }; members?: Array<{ userId?: { toString?: () => string }; toString: () => string }> } | null, userId: unknown): boolean => {
  if (!pod || !userId) return false;
  const userIdStr = String(userId);
  if (pod.createdBy?.toString() === userIdStr) return true;
  return Boolean(pod.members?.some((m) => (m.userId?.toString?.() || m.toString()) === userIdStr));
};

const parseJsonFromText = (text: string | null | undefined): unknown => {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_e) {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch (_e2) { return null; } }
    return null;
  }
};

const serializeRuntimeTokens = (tokens: Array<{ _id?: unknown; label?: string; createdAt?: unknown; lastUsedAt?: unknown }> = []): Array<Record<string, unknown>> => tokens.map((token) => ({ id: (token._id as { toString?: () => string })?.toString?.(), label: token.label, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt }));

const parseEnvFlag = (value: string | undefined | null): boolean => {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !['0', 'false', 'no', 'off', 'disabled', 'none'].includes(normalized);
};

const hasAnyEnv = (keys: string[] = []): boolean => keys.some((key) => parseEnvFlag(process.env[key]));

const detectGatewayPresetCapabilities = async (): Promise<GatewayCapabilities> => {
  const capability: GatewayCapabilities = {
    generatedAt: new Date().toISOString(),
    pluginStatus: 'unknown',
    plugins: [],
    llmProviders: { google: hasAnyEnv(['GEMINI_API_KEY']), openai: hasAnyEnv(['OPENAI_API_KEY']), anthropic: hasAnyEnv(['ANTHROPIC_API_KEY']), litellm: hasAnyEnv(['LITELLM_BASE_URL']) },
    integrations: { discord: hasAnyEnv(['DISCORD_BOT_TOKEN']), slack: hasAnyEnv(['SLACK_BOT_TOKEN', 'SLACK_CLIENT_ID']), telegram: hasAnyEnv(['TELEGRAM_BOT_TOKEN']), x: hasAnyEnv(['X_API_BASE_URL']), instagram: hasAnyEnv(['INSTAGRAM_GRAPH_API_BASE']) },
  };
  try {
    const report = await listOpenClawPlugins();
    const plugins: Array<Record<string, string>> = Array.isArray(report?.plugins) ? report.plugins : [];
    capability.pluginStatus = 'detected';
    capability.plugins = plugins.map((plugin) => ({ name: plugin.name || '', spec: plugin.spec || plugin.name || '', version: plugin.version || '' }));
  } catch (_e) {
    capability.pluginStatus = 'unavailable';
    capability.plugins = [];
  }
  return capability;
};

const normalizeInstanceIdFn = (raw: unknown): string => {
  const normalized = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
};

const deriveInstanceId = (displayName: string | undefined, agentName: string): string => {
  if (!displayName) return 'default';
  const slug = String(displayName).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug === agentName.toLowerCase()) return 'default';
  return slug;
};

const resolveRuntimeInstanceId = ({ agentName, requestedInstanceId, installation }: { agentName: string; requestedInstanceId?: string; installation?: { instanceId?: string } | null }): string => {
  const installedInstanceId = normalizeInstanceIdFn(installation?.instanceId);
  if (installedInstanceId) return installedInstanceId;
  return normalizeInstanceIdFn(requestedInstanceId);
};

const findExistingAgentInstance = async (agentName: string, instanceId: string): Promise<{ exists: boolean; installations: unknown[]; agentUser: unknown }> => {
  const installations = await AgentInstallation.find({ agentName: agentName.toLowerCase(), instanceId, status: 'active' }).lean();
  if (installations.length === 0) return { exists: false, installations: [], agentUser: null };
  const username = AgentIdentityService.buildAgentUsername(agentName, instanceId);
  const agentUser = await User.findOne({ username, isBot: true }).lean();
  return { exists: true, installations, agentUser };
};

const resolveInstallation = async ({ agentName, podId, instanceId }: { agentName: string; podId: unknown; instanceId: string }): Promise<{ installation: unknown; instanceId: string }> => {
  const normalizedInstanceId = normalizeInstanceIdFn(instanceId);
  let installation = await AgentInstallation.findOne({ agentName: agentName.toLowerCase(), podId, instanceId: normalizedInstanceId });
  if (installation) return { installation, instanceId: normalizedInstanceId };
  if (normalizedInstanceId === 'default') {
    const installs = await AgentInstallation.find({ agentName: agentName.toLowerCase(), podId, status: { $ne: 'uninstalled' } }).limit(2);
    if (installs.length === 1) return { installation: installs[0], instanceId: installs[0].instanceId || 'default' };
  }
  const activeInstalls = await AgentInstallation.find({ agentName: agentName.toLowerCase(), podId, status: { $ne: 'uninstalled' } }).limit(2);
  if (activeInstalls.length === 1) return { installation: activeInstalls[0], instanceId: activeInstalls[0].instanceId || 'default' };
  return { installation: null, instanceId: normalizedInstanceId };
};

const buildAgentProfileId = (agentName: string, instanceId: string): string => `${agentName.toLowerCase()}:${normalizeInstanceIdFn(instanceId)}`;

const AGENT_USER_TOKEN_SCOPES = new Set([
  'agent:events:read',
  'agent:events:ack',
  'agent:context:read',
  'agent:messages:read',
  'agent:messages:write',
]);

const normalizeScopes = (scopes: unknown): string[] => {
  if (!Array.isArray(scopes)) return [];
  return Array.from(new Set((scopes as string[]).filter((scope) => AGENT_USER_TOKEN_SCOPES.has(scope))));
};

const sanitizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set((value as unknown[]).map((entry) => String(entry || '').trim()).filter(Boolean)));
};

// The actual route implementations are in registry.js
// This file provides TypeScript types for the module
module.exports = require('./registry.js');
