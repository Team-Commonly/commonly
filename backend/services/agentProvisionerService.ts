// eslint-disable-next-line global-require
const fs = require('fs');
// eslint-disable-next-line global-require
const path = require('path');
// eslint-disable-next-line global-require
const { execFile } = require('child_process');
// eslint-disable-next-line global-require
const { promisify } = require('util');
// eslint-disable-next-line global-require
const JSON5 = require('json5');
// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');
// eslint-disable-next-line global-require
const GlobalModelConfigService = require('./globalModelConfigService');

// ─── Interfaces ──────────────────────────────────────────────────────────────

type RuntimeType = 'moltbot' | 'internal' | 'webhook' | 'claude-code' | string;

interface HeartbeatConfig {
  enabled?: boolean;
  everyMinutes?: number;
  session?: string;
  prompt?: string[];
  target?: string;
  global?: boolean;
  requireMention?: boolean;
  [key: string]: unknown;
}

interface DiscordChannelConfig {
  accountId: string;
  token: string;
  name?: string;
}

interface SlackChannelConfig {
  accountId: string;
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  channelId?: string;
  name?: string;
}

interface TelegramChannelConfig {
  accountId: string;
  botToken: string;
  webhookSecret?: string;
  chatId?: string;
  name?: string;
}

interface IntegrationChannels {
  discord?: DiscordChannelConfig[];
  slack?: SlackChannelConfig[];
  telegram?: TelegramChannelConfig[];
}

interface SkillEnvEntry {
  env?: Record<string, string>;
  apiKey?: string;
  [key: string]: unknown;
}

interface ProvisionParams {
  runtimeType: RuntimeType;
  agentName: string;
  instanceId: string;
  runtimeToken: string;
  userToken: string;
  baseUrl: string;
  displayName?: string;
  heartbeat?: HeartbeatConfig;
  authProfiles?: unknown;
  skillEnv?: Record<string, SkillEnvEntry>;
  integrationChannels?: IntegrationChannels;
  [key: string]: unknown;
}

interface ProvisionResult {
  configPath: string;
  accountId: string;
  restartRequired: boolean;
}

interface ExternalProvisionResult {
  provisioned: true;
  external: true;
  runtimeType: string;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
  command: string;
  service?: string;
}

interface ExecCommandOptions {
  timeout?: number;
  maxBuffer?: number;
}

interface RuntimeOptions {
  [key: string]: unknown;
}

interface PluginInstallOptions {
  spec: string;
  link?: boolean;
  [key: string]: unknown;
}

interface SessionSizeEntry {
  agentId: string;
  sizeKb: number;
  path: string;
}

interface WorkspaceOwnership {
  uid: number;
  gid: number;
}

interface SkillSyncOptions {
  accountId?: string;
  podIds?: string[];
  mode?: 'all' | 'selected';
  skillNames?: string[];
  configPath?: string;
}

interface OpenClawConfig {
  channels?: {
    commonly?: {
      enabled?: boolean;
      baseUrl?: string;
      accounts?: Record<string, {
        runtimeToken?: string;
        userToken?: string;
        agentName?: string;
        instanceId?: string;
        authProfiles?: unknown;
      }>;
    };
    discord?: Record<string, unknown>;
    slack?: Record<string, unknown>;
    telegram?: Record<string, unknown>;
  };
  tools?: {
    web?: {
      search?: { provider?: string };
      [key: string]: unknown;
    };
  };
  memory?: Record<string, unknown>;
  context?: Record<string, unknown>;
  models?: Record<string, unknown>;
  agents?: {
    list?: Array<{
      id: string;
      name: string;
      workspace?: string;
      heartbeat?: Record<string, unknown>;
    }>;
    defaults?: Record<string, unknown>;
  };
  bindings?: Array<{
    agentId: string;
    match: { channel: string; accountId: string };
  }>;
  skills?: {
    entries?: Record<string, SkillEnvEntry>;
  };
  [key: string]: unknown;
}

interface GatewaySkillEntry {
  key: string;
  value: SkillEnvEntry;
}

// ─── Module-level helpers (typed delegations of JS implementations) ───────────

