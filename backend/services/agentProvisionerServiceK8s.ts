// eslint-disable-next-line global-require
const k8s = require('@kubernetes/client-node');
// eslint-disable-next-line global-require
const stream = require('stream');
// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');
// eslint-disable-next-line global-require
const GlobalModelConfigService = require('./globalModelConfigService');

// ─── K8s clients ──────────────────────────────────────────────────────────────

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi: unknown = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi: unknown = kc.makeApiClient(k8s.AppsV1Api);
const k8sExec: unknown = new k8s.Exec(kc);

// ─── Interfaces ───────────────────────────────────────────────────────────────

type RuntimeType = 'moltbot' | 'internal' | 'webhook' | 'claude-code' | string;

type RuntimeStatus =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'pending'
  | 'unknown'
  | 'not_found'
  | 'external'
  | 'managed-externally'
  | 'error';

interface GatewayRef {
  [key: string]: unknown;
}

interface RuntimeOptions {
  gateway?: GatewayRef;
  [key: string]: unknown;
}

interface SessionSizeEntry {
  accountId: string;
  bytes: number;
}

interface ProvisionParams {
  runtimeType: RuntimeType;
  agentName: string;
  instanceId: string;
  runtimeToken?: string;
  userToken?: string;
  baseUrl?: string;
  displayName?: string;
  heartbeat?: Record<string, unknown>;
  authProfiles?: unknown;
  skillEnv?: Record<string, unknown>;
  integrationChannels?: {
    discord?: Array<{ accountId: string; token: string; name?: string }>;
    slack?: Array<{ accountId: string; botToken: string; appToken?: string; signingSecret?: string; channelId?: string; name?: string }>;
    telegram?: Array<{ accountId: string; botToken: string; webhookSecret?: string; chatId?: string; name?: string }>;
  };
  gateway?: GatewayRef;
  [key: string]: unknown;
}

interface ProvisionResult {
  provisioned: boolean;
  external?: boolean;
  deployment?: string;
  namespace?: string;
  sharedGateway?: boolean;
  [key: string]: unknown;
}

interface AgentRuntimeStatusResult {
  status: RuntimeStatus;
  deployment?: string;
  replicas?: number;
  availableReplicas?: number;
  readyReplicas?: number;
  sharedGateway?: boolean;
  reason?: string;
}

interface AgentRuntimeLogsResult {
  logs: string;
  [key: string]: unknown;
}

interface ClearSessionsResult {
  cleared: boolean;
  reason?: string;
  runtimeType: string;
}

interface SkillSyncOptions {
  accountId: string;
  podIds?: string[];
  mode?: 'all' | 'selected';
  skillNames?: string[];
  gateway?: GatewayRef;
  defaultCommonlySkillContent?: string;
  bundledSkills?: Array<{ name: string; content: string }>;
}

interface GatewaySkillEntry {
  key: string;
  value: Record<string, unknown>;
}

interface SyncGatewaySkillEnvParams {
  gateway?: GatewayRef;
  entries?: GatewaySkillEntry[];
}

interface FileOpOptions {
  gateway?: GatewayRef;
  allowEmpty?: boolean;
  customContent?: string;
  forceOverwrite?: boolean;
}

interface PluginInstallOptions {
  spec: string;
  link?: boolean;
  gateway?: GatewayRef;
}

interface CodexRefreshOptions {
  thresholdDays?: number;
}

interface CodexRefreshResult {
  expiresAt?: number;
  [key: string]: unknown;
}

// ─── Typed stubs (implementations stay in .js) ───────────────────────────────
// These functions match the JS implementations signature-for-signature.
// TypeScript consumers import this module and get typed declarations.

async function getAgentSessionSizes(options?: RuntimeOptions): Promise<SessionSizeEntry[]> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').getAgentSessionSizes(options) as Promise<SessionSizeEntry[]>;
}

async function provisionAgentRuntime(params: ProvisionParams): Promise<ProvisionResult> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').provisionAgentRuntime(params) as Promise<ProvisionResult>;
}

async function startAgentRuntime(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').startAgentRuntime(runtimeType, instanceId, options);
}

async function stopAgentRuntime(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').stopAgentRuntime(runtimeType, instanceId, options);
}

async function restartAgentRuntime(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').restartAgentRuntime(runtimeType, instanceId, options);
}

