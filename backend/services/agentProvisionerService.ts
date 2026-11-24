export {};

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const JSON5 = require('json5');

const execFileAsync = promisify(execFile);

// The commonly-bot container reads its runtime.json as uid/gid 1000 unless the
// env says otherwise (the env names are inherited from the retired OpenClaw
// workspace).
const getOpenClawWorkspaceOwnership = () => {
  const uidRaw = process.env.OPENCLAW_WORKSPACE_UID || process.env.CLAWDBOT_WORKSPACE_UID;
  const gidRaw = process.env.OPENCLAW_WORKSPACE_GID || process.env.CLAWDBOT_WORKSPACE_GID;
  const uid = Number.parseInt((uidRaw as string), 10);
  const gid = Number.parseInt((gidRaw as string), 10);
  return {
    uid: Number.isFinite(uid) ? uid : 1000,
    gid: Number.isFinite(gid) ? gid : 1000,
  };
};

const chownPath = (targetPath: any) => {
  const { uid, gid } = getOpenClawWorkspaceOwnership();
  try {
    fs.chownSync(targetPath, uid, gid);
  } catch (error: any) {
    if (error?.code !== 'EPERM') {
      console.warn('[agent-provisioner] Failed to chown path:', (error as Error).message);
    }
  }
};

const ensureDir = (filePath: any) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  chownPath(dir);
};

const readJsonFile = (filePath: any, fallback: any) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON5.parse(raw);
  } catch (error: any) {
    console.warn(`[agent-provisioner] Failed to parse ${filePath}:`, (error as Error).message);
    return fallback;
  }
};

const writeJsonFile = (filePath: any, payload: any) => {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  chownPath(filePath);
};

const getCommonlyBotConfigPath = () => (
  process.env.COMMONLY_BOT_CONFIG_PATH
  || path.resolve(__dirname, '../../external/commonly-bot-state/runtime.json')
);

const provisionCommonlyBotAccount = ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
}: any) => {
  const configPath = getCommonlyBotConfigPath();
  const config = readJsonFile(configPath, { accounts: {} });
  config.accounts = config.accounts || {};
  // A stored token is a hash, so an existing one is reissued without a bearer;
  // keep the saved one.
  const existing = config.accounts[accountId] || {};
  config.accounts[accountId] = {
    runtimeToken: runtimeToken || existing.runtimeToken || null,
    userToken: userToken || existing.userToken || null,
    agentName,
    instanceId,
  };

  writeJsonFile(configPath, config);

  return {
    configPath,
    accountId,
    restartRequired: false,
  };
};

// The runtimes a provision hands a token to, here and in the K8s provisioner.
// Any other seat runs outside Commonly and keeps the token it was given.
// The runtimes a provision hands a token to, here and in the K8s provisioner.
// Any other seat runs outside Commonly and keeps the token it was given.
// 'moltbot' stays although that runtime is retired: reprovision skips a stored
// moltbot row as runtime_retired only after this set says it receives a token,
// so dropping it would relabel those rows keeps_its_own_token.
const RUNTIMES_RECEIVING_TOKENS = new Set(['moltbot', 'internal']);
const runtimeReceivesToken = (runtimeType: any) => (
  RUNTIMES_RECEIVING_TOKENS.has(String(runtimeType || '').trim().toLowerCase())
);

