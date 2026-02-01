const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const JSON5 = require('json5');

const execFileAsync = promisify(execFile);

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

const readJsonFile = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON5.parse(raw);
  } catch (error) {
    console.warn(`[agent-provisioner] Failed to parse ${filePath}:`, error.message);
    return fallback;
  }
};

const writeJsonFile = (filePath, payload) => {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const resolveOpenClawAccountId = ({ agentName, instanceId }) => {
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const normalizedInstance = String(instanceId || 'default').trim().toLowerCase() || 'default';
  if (normalizedAgent === 'openclaw') {
    return normalizedInstance;
  }
  return `${normalizedAgent}-${normalizedInstance}`;
};

const resolveOpenClawWorkspacePath = (accountId) => {
  const workspaceRoot = (
    process.env.OPENCLAW_WORKSPACE_ROOT
    || process.env.CLAWDBOT_WORKSPACE_DIR
    || '/home/node/clawd'
  ).replace(/\/+$/g, '');
  return `${workspaceRoot}/${accountId}`;
};

const getOpenClawConfigPath = () => (
  process.env.OPENCLAW_CONFIG_PATH
  || path.resolve(__dirname, '../../external/clawdbot-state/config/moltbot.json')
);

const getCommonlyBotConfigPath = () => (
  process.env.COMMONLY_BOT_CONFIG_PATH
  || path.resolve(__dirname, '../../external/commonly-bot-state/runtime.json')
);

const provisionOpenClawAccount = ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
  baseUrl,
  displayName,
  heartbeat,
}) => {
  const configPath = getOpenClawConfigPath();
  const config = readJsonFile(configPath, {});

  config.channels = config.channels || {};
  config.channels.commonly = config.channels.commonly || {};
  config.channels.commonly.enabled = true;
  config.channels.commonly.baseUrl = config.channels.commonly.baseUrl || baseUrl;
  config.channels.commonly.accounts = config.channels.commonly.accounts || {};

  const normalizeKey = (value, fallback) => {
    const normalized = String(value ?? fallback ?? '').trim().toLowerCase();
    return normalized || String(fallback || '').trim().toLowerCase();
  };
  const targetAgent = normalizeKey(agentName, '');
  const targetInstance = normalizeKey(instanceId, 'default');
  const removedAccountIds = [];

  Object.entries(config.channels.commonly.accounts).forEach(([key, entry]) => {
    if (!entry || key === accountId) return;
    const entryAgent = normalizeKey(entry.agentName, '');
    const entryInstance = normalizeKey(entry.instanceId, 'default');
    if (entryAgent === targetAgent && entryInstance === targetInstance) {
      delete config.channels.commonly.accounts[key];
      removedAccountIds.push(key);
    }
  });

  config.channels.commonly.accounts[accountId] = {
    runtimeToken,
    userToken,
    agentName,
    instanceId,
  };

  config.agents = config.agents || {};
  config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];
  if (removedAccountIds.length) {
    config.agents.list = config.agents.list.filter(
      (agent) => !removedAccountIds.includes(agent?.id),
    );
  }
  const desiredWorkspace = resolveOpenClawWorkspacePath(accountId);
  const normalizeHeartbeat = (payload) => {
    if (!payload || payload.enabled === false) return null;
    const minutes = Number(payload.everyMinutes || payload.every || payload.intervalMinutes);
    const every = Number.isFinite(minutes) && minutes > 0 ? `${minutes}m` : payload.every;
    return {
      every: every || '10m',
      prompt: payload.prompt || undefined,
      target: payload.target || 'last',
      session: payload.session || undefined,
    };
  };

  const agentEntry = config.agents.list.find((agent) => agent?.id === accountId);
  const heartbeatConfig = normalizeHeartbeat(heartbeat);
  if (agentEntry) {
    if (!agentEntry.workspace) {
      agentEntry.workspace = desiredWorkspace;
    }
    if (!agentEntry.name) {
      agentEntry.name = displayName || agentName || accountId;
    }
    if (heartbeatConfig) {
      agentEntry.heartbeat = heartbeatConfig;
    } else if (agentEntry.heartbeat) {
      delete agentEntry.heartbeat;
    }
  } else {
    config.agents.list.push({
      id: accountId,
      name: displayName || agentName || accountId,
      workspace: desiredWorkspace,
      ...(heartbeatConfig ? { heartbeat: heartbeatConfig } : {}),
    });
  }

  config.bindings = Array.isArray(config.bindings) ? config.bindings : [];
  if (removedAccountIds.length) {
    config.bindings = config.bindings.filter(
      (binding) => !removedAccountIds.includes(binding?.match?.accountId),
    );
  }
  const bindingExists = config.bindings.some(
    (binding) => binding?.match?.channel === 'commonly' && binding?.match?.accountId === accountId,
  );
  if (!bindingExists) {
    config.bindings.push({
      agentId: accountId,
      match: { channel: 'commonly', accountId },
    });
  }

  writeJsonFile(configPath, config);

  return {
    configPath,
    accountId,
    restartRequired: true,
  };
};