async function getAgentRuntimeStatus(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<AgentRuntimeStatusResult> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').getAgentRuntimeStatus(runtimeType, instanceId, options) as Promise<AgentRuntimeStatusResult>;
}

async function getAgentRuntimeLogs(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: { lines?: number; filterTokens?: string[]; gateway?: GatewayRef },
): Promise<AgentRuntimeLogsResult> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').getAgentRuntimeLogs(runtimeType, instanceId, options) as Promise<AgentRuntimeLogsResult>;
}

async function clearAgentRuntimeSessions(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions & { accountId?: string },
): Promise<ClearSessionsResult> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').clearAgentRuntimeSessions(runtimeType, instanceId, options) as Promise<ClearSessionsResult>;
}

function resolveOpenClawAccountId(params: { agentName: string; instanceId?: string }): string {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').resolveOpenClawAccountId(params) as string;
}

async function writeOpenClawHeartbeatFile(
  accountId: string,
  content: string,
  options?: FileOpOptions,
): Promise<void> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').writeOpenClawHeartbeatFile(accountId, content, options);
}

async function readOpenClawHeartbeatFile(
  accountId: string,
  options?: FileOpOptions,
): Promise<string | null> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').readOpenClawHeartbeatFile(accountId, options) as Promise<string | null>;
}

async function readOpenClawIdentityFile(
  accountId: string,
  options?: FileOpOptions,
): Promise<string | null> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').readOpenClawIdentityFile(accountId, options) as Promise<string | null>;
}

async function writeWorkspaceIdentityFile(
  accountId: string,
  content: string,
  options?: FileOpOptions,
): Promise<void> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').writeWorkspaceIdentityFile(accountId, content, options);
}

async function ensureWorkspaceIdentityFile(
  accountId: string,
  content: string,
  options?: FileOpOptions,
): Promise<void> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').ensureWorkspaceIdentityFile(accountId, content, options);
}

async function ensureWorkspaceSoulFile(
  accountId: string,
  content: string,
  options?: FileOpOptions,
): Promise<void> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').ensureWorkspaceSoulFile(accountId, content, options);
}

async function ensureHeartbeatTemplate(
  accountId: string,
  heartbeat: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').ensureHeartbeatTemplate(accountId, heartbeat);
}

async function syncOpenClawSkills(options: SkillSyncOptions): Promise<unknown> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').syncOpenClawSkills(options);
}

async function getGatewaySkillEntries(options?: RuntimeOptions): Promise<GatewaySkillEntry[]> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').getGatewaySkillEntries(options) as Promise<GatewaySkillEntry[]>;
}

async function syncGatewaySkillEnv(params: SyncGatewaySkillEnvParams): Promise<void> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').syncGatewaySkillEnv(params);
}

async function listOpenClawBundledSkills(options?: RuntimeOptions): Promise<unknown[]> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').listOpenClawBundledSkills(options) as Promise<unknown[]>;
}

async function listOpenClawPlugins(options?: RuntimeOptions): Promise<unknown[]> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').listOpenClawPlugins(options) as Promise<unknown[]>;
}

async function installOpenClawPlugin(params: PluginInstallOptions): Promise<unknown> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').installOpenClawPlugin(params);
}

async function refreshCodexOAuthToken(options?: CodexRefreshOptions): Promise<CodexRefreshResult> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').refreshCodexOAuthToken(options) as Promise<CodexRefreshResult>;
}

async function refreshCodexOAuthTokenIfNeeded(options?: CodexRefreshOptions): Promise<CodexRefreshResult | null> {
  // eslint-disable-next-line global-require
  return require('./agentProvisionerServiceK8s').refreshCodexOAuthTokenIfNeeded(options) as Promise<CodexRefreshResult | null>;
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  getAgentSessionSizes,
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  clearAgentRuntimeSessions,
  resolveOpenClawAccountId,
  writeOpenClawHeartbeatFile,
  readOpenClawHeartbeatFile,
  readOpenClawIdentityFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
  ensureWorkspaceSoulFile,
  ensureHeartbeatTemplate,
  syncOpenClawSkills,
  getGatewaySkillEntries,
  syncGatewaySkillEnv,
  listOpenClawBundledSkills,
  listOpenClawPlugins,
  installOpenClawPlugin,
  refreshCodexOAuthToken,
  refreshCodexOAuthTokenIfNeeded,
  // expose K8s clients for callers that need direct access
  k8sApi,
  k8sAppsApi,
  k8sExec,
};

export {};