const provisionAgentRuntime = async ({
  runtimeType,
  agentName,
  instanceId,
  runtimeToken,
  userToken,
  baseUrl,
  displayName,
  heartbeat,
}: any) => {
  // Route to K8s or Docker implementation
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.provisionAgentRuntime({
      runtimeType,
      agentName,
      instanceId,
      runtimeToken,
      userToken,
      baseUrl,
      displayName,
      heartbeat,
    });
  }

  // Docker mode (file-based)
  if (runtimeType === 'internal') {
    return provisionCommonlyBotAccount({
      accountId: instanceId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
    });
  }

  // External runtimes — no process to provision; agent manages its own compute
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { provisioned: true, external: true, runtimeType };
  }

  if (runtimeType === 'native') {
    // Native agents run in-process via nativeRuntimeService. Nothing to
    // provision externally — no pod spin, no gateway account, no token
    // issuance. The loop kicks in on the next event dispatched to this
    // installation.
    return { provisioned: true, runtimeType: 'native', inProcess: true };
  }

  if (runtimeType === 'managed-agents') {
    // Delegate to the managed-agents adapter for provisioning. Mirrors the
    // branch in agentProvisionerServiceK8s.ts so that both Docker and K8s
    // provisioners surface the same typed error if a caller tries to use
    // managed-agents before the adapter's provision flow is wired up.
    //
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { isManagedAgentsAvailable, ManagedAgentsError } = require('./managedAgentsAdapter');
    if (!isManagedAgentsAvailable()) {
      throw new ManagedAgentsError(
        'Cannot provision managed-agents runtime: ANTHROPIC_API_KEY is missing or set to placeholder. '
        + 'Land a real key in GCP Secret Manager and restart the backend pod.',
        'not_configured',
      );
    }
    throw new ManagedAgentsError(
      'managed-agents runtime adapter is scaffolded but provision flow is not yet implemented. Track B follow-up.',
      'not_configured',
    );
  }

  throw new Error(`Provisioning not supported for runtime: ${runtimeType}`);
};

const isDockerProvisioningEnabled = () => process.env.AGENT_PROVISIONER_DOCKER === '1';

const getComposeFile = () => (
  process.env.AGENT_PROVISIONER_DOCKER_COMPOSE_FILE
  || path.resolve(__dirname, '../../docker-compose.dev.yml')
);

const buildComposeCommand = (args: any) => {
  const composeBin = process.env.DOCKER_COMPOSE_BIN;
  if (composeBin) {
    return { bin: composeBin, args };
  }
  const bin = process.env.DOCKER_BIN || 'docker';
  return { bin, args: ['compose', ...args] };
};

const getDockerBin = () => process.env.DOCKER_BIN || 'docker';

const execDockerCommand = async (args: any, options = {}) => {
  const bin = getDockerBin();
  const result = await execFileAsync(bin, args, {
    timeout: (options as any).timeout ?? 120000,
    maxBuffer: (options as any).maxBuffer ?? 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: `${bin} ${args.join(' ')}`,
  };
};

const resolveContainerName = (runtimeType: any) => {
  if (runtimeType === 'internal') return 'commonly-bot-dev';
  return null;
};

const dockerContainerExists = async (containerName: any) => {
  if (!containerName) return false;
  try {
    const result = await execDockerCommand([
      'ps',
      '-a',
      '--filter',
      `name=^/${containerName}$`,
      '--format',
      '{{.ID}}',
    ], { timeout: 10000 });
    return Boolean(result.stdout.trim());
  } catch (error: any) {
    return false;
  }
};

const resolveDockerServiceName = (runtimeType: any) => {
  if (runtimeType === 'internal') return 'commonly-bot';
  return null;
};

const startDockerRuntime = async (runtimeType: any) => {
  if (!isDockerProvisioningEnabled()) {
    return { started: false, reason: 'docker provisioning disabled' };
  }

  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(['start', containerName], { timeout: 30_000 });
    return { started: true, command: result.command, container: containerName };
  }

  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { started: false, reason: `unsupported runtime: ${runtimeType}` };
  }
  const args = ['-f', getComposeFile(), 'up', '-d', serviceName];

  const command = buildComposeCommand(args);
  await execFileAsync(command.bin, command.args, { timeout: 60_000 });
  return { started: true, command: `${command.bin} ${command.args.join(' ')}` };
};

