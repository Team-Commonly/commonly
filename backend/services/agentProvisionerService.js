const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const JSON5 = require('json5');
const PodAsset = require('../models/PodAsset');
const PodAssetService = require('./podAssetService');

const execFileAsync = promisify(execFile);

const getOpenClawWorkspaceOwnership = () => {
  const uidRaw = process.env.OPENCLAW_WORKSPACE_UID || process.env.CLAWDBOT_WORKSPACE_UID;
  const gidRaw = process.env.OPENCLAW_WORKSPACE_GID || process.env.CLAWDBOT_WORKSPACE_GID;
  const uid = Number.parseInt(uidRaw, 10);
  const gid = Number.parseInt(gidRaw, 10);
  return {
    uid: Number.isFinite(uid) ? uid : 1000,
    gid: Number.isFinite(gid) ? gid : 1000,
  };
};

const chownPath = (targetPath) => {
  const { uid, gid } = getOpenClawWorkspaceOwnership();
  try {
    fs.chownSync(targetPath, uid, gid);
  } catch (error) {
    if (error?.code !== 'EPERM') {
      console.warn('[agent-provisioner] Failed to chown path:', error.message);
    }
  }
};

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  chownPath(dir);
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
  chownPath(filePath);
};

const DEFAULT_HEARTBEAT_CONTENT = [
  '# HEARTBEAT.md',
  '- Use the `commonly` skill to fetch pod context (`/api/pods/:id/context`), last 20 chat messages, and 10 most recent posts.',
  '- If there is something new, post a concise update to the pod chat and reply to relevant posts/threads.',
  '- Log short-term notes in memory/YYYY-MM-DD.md with message/post ids. Promote durable, agent-specific notes to MEMORY.md.',
  '- If nothing new, reply HEARTBEAT_OK.',
  '',
].join('\n');

