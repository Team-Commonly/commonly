/**
 * commonly dev <subcommand>
 *
 * up        — start local Commonly instance (wraps ./dev.sh up)
 * clawdbot  — bootstrap local OpenClaw runtime state for docker-compose
 * down      — stop local instance
 * logs      — tail local instance logs
 * test      — run backend tests
 *
 * Sets --instance http://localhost:5000 automatically after `dev up`.
 */

import { randomBytes } from 'crypto';
import { spawnSync, spawn } from 'child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { saveInstance, getToken, LOCAL_URL } from '../lib/config.js';
import { createClient, login as apiLogin } from '../lib/api.js';

const CLAWDBOT_AGENT_NAME = 'openclaw';
const CLAWDBOT_DEFAULT_INSTANCE_ID = 'local';
const CLAWDBOT_DEFAULT_DISPLAY_NAME = 'Local OpenClaw';
const CLAWDBOT_DEFAULT_POD_NAME = 'Local OpenClaw Sandbox';
const CLAWDBOT_CONFIG_RELATIVE_PATH = join('external', 'clawdbot-state', 'config', 'moltbot.json');
const LOCAL_ENV_FILE = '.env';
const LOCAL_ENV_EXAMPLE_FILE = '.env.example';
const LOCAL_LOGIN_DEFAULTS = {
  email: 'dev@commonly.local',
  password: 'password123',
  username: 'localdev',
};
const CLAWDBOT_INSTALL_SCOPES = [
  'context:read',
  'messages:read',
  'messages:write',
  'memory:read',
  'memory:write',
];
const CLAWDBOT_USER_TOKEN_SCOPES = [
  'agent:events:read',
  'agent:events:ack',
  'agent:context:read',
  'agent:messages:read',
  'agent:messages:write',
];
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

const findDevSh = (startDir = process.cwd()) => {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'dev.sh');
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const findRepoRoot = (startDir = process.cwd()) => {
  const devSh = findDevSh(startDir);
  return devSh ? dirname(devSh) : null;
};

const runDevSh = (args, opts = {}) => {
  const devSh = findDevSh();
  if (!devSh) {
    console.error('dev.sh not found — run this command from within the commonly repo');
    process.exit(1);
  }

  const spawnOpts = {
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  };

  if (opts.stream) {
    return spawn('bash', [devSh, ...args], spawnOpts);
  }

  return spawnSync('bash', [devSh, ...args], spawnOpts);
};

export const isTruthyEnvValue = (value) => TRUTHY_ENV_VALUES.has(String(value || '').trim().toLowerCase());

const normalizeEnvValue = (rawValue) => {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
};

const ENV_ASSIGNMENT_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

const parseEnvEntries = (content = '') => {
  const entries = new Map();
  content.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(ENV_ASSIGNMENT_RE);
    if (!match) return;
    entries.set(match[1], {
      index,
      value: normalizeEnvValue(match[2]),
    });
  });
  return entries;
};

export const upsertEnvFileValues = (content = '', updates = {}) => {
  const lines = content ? content.split(/\r?\n/) : [];
  const entries = parseEnvEntries(content);

  Object.entries(updates).forEach(([key, value]) => {
    const rendered = `${key}=${value}`;
    if (entries.has(key)) {
      lines[entries.get(key).index] = rendered;
    } else {
      lines.push(rendered);
    }
  });

  const compacted = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');

  return compacted || '\n';
};

const ensureRepoEnvFile = (repoRoot) => {
  const envPath = join(repoRoot, LOCAL_ENV_FILE);
  if (existsSync(envPath)) return envPath;

  const examplePath = join(repoRoot, LOCAL_ENV_EXAMPLE_FILE);
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    return envPath;
  }

  writeFileSync(envPath, '', 'utf8');
  return envPath;
};

const readEnvValue = (repoRoot, key) => {
  const envPath = join(repoRoot, LOCAL_ENV_FILE);
  if (!existsSync(envPath)) return '';
  const entries = parseEnvEntries(readFileSync(envPath, 'utf8'));
  return entries.get(key)?.value || '';
};