const execFileAsync: (...args: unknown[]) => Promise<{ stdout: string; stderr: string }> = promisify(execFile);

function getOpenClawWorkspaceOwnership(): WorkspaceOwnership {
  const uidRaw = process.env.OPENCLAW_WORKSPACE_UID || process.env.CLAWDBOT_WORKSPACE_UID;
  const gidRaw = process.env.OPENCLAW_WORKSPACE_GID || process.env.CLAWDBOT_WORKSPACE_GID;
  const uid = Number.parseInt(uidRaw as string, 10);
  const gid = Number.parseInt(gidRaw as string, 10);
  return {
    uid: Number.isFinite(uid) ? uid : 1000,
    gid: Number.isFinite(gid) ? gid : 1000,
  };
}

function chownPath(targetPath: string): void {
  const { uid, gid } = getOpenClawWorkspaceOwnership();
  try {
    fs.chownSync(targetPath, uid, gid);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (err?.code !== 'EPERM') {
      console.warn('[agent-provisioner] Failed to chown path:', err.message);
    }
  }
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  chownPath(dir);
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8') as string;
    if (!raw.trim()) return fallback;
    return JSON5.parse(raw) as T;
  } catch (error) {
    const err = error as { message?: string };
    console.warn(`[agent-provisioner] Failed to parse ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJsonFile(filePath: string, payload: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  chownPath(filePath);
}

// ─── Exported functions (typed wrappers — implementations stay in .js) ────────

function isK8sMode(): boolean {
  return !!(process.env.KUBERNETES_SERVICE_HOST || process.env.OPENCLAW_K8S_MODE === 'true');
}

function resolveOpenClawAccountId({ agentName, instanceId }: { agentName: string; instanceId?: string }): string {
  if (instanceId && instanceId !== 'default') return instanceId;
  return agentName;
}

function getOpenClawConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH || '/config/moltbot.json';
}

function getCommonlyBotConfigPath(): string {
  return process.env.COMMONLY_BOT_CONFIG_PATH || '/config/commonly-bot.json';
}

async function provisionAgentRuntime(
  params: ProvisionParams,
): Promise<ProvisionResult | ExternalProvisionResult> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.provisionAgentRuntime(params) as Promise<ProvisionResult | ExternalProvisionResult>;
  }
  // Docker path — delegate to JS implementation
  const jsModule = require('./agentProvisionerService');
  return jsModule.provisionAgentRuntime(params) as Promise<ProvisionResult | ExternalProvisionResult>;
}

async function startAgentRuntime(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.startAgentRuntime(runtimeType, instanceId, options);
  }
  return startDockerRuntime(runtimeType);
}

async function stopAgentRuntime(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.stopAgentRuntime(runtimeType, instanceId, options);
  }
  return stopDockerRuntime(runtimeType);
}

async function restartAgentRuntime(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.restartAgentRuntime(runtimeType, instanceId, options);
  }
  return restartDockerRuntime(runtimeType);
}

async function getAgentRuntimeStatus(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.getAgentRuntimeStatus(runtimeType, instanceId, options);
  }
  return getDockerRuntimeStatus(runtimeType);
}

async function getAgentRuntimeLogs(
  runtimeType: RuntimeType,
  instanceId: string,
  lines?: number,
  options?: RuntimeOptions,
): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.getAgentRuntimeLogs(runtimeType, instanceId, lines, options);
  }
  return getDockerRuntimeLogs(runtimeType, lines);
}

async function getAgentSessionSizes(options?: RuntimeOptions): Promise<SessionSizeEntry[]> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.getAgentSessionSizes(options) as Promise<SessionSizeEntry[]>;
  }
  return [];
}

async function clearAgentRuntimeSessions(
  runtimeType: RuntimeType,
  instanceId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.clearAgentRuntimeSessions(runtimeType, instanceId, options);
  }
  return null;
}

async function listOpenClawPlugins(options?: RuntimeOptions): Promise<unknown[]> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.listOpenClawPlugins(options) as Promise<unknown[]>;
  }
  return [];
}

async function listOpenClawBundledSkills(options?: RuntimeOptions): Promise<unknown[]> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.listOpenClawBundledSkills(options) as Promise<unknown[]>;
  }
  return [];
}

async function installOpenClawPlugin(params: PluginInstallOptions): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.installOpenClawPlugin(params);
  }
  return null;
}

async function syncOpenClawSkills(options?: SkillSyncOptions): Promise<string> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.syncOpenClawSkills(options) as Promise<string>;
  }
  return options?.accountId
    ? path.join(process.env.OPENCLAW_WORKSPACE_DIR || '/workspace', options.accountId, 'skills')
    : '';
}

function syncOpenClawSkillEnv(params: { skillEnv?: Record<string, SkillEnvEntry>; configPath?: string }): string | null {
  const { skillEnv, configPath: cp } = params;
  if (!skillEnv || Object.keys(skillEnv).length === 0) return null;
  const cfgPath = cp || getOpenClawConfigPath();
  const config = readJsonFile<OpenClawConfig>(cfgPath, {});
  if (!config.skills) config.skills = {};
  if (!config.skills.entries) config.skills.entries = {};
  Object.assign(config.skills.entries, skillEnv);
  writeJsonFile(cfgPath, config);
  return cfgPath;
}

function getGatewaySkillEntries(params: { configPath?: string }): GatewaySkillEntry[] {
  const cfgPath = params.configPath || getOpenClawConfigPath();
  const config = readJsonFile<OpenClawConfig>(cfgPath, {});
  const entries = config.skills?.entries || {};
  return Object.entries(entries).map(([key, value]) => ({ key, value }));
}

async function syncGatewaySkillEnv(params: { gateway?: unknown; entries?: GatewaySkillEntry[] }): Promise<void> {
  const { entries = [] } = params;
  if (!entries.length) return;
  const cfgPath = getOpenClawConfigPath();
  const config = readJsonFile<OpenClawConfig>(cfgPath, {});
  if (!config.skills) config.skills = {};
  if (!config.skills.entries) config.skills.entries = {};
  for (const { key, value } of entries) {
    config.skills.entries[key] = value;
  }
  writeJsonFile(cfgPath, config);
}

async function writeOpenClawHeartbeatFile(
  accountId: string,
  content: string,
  options?: RuntimeOptions,
): Promise<void> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.writeOpenClawHeartbeatFile(accountId, content, options);
  }
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || '/workspace';
  const filePath = path.join(workspaceDir, accountId, 'HEARTBEAT.md');
  ensureDir(filePath);
  fs.writeFileSync(filePath, content);
  chownPath(filePath);
}

async function readOpenClawHeartbeatFile(
  accountId: string,
  options?: RuntimeOptions,
): Promise<string | null> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.readOpenClawHeartbeatFile(accountId, options) as Promise<string | null>;
  }
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || '/workspace';
  const filePath = path.join(workspaceDir, accountId, 'HEARTBEAT.md');
  try {
    // eslint-disable-next-line global-require
    const fsSync = require('fs');
    if (!fsSync.existsSync(filePath)) return null;
    return fsSync.readFileSync(filePath, 'utf8') as string;
  } catch {
    return null;
  }
}

async function readOpenClawIdentityFile(
  accountId: string,
  options?: RuntimeOptions,
): Promise<unknown> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.readOpenClawIdentityFile(accountId, options);
  }
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || '/workspace';
  const filePath = path.join(workspaceDir, accountId, 'IDENTITY.md');
  try {
    // eslint-disable-next-line global-require
    const fsSync = require('fs');
    if (!fsSync.existsSync(filePath)) return null;
    return fsSync.readFileSync(filePath, 'utf8') as string;
  } catch {
    return null;
  }
}

async function writeWorkspaceIdentityFile(
  accountId: string,
  content: string,
  options?: RuntimeOptions,
): Promise<void> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.writeWorkspaceIdentityFile(accountId, content, options);
  }
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || '/workspace';
  const filePath = path.join(workspaceDir, accountId, 'IDENTITY.md');
  ensureDir(filePath);
  fs.writeFileSync(filePath, content);
  chownPath(filePath);
}

async function ensureWorkspaceIdentityFile(
  accountId: string,
  content: string,
  options?: RuntimeOptions,
): Promise<void> {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8s = require('./agentProvisionerServiceK8s');
    return k8s.ensureWorkspaceIdentityFile(accountId, content, options);
  }
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || '/workspace';
  const filePath = path.join(workspaceDir, accountId, 'IDENTITY.md');
  if (!fs.existsSync(filePath)) {
    await writeWorkspaceIdentityFile(accountId, content, options);
  }
}

function ensureHeartbeatTemplate(accountId: string, heartbeat: HeartbeatConfig): void {
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || '/workspace';
  const filePath = path.join(workspaceDir, accountId, 'HEARTBEAT.md');
  if (!fs.existsSync(filePath) && heartbeat?.prompt?.length) {
    ensureDir(filePath);
    fs.writeFileSync(filePath, heartbeat.prompt.join('\n'));
    chownPath(filePath);
  }
}

// ─── Docker-specific functions ────────────────────────────────────────────────

function resolveDockerServiceName(runtimeType: RuntimeType): string {
  const map: Record<string, string> = {
    moltbot: 'clawdbot-gateway',
    internal: 'backend',
  };
  return map[runtimeType] || runtimeType;
}

async function execDockerCommand(
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { stdout, stderr } = await execFileAsync('docker', args, {
    timeout: options?.timeout || 30000,
    maxBuffer: options?.maxBuffer || 1024 * 1024,
  });
  return { stdout: stdout as string, stderr: stderr as string, command: `docker ${args.join(' ')}` };
}

async function execDockerRuntimeCommand(
  runtimeType: RuntimeType,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const service = resolveDockerServiceName(runtimeType);
  const result = await execDockerCommand(['compose', '-p', service, ...args], options);
  return { ...result, service };
}

async function startDockerRuntime(runtimeType: RuntimeType): Promise<ExecCommandResult> {
  const service = resolveDockerServiceName(runtimeType);
  return execDockerCommand(['compose', '-p', service, 'up', '-d']);
}

async function stopDockerRuntime(runtimeType: RuntimeType): Promise<ExecCommandResult> {
  const service = resolveDockerServiceName(runtimeType);
  return execDockerCommand(['compose', '-p', service, 'down']);
}

async function restartDockerRuntime(runtimeType: RuntimeType): Promise<ExecCommandResult> {
  const service = resolveDockerServiceName(runtimeType);
  return execDockerCommand(['compose', '-p', service, 'restart']);
}

async function getDockerRuntimeStatus(runtimeType: RuntimeType): Promise<unknown> {
  const service = resolveDockerServiceName(runtimeType);
  try {
    const result = await execDockerCommand(['compose', '-p', service, 'ps', '--format', 'json']);
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function getDockerRuntimeLogs(runtimeType: RuntimeType, lines = 100): Promise<string> {
  const service = resolveDockerServiceName(runtimeType);
  try {
    const result = await execDockerCommand(['compose', '-p', service, 'logs', `--tail=${lines}`]);
    return result.stdout;
  } catch {
    return '';
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  provisionAgentRuntime,
  getOpenClawConfigPath,
  getCommonlyBotConfigPath,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  startDockerRuntime,
  stopDockerRuntime,
  restartDockerRuntime,
  getDockerRuntimeStatus,
  getDockerRuntimeLogs,
  resolveDockerServiceName,
  execDockerRuntimeCommand,
  execDockerCommand,
  listOpenClawPlugins,
  listOpenClawBundledSkills,
  installOpenClawPlugin,
  writeOpenClawHeartbeatFile,
  readOpenClawHeartbeatFile,
  readOpenClawIdentityFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
  syncOpenClawSkills,
  syncOpenClawSkillEnv,
  getGatewaySkillEntries,
  syncGatewaySkillEnv,
  getAgentSessionSizes,
  clearAgentRuntimeSessions,
  ensureHeartbeatTemplate,
  resolveOpenClawAccountId,
  isK8sMode,
  // internal helpers exported for testing
  readJsonFile,
  writeJsonFile,
  ensureDir,
  chownPath,
  getOpenClawWorkspaceOwnership,
};