const isHeartbeatContentEffectivelyEmpty = (content = '') => {
  if (!content) return true;
  const lines = String(content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return true;
  const actionable = lines.filter((line) => {
    if (!line) return false;
    if (line.startsWith('#')) return false;
    if (line.startsWith('//')) return false;
    if (line.startsWith('<!--')) return false;
    if (line.startsWith('>')) return false;
    if (line.startsWith('-') || line.startsWith('*') || line.startsWith('+')) {
      return line.replace(/^[-*+]\s*/, '').trim().length > 0;
    }
    return true;
  });
  return actionable.length === 0;
};

const normalizeHeartbeatContent = (content) => {
  const trimmed = String(content || '').trim();
  if (!trimmed) return DEFAULT_HEARTBEAT_CONTENT;
  if (trimmed.startsWith('#')) {
    return `${trimmed}\n`;
  }
  return `# HEARTBEAT.md\n\n${trimmed}\n`;
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

const writeOpenClawHeartbeatFile = (accountId, content, { allowEmpty = true } = {}) => {
  const workspacePath = resolveOpenClawWorkspacePath(accountId);
  const heartbeatPath = path.join(workspacePath, 'HEARTBEAT.md');
  ensureDir(heartbeatPath);
  const normalized = allowEmpty ? String(content || '') : normalizeHeartbeatContent(content);
  fs.writeFileSync(heartbeatPath, normalized.endsWith('\n') ? normalized : `${normalized}\n`);
  chownPath(heartbeatPath);
  return heartbeatPath;
};

const clearOpenClawSkillsDir = (accountId) => {
  const workspacePath = resolveOpenClawWorkspacePath(accountId);
  const skillsDir = path.join(workspacePath, 'skills');
  try {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  } catch (error) {
    console.warn('[agent-provisioner] Failed clearing skills dir:', error.message);
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  chownPath(skillsDir);
  return skillsDir;
};

const syncOpenClawSkills = async ({
  accountId,
  podIds = [],
  mode = 'all',
  skillNames = [],
}) => {
  const skillsDir = clearOpenClawSkillsDir(accountId);
  const normalizedPods = Array.isArray(podIds)
    ? podIds.map((id) => String(id)).filter(Boolean)
    : [];
  if (!normalizedPods.length) return skillsDir;

  const query = {
    podId: { $in: normalizedPods },
    type: 'skill',
    status: 'active',
    sourceType: 'imported-skill',
  };
  const normalizedSkillNames = Array.isArray(skillNames)
    ? skillNames.map((name) => String(name).trim()).filter(Boolean)
    : [];
  if (mode === 'selected' && normalizedSkillNames.length) {
    query['metadata.skillName'] = { $in: normalizedSkillNames };
  }

  const assets = await PodAsset.find(query).lean();

  const ensureDirWithMode = (dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
    chownPath(dirPath);
    try {
      fs.chmodSync(dirPath, 0o755);
    } catch (error) {
      console.warn('[agent-provisioner] Failed to chmod dir:', error.message);
    }
  };

  const setFileMode = (filePath) => {
    const lower = filePath.toLowerCase();
    const isScript = lower.includes(`${path.sep}scripts${path.sep}`)
      || lower.endsWith('.py')
      || lower.endsWith('.sh')
      || lower.endsWith('.bash');
    const mode = isScript ? 0o755 : 0o644;
    try {
      fs.chmodSync(filePath, mode);
    } catch (error) {
      console.warn('[agent-provisioner] Failed to chmod file:', error.message);
    }
    chownPath(filePath);
  };
  assets.forEach((asset) => {
    const skillName = asset?.metadata?.skillName || asset?.title?.replace(/^Skill:\s*/i, '') || '';
    if (!skillName) return;
    const slug = PodAssetService.normalizeSkillKey(skillName);
    const dirPath = path.join(skillsDir, slug);
    ensureDirWithMode(dirPath);
    const filePath = path.join(dirPath, 'SKILL.md');
    const content = asset?.content || '';
    fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
    setFileMode(filePath);

    const extraFiles = Array.isArray(asset?.metadata?.extraFiles)
      ? asset.metadata.extraFiles
      : [];
    extraFiles.forEach((file) => {
      const relPath = String(file?.path || '').trim();
      const fileContent = file?.content;
      if (!relPath || typeof fileContent !== 'string') return;
      const targetPath = path.join(dirPath, relPath);
      ensureDirWithMode(path.dirname(targetPath));
      fs.writeFileSync(targetPath, fileContent);
      setFileMode(targetPath);
    });
  });

  return skillsDir;
};

const normalizeSkillEnvMap = (env) => {
  if (!env || typeof env !== 'object') return null;
  const entries = Object.entries(env)
    .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
    .filter(([key, value]) => key && value);
  if (!entries.length) return null;
  return Object.fromEntries(entries);
};

const normalizeSkillApiKey = (value) => {
  const next = String(value ?? '').trim();
  return next ? next : null;
};

const syncOpenClawSkillEnv = ({ skillEnv = {}, configPath: overridePath } = {}) => {
  if (!skillEnv || typeof skillEnv !== 'object') return null;
  const configPath = overridePath || getOpenClawConfigPath();
  const config = readJsonFile(configPath, {});
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};

  Object.entries(skillEnv).forEach(([skillName, entry]) => {
    const skillKey = PodAssetService.normalizeSkillKey(skillName);
    const hasEnvProp = entry && typeof entry === 'object'
      ? Object.prototype.hasOwnProperty.call(entry, 'env')
      : false;
    const hasApiKeyProp = entry && typeof entry === 'object'
      ? Object.prototype.hasOwnProperty.call(entry, 'apiKey')
      : false;
    const hasRawFlag = entry && typeof entry === 'object'
      ? Object.prototype.hasOwnProperty.call(entry, '__raw') && entry.__raw === true
      : false;
    const isRawEntry = entry && typeof entry === 'object' && (!hasEnvProp && !hasApiKeyProp);
    const env = entry && typeof entry === 'object' && hasEnvProp ? entry.env : entry;
    const apiKey = entry && typeof entry === 'object' ? entry.apiKey : null;
    const rawEntry = isRawEntry
      ? Object.fromEntries(
        Object.entries(entry)
          .map(([key, value]) => [String(key || '').trim(), value])
          .filter(([key]) => key),
      )
      : null;
    const normalizedEnv = normalizeSkillEnvMap(env);
    const normalizedApiKey = normalizeSkillApiKey(apiKey);
    if (!normalizedEnv && !normalizedApiKey && (!rawEntry || !Object.keys(rawEntry).length)) {
      if (config.skills.entries[skillKey]) {
        delete config.skills.entries[skillKey].env;
        if (hasApiKeyProp) {
          delete config.skills.entries[skillKey].apiKey;
        }
        if (!Object.keys(config.skills.entries[skillKey]).length) {
          delete config.skills.entries[skillKey];
        }
      }
      return;
    }
    if (hasRawFlag) {
      const cleaned = Object.fromEntries(
        Object.entries(entry || {})
          .filter(([key]) => key && key !== '__raw')
          .map(([key, value]) => [String(key || '').trim(), value]),
      );
      if (!Object.keys(cleaned).length) {
        delete config.skills.entries[skillKey];
        return;
      }
      config.skills.entries[skillKey] = cleaned;
      return;
    }
    if (rawEntry && Object.keys(rawEntry).length) {
      config.skills.entries[skillKey] = rawEntry;
      return;
    }
    config.skills.entries[skillKey] = {
      ...(config.skills.entries[skillKey] || {}),
      ...(normalizedEnv ? { env: normalizedEnv } : {}),
      ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    };
    if (hasApiKeyProp && !normalizedApiKey) {
      delete config.skills.entries[skillKey].apiKey;
    }
  });

  writeJsonFile(configPath, config);
  return configPath;
};

const ensureHeartbeatTemplate = (accountId, heartbeat) => {
  if (!heartbeat || heartbeat.enabled === false) return null;
  const workspacePath = resolveOpenClawWorkspacePath(accountId);
  const heartbeatPath = path.join(workspacePath, 'HEARTBEAT.md');
  let content = '';
  try {
    if (fs.existsSync(heartbeatPath)) {
      content = fs.readFileSync(heartbeatPath, 'utf8');
    }
  } catch (error) {
    console.warn('[agent-provisioner] Failed to read HEARTBEAT.md:', error.message);
  }
  if (!content || isHeartbeatContentEffectivelyEmpty(content)) {
    const normalized = normalizeHeartbeatContent(DEFAULT_HEARTBEAT_CONTENT);
    ensureDir(heartbeatPath);
    fs.writeFileSync(heartbeatPath, normalized);
    chownPath(heartbeatPath);
    return heartbeatPath;
  }
  return heartbeatPath;
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
  authProfiles,
}) => {
  const configPath = getOpenClawConfigPath();
  const config = readJsonFile(configPath, {});

  config.channels = config.channels || {};
  config.channels.commonly = config.channels.commonly || {};
  config.channels.commonly.enabled = true;
  config.channels.commonly.baseUrl = config.channels.commonly.baseUrl || baseUrl;
  config.channels.commonly.accounts = config.channels.commonly.accounts || {};

  const existingAccount = config.channels.commonly.accounts[accountId] || {};
  const resolvedRuntimeToken = runtimeToken || existingAccount.runtimeToken;
  const resolvedUserToken = userToken || existingAccount.userToken;
  if (!resolvedRuntimeToken) {
    throw new Error('Missing runtime token for OpenClaw account provisioning');
  }

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
    runtimeToken: resolvedRuntimeToken,
    userToken: resolvedUserToken,
    agentName,
    instanceId,
    ...(authProfiles ? { authProfiles } : {}),
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
      every: every || '30m', // 30 min default (matches OpenClaw default)
      prompt: payload.prompt || undefined,
      target: payload.target || 'commonly', // Default to Commonly for Commonly-installed agents
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
  ensureHeartbeatTemplate(accountId, heartbeat);

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

const provisionAgentRuntime = async ({
  runtimeType,
  agentName,
  instanceId,
  runtimeToken,
  userToken,
  baseUrl,
  displayName,
  heartbeat,
  authProfiles,
  skillEnv,
}) => {
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
      authProfiles,
      skillEnv,
    });
  }

  // Docker mode (existing file-based logic)
  if (runtimeType === 'moltbot') {
    const accountId = resolveOpenClawAccountId({ agentName, instanceId });
    const result = provisionOpenClawAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
      baseUrl,
      displayName,
      heartbeat,
      authProfiles,
    });
    if (skillEnv) {
      syncOpenClawSkillEnv({ skillEnv, configPath: getOpenClawConfigPath() });
    }
    return result;
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