const writeEnvValues = (repoRoot, updates) => {
  const envPath = ensureRepoEnvFile(repoRoot);
  const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const next = upsertEnvFileValues(current, updates);
  writeFileSync(envPath, next, 'utf8');
  return envPath;
};

const ensureLocalInstanceConfig = () => {
  saveInstance({
    key: 'local',
    url: LOCAL_URL,
    token: getToken('local') || null,
    username: null,
    userId: null,
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForLocalHealth = async ({ timeoutMs = 90000, intervalMs = 3000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${LOCAL_URL}/api/health`);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Local backend did not become healthy at ${LOCAL_URL} within ${Math.round(timeoutMs / 1000)}s`
    + (lastError ? `: ${lastError.message}` : ''),
  );
};

const resolveLocalLoginSettings = (repoRoot) => ({
  email: process.env.LOCAL_DEV_LOGIN_EMAIL
    || readEnvValue(repoRoot, 'LOCAL_DEV_LOGIN_EMAIL')
    || LOCAL_LOGIN_DEFAULTS.email,
  password: process.env.LOCAL_DEV_LOGIN_PASSWORD
    || readEnvValue(repoRoot, 'LOCAL_DEV_LOGIN_PASSWORD')
    || LOCAL_LOGIN_DEFAULTS.password,
  username: process.env.LOCAL_DEV_LOGIN_USERNAME
    || readEnvValue(repoRoot, 'LOCAL_DEV_LOGIN_USERNAME')
    || LOCAL_LOGIN_DEFAULTS.username,
});

const persistLocalLogin = (loginResult) => {
  const token = loginResult.token;
  const userId = loginResult.user?._id || loginResult.user?.id || null;
  const username = loginResult.user?.username || null;
  saveInstance({
    key: 'local',
    url: LOCAL_URL,
    token,
    userId,
    username,
  });
  return token;
};

const ensureLocalAuth = async (repoRoot) => {
  ensureLocalInstanceConfig();

  const existingToken = getToken('local');
  if (existingToken) {
    const probeClient = createClient({ instance: LOCAL_URL, token: existingToken });
    try {
      await probeClient.get('/api/pods');
      return existingToken;
    } catch (error) {
      if (error.status && ![401, 403].includes(error.status)) {
        throw error;
      }
    }
  }

  const credentials = resolveLocalLoginSettings(repoRoot);
  const result = await apiLogin(LOCAL_URL, credentials.email, credentials.password);
  return persistLocalLogin(result);
};

const listPods = async (client) => {
  const data = await client.get('/api/pods');
  return Array.isArray(data) ? data : data.pods || [];
};

const resolveOrCreatePod = async (client, { podId = null, podName = CLAWDBOT_DEFAULT_POD_NAME } = {}) => {
  if (podId) return { podId, created: false, name: null };

  const existingPods = await listPods(client);
  const existing = existingPods.find((pod) => pod?.name === podName);
  if (existing?._id) {
    return { podId: existing._id, created: false, name: existing.name || podName };
  }

  const created = await client.post('/api/pods', {
    name: podName,
    type: 'chat',
  });

  return {
    podId: created._id || created.id,
    created: true,
    name: created.name || podName,
  };
};

const listInstalledAgents = async (client, podId) => {
  const data = await client.get(`/api/registry/pods/${podId}/agents`);
  return Array.isArray(data) ? data : data.agents || [];
};

const ensureOpenClawInstallation = async (client, { podId, instanceId, displayName }) => {
  const agents = await listInstalledAgents(client, podId);
  const existing = agents.find(
    (agent) => agent?.agentName === CLAWDBOT_AGENT_NAME && (agent?.instanceId || 'default') === instanceId,
  );

  if (existing) {
    return { installation: existing, created: false };
  }

  const result = await client.post('/api/registry/install', {
    agentName: CLAWDBOT_AGENT_NAME,
    podId,
    instanceId,
    displayName,
    version: '1.0.0',
    config: {
      runtime: {
        runtimeType: 'moltbot',
      },
    },
    scopes: CLAWDBOT_INSTALL_SCOPES,
  });

  return {
    installation: result.installation || result,
    created: true,
  };
};

const resolveGatewayToken = (repoRoot, explicitToken = null) => (
  explicitToken
  || readEnvValue(repoRoot, 'CLAWDBOT_GATEWAY_TOKEN')
  || `local-clawdbot-${randomBytes(12).toString('hex')}`
);

const mapContainerPathToRepo = (repoRoot, configPath) => {
  if (!configPath) return null;
  if (!isAbsolute(configPath)) return join(repoRoot, configPath);
  if (configPath.startsWith('/app/')) return join(repoRoot, configPath.slice('/app/'.length));
  if (configPath.startsWith('/repo/')) return join(repoRoot, configPath.slice('/repo/'.length));
  return configPath;
};

const resolveClawdbotConfigPath = (repoRoot, configPath = null) => (
  mapContainerPathToRepo(repoRoot, configPath) || join(repoRoot, CLAWDBOT_CONFIG_RELATIVE_PATH)
);

export const patchClawdbotConfig = ({
  config = {},
  accountId,
  podId,
  displayName,
  runtimeToken,
  userToken,
  gatewayToken,
}) => {
  const next = JSON.parse(JSON.stringify(config || {}));

  next.gateway = next.gateway || {};
  next.gateway.mode = next.gateway.mode || 'local';
  next.gateway.bind = next.gateway.bind || 'lan';
  next.gateway.auth = next.gateway.auth || {};
  if (gatewayToken) next.gateway.auth.token = gatewayToken;
  next.gateway.controlUi = next.gateway.controlUi || {};
  const allowedOrigins = Array.isArray(next.gateway.controlUi.allowedOrigins)
    ? next.gateway.controlUi.allowedOrigins.filter(Boolean)
    : [];
  if (allowedOrigins.length === 0) {
    next.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
  }

  next.channels = next.channels || {};
  next.channels.commonly = next.channels.commonly || {};
  next.channels.commonly.enabled = true;
  next.channels.commonly.baseUrl = next.channels.commonly.baseUrl || 'http://backend:5000';
  next.channels.commonly.accounts = next.channels.commonly.accounts || {};
  const existingAccount = next.channels.commonly.accounts[accountId] || {};
  const podIds = Array.isArray(existingAccount.podIds) ? existingAccount.podIds : [];
  next.channels.commonly.accounts[accountId] = {
    ...existingAccount,
    runtimeToken,
    userToken,
    agentName: CLAWDBOT_AGENT_NAME,
    instanceId: accountId,
    podIds: Array.from(new Set([...podIds, podId].filter(Boolean))),
  };

  next.agents = next.agents || {};
  next.agents.list = Array.isArray(next.agents.list) ? next.agents.list : [];
  const agentEntry = next.agents.list.find((agent) => agent?.id === accountId);
  if (agentEntry) {
    if (!agentEntry.name) agentEntry.name = displayName || accountId;
    if (!agentEntry.workspace) agentEntry.workspace = `/home/node/clawd/${accountId}`;
  } else {
    next.agents.list.push({
      id: accountId,
      name: displayName || accountId,
      workspace: `/home/node/clawd/${accountId}`,
    });
  }

  next.bindings = Array.isArray(next.bindings) ? next.bindings : [];
  const hasBinding = next.bindings.some(
    (binding) => binding?.match?.channel === 'commonly' && binding?.match?.accountId === accountId,
  );
  if (!hasBinding) {
    next.bindings.push({
      agentId: accountId,
      match: {
        channel: 'commonly',
        accountId,
      },
    });
  }

  return next;
};

export const bootstrapClawdbotRuntime = async ({
  client,
  repoRoot,
  podId = null,
  podName = CLAWDBOT_DEFAULT_POD_NAME,
  instanceId = CLAWDBOT_DEFAULT_INSTANCE_ID,
  displayName = CLAWDBOT_DEFAULT_DISPLAY_NAME,
  gatewayToken = null,
  force = false,
}) => {
  writeEnvValues(repoRoot, {
    COMMONLY_LOCAL_CLAWDBOT: '1',
    CLAWDBOT_GATEWAY_TOKEN: gatewayToken,
  });

  const pod = await resolveOrCreatePod(client, { podId, podName });
  const install = await ensureOpenClawInstallation(client, {
    podId: pod.podId,
    instanceId,
    displayName,
  });

  let provisionResult = null;
  try {
    provisionResult = await client.post(
      `/api/registry/pods/${pod.podId}/agents/${CLAWDBOT_AGENT_NAME}/provision`,
      {
        instanceId,
        includeUserToken: true,
        force,
        scopes: CLAWDBOT_USER_TOKEN_SCOPES,
      },
    );
  } catch (error) {
    if (!(error.status === 429 && !force)) throw error;
  }

  const runtimeIssued = await client.post(
    `/api/registry/pods/${pod.podId}/agents/${CLAWDBOT_AGENT_NAME}/runtime-tokens`,
    { instanceId, force: true },
  );
  const runtimeToken = runtimeIssued.token;
  if (!runtimeToken) {
    throw new Error('Runtime token was not returned by the runtime-tokens route');
  }

  const userIssued = await client.post(
    `/api/registry/pods/${pod.podId}/agents/${CLAWDBOT_AGENT_NAME}/user-token`,
    {
      instanceId,
      displayName,
      scopes: CLAWDBOT_USER_TOKEN_SCOPES,
    },
  );
  const userToken = userIssued.token;
  if (!userToken) {
    throw new Error('User token was not returned by the user-token route');
  }

  const configPath = resolveClawdbotConfigPath(repoRoot, provisionResult?.configPath);
  if (!existsSync(configPath) && !provisionResult) {
    throw new Error(
      `OpenClaw config not found at ${configPath}. Run with --force after the provision cooldown `
      + 'or clear stale clawdbot state before bootstrapping again.',
    );
  }

  const rawConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf8') || '{}')
    : {};
  const nextConfig = patchClawdbotConfig({
    config: rawConfig,
    accountId: instanceId,
    podId: pod.podId,
    displayName,
    runtimeToken,
    userToken,
    gatewayToken,
  });
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');

  writeEnvValues(repoRoot, {
    COMMONLY_LOCAL_CLAWDBOT: '1',
    CLAWDBOT_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_RUNTIME_TOKEN: runtimeToken,
    OPENCLAW_USER_TOKEN: userToken,
  });

  return {
    podId: pod.podId,
    podCreated: pod.created,
    installationCreated: install.created,
    instanceId,
    displayName,
    gatewayToken,
    runtimeToken,
    userToken,
    configPath,
    provisioned: Boolean(provisionResult),
  };
};

export const registerDev = (program) => {
  const dev = program.command('dev').description('Local development environment');

  dev.addHelpText('after', `
Examples:
  $ commonly dev up                         # Start a local docker-compose stack
  $ commonly dev clawdbot                   # Bootstrap local OpenClaw + start it
  $ commonly dev status                     # Check health
  $ commonly dev logs backend               # Tail backend logs
  $ commonly dev down                       # Stop everything

Login against the local instance with:
  $ commonly login --instance http://localhost:5000
`);

  dev
    .command('up')
    .description('Start local Commonly instance')
    .option('--with-gateway', 'Enable the clawdbot profile for this start', false)
    .action(async (opts) => {
      runDevSh(['up'], {
        env: opts.withGateway ? { COMMONLY_LOCAL_CLAWDBOT: '1' } : undefined,
      });

      ensureLocalInstanceConfig();

      console.log('\nLocal instance ready:');
      console.log('  Frontend: http://localhost:3000');
      console.log('  Backend:  http://localhost:5000');
      console.log('\nLogin to local instance:');
      console.log('  commonly login --instance http://localhost:5000 --key local');
    });

  dev
    .command('clawdbot')
    .description('Bootstrap local OpenClaw gateway config, tokens, and env state')
    .option('--pod <podId>', 'Reuse an existing pod by id')
    .option('--pod-name <name>', 'Create or reuse a local pod by name', CLAWDBOT_DEFAULT_POD_NAME)
    .option('--instance-id <id>', 'OpenClaw instance/account id', CLAWDBOT_DEFAULT_INSTANCE_ID)
    .option('--display <name>', 'Display name for the local OpenClaw agent', CLAWDBOT_DEFAULT_DISPLAY_NAME)
    .option('--gateway-token <token>', 'Reuse an explicit gateway token instead of generating one')
    .option('--force', 'Force reprovision and refresh local gateway state', false)
    .option('--no-start', 'Write config and env only; do not start or restart docker services')
    .action(async (opts) => {
      const repoRoot = findRepoRoot();
      if (!repoRoot) {
        console.error('dev.sh not found — run this command from within the commonly repo');
        process.exit(1);
      }

      const gatewayToken = resolveGatewayToken(repoRoot, opts.gatewayToken);
      writeEnvValues(repoRoot, {
        COMMONLY_LOCAL_CLAWDBOT: '1',
        CLAWDBOT_GATEWAY_TOKEN: gatewayToken,
      });

      if (opts.start) {
        runDevSh(['up'], {
          env: {
            COMMONLY_LOCAL_CLAWDBOT: '1',
            CLAWDBOT_GATEWAY_TOKEN: gatewayToken,
          },
        });
        await waitForLocalHealth();
      }

      ensureLocalInstanceConfig();
      const token = await ensureLocalAuth(repoRoot);
      const client = createClient({ instance: LOCAL_URL, token });

      const result = await bootstrapClawdbotRuntime({
        client,
        repoRoot,
        podId: opts.pod || null,
        podName: opts.podName,
        instanceId: opts.instanceId,
        displayName: opts.display,
        gatewayToken,
        force: opts.force,
      });

      if (opts.start) {
        runDevSh(['clawdbot', 'restart'], {
          env: {
            COMMONLY_LOCAL_CLAWDBOT: '1',
            CLAWDBOT_GATEWAY_TOKEN: gatewayToken,
          },
        });
      }

      console.log('\nLocal OpenClaw bootstrap complete:');
      console.log(`  Pod:       ${result.podId}`);
      console.log(`  Agent:     ${CLAWDBOT_AGENT_NAME}:${result.instanceId}`);
      console.log(`  Config:    ${result.configPath}`);
      console.log(`  Gateway:   ${gatewayToken}`);
      console.log(`  Started:   ${opts.start ? 'yes' : 'no'}`);
      console.log('\nNext:');
      console.log('  ./dev.sh clawdbot logs gateway');
      console.log('  commonly pod tail <podId> --instance local');
    });

  dev
    .command('down')
    .description('Stop local Commonly instance')
    .action(() => {
      runDevSh(['down']);
    });

  dev
    .command('logs [service]')
    .description('Tail logs (backend, frontend, mongo, postgres)')
    .option('--follow', 'Stream logs continuously', true)
    .action((service) => {
      const args = service ? ['logs', service] : ['logs'];
      runDevSh(args, { stream: true });
    });

  dev
    .command('test')
    .description('Run tests')
    .option('--watch', 'Watch mode', false)
    .option('--frontend', 'Frontend tests only', false)
    .option('--backend', 'Backend tests only', false)
    .action((opts) => {
      const devSh = findDevSh();
      if (!devSh) { console.error('dev.sh not found'); process.exit(1); }

      if (!opts.frontend) runDevSh(['test']);
      if (!opts.backend) {
        const dir = join(findDevSh(), '../frontend');
        if (existsSync(dir)) {
          spawnSync('npm', ['test', ...(opts.watch ? [] : ['--', '--watchAll=false'])], {
            cwd: dir,
            stdio: 'inherit',
            shell: true,
          });
        }
      }
    });

  dev
    .command('status')
    .description('Check health of local instance')
    .action(async () => {
      const client = createClient({ instance: LOCAL_URL, token: null });
      try {
        const data = await client.get('/api/health');
        console.log('Local instance: healthy');
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.log('Local instance: not running (start with: commonly dev up)');
      }
    });
};
