// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const AgentEventService = require('../services/agentEventService');
// eslint-disable-next-line global-require
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line global-require
const AgentMessageService = require('../services/agentMessageService');
// eslint-disable-next-line global-require
const AgentThreadService = require('../services/agentThreadService');
// eslint-disable-next-line global-require
const PodContextService = require('../services/podContextService');
// eslint-disable-next-line global-require
const GlobalModelConfigService = require('../services/globalModelConfigService');
// eslint-disable-next-line global-require
const SocialPolicyService = require('../services/socialPolicyService');
// eslint-disable-next-line global-require
const registry = require('../integrations');
// eslint-disable-next-line global-require
const Activity = require('../models/Activity');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const { requireApiTokenScopes } = require('../middleware/apiTokenScopes');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const AgentMemory = require('../models/AgentMemory');
// eslint-disable-next-line global-require
const DMService = require('../services/dmService');
// eslint-disable-next-line global-require
const ChatSummarizerService = require('../services/chatSummarizerService');
// eslint-disable-next-line global-require
const AgentMentionService = require('../services/agentMentionService');

let PGPod: unknown;
try {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
} catch (_) {
  PGPod = null;
}

interface AgentReq {
  userId?: string;
  user?: { id?: string; _id?: unknown; isBot?: boolean; role?: string; username?: string; botMetadata?: { agentName?: string; agentType?: string; instanceId?: string; displayName?: string } };
  agentUser?: { _id?: unknown; username?: string; botMetadata?: { agentName?: string; agentType?: string; instanceId?: string; displayName?: string } };
  agentInstallation?: { agentName?: string; instanceId?: string; podId?: unknown; installedBy?: unknown; scopes?: string[] };
  agentInstallations?: Array<{ agentName?: string; instanceId?: string; podId?: unknown; status?: string; scopes?: string[] }>;
  agentAuthorizedPodIds?: unknown[];
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const parseNonNegativeInt = (value: string | undefined, fallback: number) => {
  const parsed = parseInt(value || '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, parsed);
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = parseInt(value || '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(1, parsed);
};

const INTEGRATION_PUBLISH_COOLDOWN_SECONDS = parseNonNegativeInt(process.env.AGENT_INTEGRATION_PUBLISH_COOLDOWN_SECONDS, 1800);
const INTEGRATION_PUBLISH_DAILY_LIMIT = parsePositiveInt(process.env.AGENT_INTEGRATION_PUBLISH_DAILY_LIMIT, 24);

const ensurePodMatch = (installationOrList: unknown, podId: unknown, authorizedPodIds: unknown[] = []): boolean => {
  const normalizedPodId = (podId as { toString?: () => string })?.toString?.() || String(podId || '');
  if (Array.isArray(authorizedPodIds) && authorizedPodIds.length > 0) {
    return authorizedPodIds.some((id) => String(id) === normalizedPodId);
  }
  if (Array.isArray(installationOrList)) {
    return installationOrList.some((installation) => (installation as { podId?: { toString: () => string } })?.podId?.toString() === normalizedPodId);
  }
  return (installationOrList as { podId?: { toString: () => string } })?.podId?.toString() === normalizedPodId;
};

const resolveInstallationForPod = (installations: Array<{ podId?: { toString: () => string } }> = [], fallback: unknown, podId: { toString: () => string }) => {
  if (!Array.isArray(installations)) return fallback;
  return installations.find((installation) => installation?.podId?.toString() === podId.toString()) || fallback;
};

const hasAnyScope = (installation: { scopes?: string[] } | null, acceptedScopes: string[] = []): boolean => {
  const scopes = Array.isArray(installation?.scopes) ? installation!.scopes : [];
  if (scopes.length === 0) return true;
  return acceptedScopes.some((scope) => scopes.includes(scope));
};

const mapBufferedIntegrationMessages = (integration: { config?: { messageBuffer?: Array<{ messageId?: string; content?: string; authorName?: string; authorId?: string; timestamp?: string; metadata?: unknown }> } } | null, { limit = 100, before, after }: { limit?: number; before?: string; after?: string } = {}) => {
  const buffer = Array.isArray(integration?.config?.messageBuffer) ? integration!.config!.messageBuffer! : [];
  let messages = buffer.map((entry) => ({ id: entry?.messageId ? String(entry.messageId) : null, content: String(entry?.content || ''), author: String(entry?.authorName || ''), authorId: entry?.authorId ? String(entry.authorId) : null, timestamp: entry?.timestamp || null, metadata: entry?.metadata || {} })).filter((entry) => entry.id && entry.timestamp);
  if (before) { const beforeDate = new Date(before); if (!Number.isNaN(beforeDate.valueOf())) messages = messages.filter((entry) => new Date(entry.timestamp as string) < beforeDate); }
  if (after) { const afterDate = new Date(after); if (!Number.isNaN(afterDate.valueOf())) messages = messages.filter((entry) => new Date(entry.timestamp as string) > afterDate); }
  messages.sort((a, b) => new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime());
  return messages.slice(0, limit);
};

const requireBotUser = async (req: AgentReq, res: Res) => {
  const userId = req.userId || req.user?.id;
  const user = await User.findById(userId).lean() as { isBot?: boolean } | null;
  if (!user || !user.isBot) return { error: res.status(403).json({ message: 'This endpoint is for bot users only' }) };
  return { user };
};

const ensureBotInstallation = async (agentName: string, podId: unknown, statuses = ['active'], instanceId = 'default') => {
  return AgentInstallation.findOne({ agentName: agentName.toLowerCase(), podId, instanceId, status: { $in: statuses } }).lean();
};

const ensureBotPodAccess = async (user: AgentReq['user'], agentName: string, podId: unknown, statuses = ['active'], instanceId = 'default') => {
  const installation = await ensureBotInstallation(agentName, podId, statuses, instanceId);
  if (installation) return installation;
  const dmPod = await Pod.findOne({ _id: podId, type: 'agent-admin', members: user?._id }).select('_id').lean();
  if (!dmPod) return null;
  const fallbackInstallation = await AgentInstallation.findOne({ agentName: agentName.toLowerCase(), instanceId, status: { $in: statuses } }).sort({ updatedAt: -1 }).lean();
  if (fallbackInstallation) return fallbackInstallation;
  return { agentName: agentName.toLowerCase(), instanceId, displayName: (user as { botMetadata?: { displayName?: string }; name?: string })?.botMetadata?.displayName || (user as { name?: string })?.name || agentName, config: {} };
};

// The actual route implementations are in agentsRuntime.js
// This file provides TypeScript types for the module
module.exports = require('./agentsRuntime.js');