const stopDockerRuntime = async (runtimeType: any) => {
  if (!isDockerProvisioningEnabled()) {
    return { stopped: false, reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(['stop', containerName], { timeout: 30_000 });
    return { stopped: true, command: result.command, container: containerName };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { stopped: false, reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'stop', serviceName];
  const command = buildComposeCommand(args);
  await execFileAsync(command.bin, command.args, { timeout: 60_000 });
  return { stopped: true, command: `${command.bin} ${command.args.join(' ')}` };
};

const restartDockerRuntime = async (runtimeType: any) => {
  if (!isDockerProvisioningEnabled()) {
    return { restarted: false, reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(['restart', containerName], { timeout: 30_000 });
    return { restarted: true, command: result.command, container: containerName };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { restarted: false, reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'restart', serviceName];
  const command = buildComposeCommand(args);
  await execFileAsync(command.bin, command.args, { timeout: 60_000 });
  return { restarted: true, command: `${command.bin} ${command.args.join(' ')}` };
};

const getDockerRuntimeStatus = async (runtimeType: any) => {
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { status: 'external', reason: 'agent manages its own compute' };
  }
  if (!isDockerProvisioningEnabled()) {
    return { status: 'disabled', reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand([
      'inspect',
      '-f',
      '{{.State.Status}}',
      containerName,
    ], { timeout: 10_000 });
    return {
      status: result.stdout.trim() || 'unknown',
      service: containerName,
    };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { status: 'unknown', reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'ps', '--format', 'json', serviceName];
  const command = buildComposeCommand(args);
  const result = await execFileAsync(command.bin, command.args, { timeout: 20_000 });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch (error: any) {
    parsed = [];
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry) {
    return { status: 'stopped', service: serviceName };
  }
  return {
    status: entry.State || entry.Status || 'unknown',
    service: serviceName,
    containerId: entry.ID,
    name: entry.Name,
  };
};

const getDockerRuntimeLogs = async (runtimeType: any, lines = 200) => {
  if (!isDockerProvisioningEnabled()) {
    return { logs: '', reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(
      ['logs', '--tail', String(lines), containerName],
      { timeout: 20_000 },
    );
    return { logs: result.stdout || '', service: containerName };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { logs: '', reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'logs', '--no-color', '--tail', String(lines), serviceName];
  const command = buildComposeCommand(args);
  const result = await execFileAsync(command.bin, command.args, { timeout: 20_000 });
  return { logs: result.stdout || '', service: serviceName };
};

// Kubernetes mode detection
const isK8sMode = () => process.env.AGENT_PROVISIONER_K8S === '1';

// Unified interface that routes to K8s or Docker implementation
const startAgentRuntime = async (runtimeType: any, instanceId: any) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.startAgentRuntime(runtimeType, instanceId);
  }
  return startDockerRuntime(runtimeType);
};

const stopAgentRuntime = async (runtimeType: any, instanceId: any) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.stopAgentRuntime(runtimeType, instanceId);
  }
  return stopDockerRuntime(runtimeType);
};

const restartAgentRuntime = async (runtimeType: any, instanceId: any) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.restartAgentRuntime(runtimeType, instanceId);
  }
  return restartDockerRuntime(runtimeType);
};

const getAgentRuntimeStatus = async (runtimeType: any, instanceId: any) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.getAgentRuntimeStatus(runtimeType, instanceId);
  }
  return getDockerRuntimeStatus(runtimeType);
};

const getAgentRuntimeLogs = async (runtimeType: any, instanceId: any, lines = 200) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.getAgentRuntimeLogs(runtimeType, instanceId, lines);
  }
  return getDockerRuntimeLogs(runtimeType, lines);
};

// Export unified interface
module.exports = {
  // Core provisioning (works in both modes)
  provisionAgentRuntime,
  runtimeReceivesToken,
  getCommonlyBotConfigPath,

  // Unified runtime control (auto-routes to K8s or Docker)
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,

  // Docker-specific exports (deprecated, use unified interface)
  startDockerRuntime,
  stopDockerRuntime,
  restartDockerRuntime,
  getDockerRuntimeStatus,
  getDockerRuntimeLogs,
  resolveDockerServiceName,

  // Mode detection
  isK8sMode,
};