// Kubernetes mode detection
const isK8sMode = () => process.env.AGENT_PROVISIONER_K8S === '1';

// Unified interface that routes to K8s or Docker implementation
const startAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.startAgentRuntime(runtimeType, instanceId, options);
  }
  return startDockerRuntime(runtimeType);
};

const stopAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.stopAgentRuntime(runtimeType, instanceId, options);
  }
  return stopDockerRuntime(runtimeType);
};

const restartAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.restartAgentRuntime(runtimeType, instanceId, options);
  }
  return restartDockerRuntime(runtimeType);
};

const getAgentRuntimeStatus = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.getAgentRuntimeStatus(runtimeType, instanceId, options);
  }
  return getDockerRuntimeStatus(runtimeType);
};

const getAgentRuntimeLogs = async (runtimeType, instanceId, lines = 200, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.getAgentRuntimeLogs(runtimeType, instanceId, lines, options);
  }
  return getDockerRuntimeLogs(runtimeType, lines);
};

// Export unified interface
module.exports = {
  // Core provisioning (works in both modes)
  provisionAgentRuntime,
  getOpenClawConfigPath,
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
  execDockerRuntimeCommand,
  listOpenClawPlugins,
  installOpenClawPlugin,
  writeOpenClawHeartbeatFile,
  ensureHeartbeatTemplate,
  syncOpenClawSkills,
  syncOpenClawSkillEnv,

  // Mode detection
  isK8sMode,
};