const provisionCommonlyBotAccount = ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
}) => {
  const configPath = getCommonlyBotConfigPath();
  const config = readJsonFile(configPath, { accounts: {} });
  config.accounts = config.accounts || {};
  config.accounts[accountId] = {
    runtimeToken,
    userToken,
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

const provisionAgentRuntime = ({
  runtimeType,
  agentName,
  instanceId,
  runtimeToken,
  userToken,
  baseUrl,
  displayName,
}) => {
  if (runtimeType === 'moltbot') {
    const accountId = resolveOpenClawAccountId({ agentName, instanceId });
    return provisionOpenClawAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
      baseUrl,
      displayName,
    });
  }

  if (runtimeType === 'internal') {
    return provisionCommonlyBotAccount({
      accountId: instanceId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
    });
  }

  throw new Error(`Provisioning not supported for runtime: ${runtimeType}`);
};

const isDockerProvisioningEnabled = () => process.env.AGENT_PROVISIONER_DOCKER === '1';

const getComposeFile = () => (
  process.env.AGENT_PROVISIONER_DOCKER_COMPOSE_FILE
  || path.resolve(__dirname, '../../docker-compose.dev.yml')
);

const buildComposeCommand = (args) => {
  const composeBin = process.env.DOCKER_COMPOSE_BIN;
  if (composeBin) {
    return { bin: composeBin, args };
  }
  const bin = process.env.DOCKER_BIN || 'docker';
  return { bin, args: ['compose', ...args] };
};

const getDockerBin = () => process.env.DOCKER_BIN || 'docker';

const execDockerCommand = async (args, options = {}) => {
  const bin = getDockerBin();
  const result = await execFileAsync(bin, args, {
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: `${bin} ${args.join(' ')}`,
  };
};

const resolveContainerName = (runtimeType) => {
  if (runtimeType === 'moltbot') return 'clawdbot-gateway-dev';
  if (runtimeType === 'internal') return 'commonly-bot-dev';
  return null;
};

const dockerContainerExists = async (containerName) => {
  if (!containerName) return false;
  try {
    const result = await execDockerCommand([
      'ps',
      '-a',
      '--filter',
      `name=^/${containerName}$`,
      '--format',
      '{{.ID}}',
    ], { timeout: 10_000 });
    return Boolean(result.stdout.trim());
  } catch (error) {
    return false;
  }
};

const execDockerRuntimeCommand = async (runtimeType, args, options = {}) => {
  if (!isDockerProvisioningEnabled()) {
    throw new Error('docker provisioning disabled');
  }
  const containerName = resolveContainerName(runtimeType);
  if (!containerName) {
    throw new Error(`unsupported runtime: ${runtimeType}`);
  }
  const result = await execDockerCommand(['exec', '-T', containerName, ...args], options);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: result.command,
    service: containerName,
  };
};

const listOpenClawPlugins = async () => {
  const result = await execDockerRuntimeCommand('moltbot', [
    'node',
    'dist/index.js',
    'plugins',
    'list',
    '--json',
  ], { timeout: 30_000 });
  let payload;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error('Failed to parse OpenClaw plugin list output.');
  }
  return {
    ...payload,
    command: result.command,
    service: result.service,
  };
};

const installOpenClawPlugin = async ({ spec, link = false }) => {
  const args = [
    'node',
    'dist/index.js',
    'plugins',
    'install',
    spec,
  ];
  if (link) {
    args.push('--link');
  }
  return execDockerRuntimeCommand('moltbot', args);
};

const resolveDockerServiceName = (runtimeType) => {
  if (runtimeType === 'moltbot') return 'clawdbot-gateway';
  if (runtimeType === 'internal') return 'commonly-bot';
  return null;
};

const startDockerRuntime = async (runtimeType) => {
  if (!isDockerProvisioningEnabled()) {
    return { started: false, reason: 'docker provisioning disabled' };
  }

  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(['start', containerName], { timeout: 30_000 });
    return { started: true, command: result.command, container: containerName };
  }

  const composeFile = getComposeFile();
  let args = ['-f', composeFile];

  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { started: false, reason: `unsupported runtime: ${runtimeType}` };
  }
  if (runtimeType === 'moltbot') {
    args = args.concat(['--profile', 'clawdbot', 'up', '-d', serviceName]);
  } else {
    args = args.concat(['up', '-d', serviceName]);
  }

  const command = buildComposeCommand(args);
  await execFileAsync(command.bin, command.args, { timeout: 60_000 });
  return { started: true, command: `${command.bin} ${command.args.join(' ')}` };
};

const stopDockerRuntime = async (runtimeType) => {
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

const restartDockerRuntime = async (runtimeType) => {
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

const getDockerRuntimeStatus = async (runtimeType) => {
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
  } catch (error) {
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

const getDockerRuntimeLogs = async (runtimeType, lines = 200) => {
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

module.exports = {
  provisionAgentRuntime,
  getOpenClawConfigPath,
  getCommonlyBotConfigPath,
  startDockerRuntime,
  stopDockerRuntime,
  restartDockerRuntime,
  getDockerRuntimeStatus,
  getDockerRuntimeLogs,
  resolveDockerServiceName,
  execDockerRuntimeCommand,
  listOpenClawPlugins,
  installOpenClawPlugin,
};
