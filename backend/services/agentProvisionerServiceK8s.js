/**
 * Kubernetes-native Agent Provisioner Service
 * Replaces Docker socket mounting with K8s API for agent runtime provisioning
 */

const k8s = require('@kubernetes/client-node');

// Initialize K8s client
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);

const NAMESPACE = process.env.K8S_NAMESPACE || 'commonly';
const BACKEND_SERVICE_URL = process.env.COMMONLY_API_URL || 'http://backend.commonly.svc.cluster.local:5000';
const AGENT_NODE_POOL = String(process.env.AGENT_PROVISIONER_NODE_POOL || '').trim();
const AGENT_NODE_SELECTOR = (() => {
  if (!AGENT_NODE_POOL) return null;
  return { pool: AGENT_NODE_POOL };
})();
const AGENT_TOLERATIONS = (() => {
  if (!AGENT_NODE_POOL) return null;
  return [{
    key: 'pool',
    operator: 'Equal',
    value: AGENT_NODE_POOL,
    effect: 'NoSchedule',
  }];
})();

/**
 * Resolve OpenClaw account ID from agent name and instance ID
 */
const resolveOpenClawAccountId = ({ agentName, instanceId }) => {
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const normalizedInstance = String(instanceId || 'default').trim().toLowerCase() || 'default';
  if (normalizedAgent === 'openclaw') {
    return normalizedInstance;
  }
  return `${normalizedAgent}-${normalizedInstance}`;
};

const normalizeGatewaySlug = (gateway) => {
  const slug = String(gateway?.slug || '').trim().toLowerCase();
  if (!slug) return '';
  return slug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
};

const resolveGatewayDeploymentName = (gateway) => {
  const slug = normalizeGatewaySlug(gateway);
  if (gateway?.mode === 'k8s' && slug) {
    return `gateway-${slug}`;
  }
  return 'clawdbot-gateway';
};

const resolveGatewayConfigMapName = (gateway) => {
  const slug = normalizeGatewaySlug(gateway);
  if (gateway?.mode === 'k8s' && slug) {
    return `gateway-${slug}-config`;
  }
  return 'clawdbot-config';
};

/**
 * Read ConfigMap data
 */
const readConfigMap = async (configMapName, key) => {
  try {
    const response = await k8sApi.readNamespacedConfigMap(configMapName, NAMESPACE);
    const data = response.body.data || {};
    const raw = data[key] || '{}';
    return JSON.parse(raw);
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      console.log(`[k8s-provisioner] ConfigMap ${configMapName} not found, will create`);
      return {};
    }
    throw new Error(`Failed to read ConfigMap ${configMapName}: ${error.message}`);
  }
};

/**
 * Write ConfigMap data
 */
const writeConfigMap = async (configMapName, key, data) => {
  const dataString = JSON.stringify(data, null, 2);
  const configMap = {
    metadata: {
      name: configMapName,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'commonly-backend',
        'app.kubernetes.io/component': 'agent-config',
      },
    },
    data: {
      [key]: dataString,
    },
  };

  try {
    // Try to update existing ConfigMap (requires resourceVersion)
    const existing = await k8sApi.readNamespacedConfigMap(configMapName, NAMESPACE);
    if (existing?.body?.metadata?.resourceVersion) {
      configMap.metadata.resourceVersion = existing.body.metadata.resourceVersion;
    }
    await k8sApi.replaceNamespacedConfigMap(configMapName, NAMESPACE, configMap);
    console.log(`[k8s-provisioner] Updated ConfigMap ${configMapName}`);
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      // Create new ConfigMap
      await k8sApi.createNamespacedConfigMap(NAMESPACE, configMap);
      console.log(`[k8s-provisioner] Created ConfigMap ${configMapName}`);
    } else {
      throw new Error(`Failed to write ConfigMap ${configMapName}: ${error.message}`);
    }
  }
};

/**
 * Provision OpenClaw (moltbot) account in Kubernetes
 */
const provisionOpenClawAccount = async ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
  baseUrl,
  displayName,
  heartbeat,
  authProfiles,
  skillEnv,
  configMapName = 'clawdbot-config',
}) => {
  const configKey = 'moltbot.json';

  // Read existing config
  const config = await readConfigMap(configMapName, configKey);

  // Update config structure (same logic as Docker version)
  config.channels = config.channels || {};
  config.channels.commonly = config.channels.commonly || {};
  config.channels.commonly.enabled = true;
  config.channels.commonly.baseUrl = config.channels.commonly.baseUrl || baseUrl || BACKEND_SERVICE_URL;
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

  // Remove duplicate accounts
  Object.entries(config.channels.commonly.accounts).forEach(([key, entry]) => {
    if (!entry || key === accountId) return;
    const entryAgent = normalizeKey(entry.agentName, '');
    const entryInstance = normalizeKey(entry.instanceId, 'default');
    if (entryAgent === targetAgent && entryInstance === targetInstance) {
      delete config.channels.commonly.accounts[key];
      removedAccountIds.push(key);
    }
  });

  // Add/update account
  config.channels.commonly.accounts[accountId] = {
    runtimeToken: resolvedRuntimeToken,
    userToken: resolvedUserToken,
    agentName,
    instanceId,
    ...(authProfiles ? { authProfiles } : {}),
  };

  if (skillEnv && typeof skillEnv === 'object') {
    config.skills = config.skills || {};
    config.skills.entries = config.skills.entries || {};
    Object.entries(skillEnv).forEach(([skillName, entry]) => {
      if (!entry || typeof entry !== 'object') return;
      config.skills.entries[skillName] = {
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
      };
    });
  }

  // Update agents list
  config.agents = config.agents || {};
  config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];
  if (removedAccountIds.length) {
    config.agents.list = config.agents.list.filter(
      (agent) => !removedAccountIds.includes(agent?.id),
    );
  }

  // Workspace path for K8s
  const desiredWorkspace = `/workspace/${accountId}`;

  const normalizeHeartbeat = (payload) => {
    if (!payload || payload.enabled === false) return null;
    const minutes = Number(payload.everyMinutes || payload.every || payload.intervalMinutes);
    const every = Number.isFinite(minutes) && minutes > 0 ? `${minutes}m` : payload.every;
    return {
      every: every || '30m',
      prompt: payload.prompt || undefined,
      target: payload.target || 'commonly',
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

  // Update bindings
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

  // Write updated config to ConfigMap
  await writeConfigMap(configMapName, configKey, config);

  return {
    configMap: configMapName,
    accountId,
    restartRequired: true,
  };
};

/**
 * Provision Commonly Bot (internal) account in Kubernetes
 */
const provisionCommonlyBotAccount = async ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
}) => {
  const configMapName = 'commonly-bot-config';
  const configKey = 'runtime.json';

  const config = await readConfigMap(configMapName, configKey);
  config.accounts = config.accounts || {};
  config.accounts[accountId] = {
    runtimeToken,
    userToken,
    agentName,
    instanceId,
  };

  await writeConfigMap(configMapName, configKey, config);

  return {
    configMap: configMapName,
    accountId,
    restartRequired: false,
  };
};

/**
 * Build Kubernetes Deployment manifest for agent runtime
 */
const buildAgentDeploymentManifest = ({
  runtimeType,
  accountId,
  agentName,
  instanceId,
}) => {
  const labels = {
    app: `agent-${runtimeType}`,
    'agent-type': runtimeType,
    'agent-name': agentName,
    'agent-instance': instanceId,
    'agent-account': accountId,
  };

  const deploymentName = `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  let containerSpec;
  let volumes = [];

  if (runtimeType === 'moltbot') {
    containerSpec = {
      name: 'clawdbot-gateway',
      image: process.env.CLAWDBOT_IMAGE || 'clawdbot:latest',
      imagePullPolicy: 'IfNotPresent',
      env: [
        { name: 'CLAWDBOT_GATEWAY_PORT', value: '18789' },
        { name: 'CLAWDBOT_BRIDGE_PORT', value: '18790' },
        {
          name: 'CLAWDBOT_GATEWAY_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: 'api-keys',
              key: 'clawdbot-gateway-token',
            },
          },
        },
        { name: 'CLAWDBOT_CONFIG_DIR', value: '/config' },
        { name: 'CLAWDBOT_WORKSPACE_DIR', value: '/workspace' },
        { name: 'COMMONLY_API_URL', value: BACKEND_SERVICE_URL },
      ],
      ports: [
        { containerPort: 18789, name: 'gateway' },
        { containerPort: 18790, name: 'bridge' },
      ],
      volumeMounts: [
        { name: 'clawdbot-config', mountPath: '/config', readOnly: true },
        { name: 'clawdbot-workspace', mountPath: '/workspace' },
      ],
      resources: {
        requests: { memory: '256Mi', cpu: '200m' },
        limits: { memory: '1Gi', cpu: '1000m' },
      },
    };

    volumes = [
      {
        name: 'clawdbot-config',
        configMap: { name: 'clawdbot-config' },
      },
      {
        name: 'clawdbot-workspace',
        persistentVolumeClaim: { claimName: 'clawdbot-workspace-pvc' },
      },
    ];
  } else if (runtimeType === 'internal') {
    containerSpec = {
      name: 'commonly-bot',
      image: 'node:20-alpine',
      imagePullPolicy: 'IfNotPresent',
      workingDir: '/app/external/commonly-agent-services/commonly-bot',
      env: [
        { name: 'COMMONLY_BASE_URL', value: BACKEND_SERVICE_URL },
        {
          name: 'COMMONLY_AGENT_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: 'api-keys',
              key: 'commonly-bot-runtime-token',
            },
          },
        },
        { name: 'COMMONLY_AGENT_POLL_MS', value: '5000' },
        { name: 'NODE_ENV', value: 'production' },
      ],
      volumeMounts: [
        { name: 'agent-services', mountPath: '/app/external/commonly-agent-services', readOnly: true },
        { name: 'commonly-bot-config', mountPath: '/app/config', readOnly: true },
      ],
      command: ['node', 'index.js'],
      resources: {
        requests: { memory: '128Mi', cpu: '100m' },
        limits: { memory: '512Mi', cpu: '500m' },
      },
    };

    volumes = [
      {
        name: 'agent-services',
        emptyDir: {}, // Will be populated by init container or ConfigMap
      },
      {
        name: 'commonly-bot-config',
        configMap: { name: 'commonly-bot-config' },
      },
    ];
  }

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: deploymentName,
      namespace: NAMESPACE,
      labels,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: 'agent-provisioner',
          ...(AGENT_NODE_SELECTOR ? { nodeSelector: AGENT_NODE_SELECTOR } : {}),
          ...(AGENT_TOLERATIONS ? { tolerations: AGENT_TOLERATIONS } : {}),
          containers: [containerSpec],
          volumes,
        },
      },
    },
  };
};

/**
 * Provision agent runtime in Kubernetes
 */
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
  gateway,
}) => {
  console.log(`[k8s-provisioner] Provisioning ${runtimeType} agent: ${agentName}/${instanceId}`);

  let result;
  let accountId;
  let deploymentName = null;

  if (runtimeType === 'moltbot') {
    accountId = resolveOpenClawAccountId({ agentName, instanceId });
    result = await provisionOpenClawAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
      baseUrl,
      displayName,
      heartbeat,
      authProfiles,
      skillEnv,
      configMapName: resolveGatewayConfigMapName(gateway),
    });
    // Use the shared clawdbot gateway deployment (no per-agent runtime pods).
    deploymentName = resolveGatewayDeploymentName(gateway);
  } else if (runtimeType === 'internal') {
    accountId = instanceId;
    result = await provisionCommonlyBotAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
    });
    deploymentName = `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  } else {
    throw new Error(`Provisioning not supported for runtime: ${runtimeType}`);
  }

  if (runtimeType === 'internal') {
    // Create or update Deployment only for internal runtimes.
    const deployment = buildAgentDeploymentManifest({
      runtimeType,
      accountId,
      agentName,
      instanceId,
    });

    try {
      await k8sAppsApi.readNamespacedDeployment(deployment.metadata.name, NAMESPACE);
      // Deployment exists, update it
      await k8sAppsApi.replaceNamespacedDeployment(deployment.metadata.name, NAMESPACE, deployment);
      console.log(`[k8s-provisioner] Updated Deployment ${deployment.metadata.name}`);
    } catch (error) {
      if (error.response && error.response.statusCode === 404) {
        // Create new Deployment
        await k8sAppsApi.createNamespacedDeployment(NAMESPACE, deployment);
        console.log(`[k8s-provisioner] Created Deployment ${deployment.metadata.name}`);
      } else {
        throw new Error(`Failed to create/update Deployment: ${error.message}`);
      }
    }
  }

  return {
    ...result,
    deployment: deploymentName,
    namespace: NAMESPACE,
    sharedGateway: runtimeType === 'moltbot',
  };
};

const resolveRuntimeDeploymentName = (runtimeType, instanceId, gateway) => {
  if (runtimeType === 'moltbot') {
    return resolveGatewayDeploymentName(gateway);
  }
  const accountId = instanceId;
  return `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
};

/**
 * Start agent runtime (scale to 1 replica)
 */
const startAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    return { started: true, deployment: deploymentName, sharedGateway: true };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    deployment.spec.replicas = 1;
    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Started agent runtime: ${deploymentName}`);
    return { started: true, deployment: deploymentName };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to start ${deploymentName}:`, error.message);
    return { started: false, reason: error.message };
  }
};

/**
 * Stop agent runtime (scale to 0 replicas)
 */
const stopAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    return { stopped: true, deployment: deploymentName, sharedGateway: true };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    deployment.spec.replicas = 0;
    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Stopped agent runtime: ${deploymentName}`);
    return { stopped: true, deployment: deploymentName };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to stop ${deploymentName}:`, error.message);
    return { stopped: false, reason: error.message };
  }
};

/**
 * Restart agent runtime (trigger rolling restart)
 */
const restartAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    // Add restart annotation to trigger rolling restart
    deployment.spec.template.metadata = deployment.spec.template.metadata || {};
    deployment.spec.template.metadata.annotations = deployment.spec.template.metadata.annotations || {};
    deployment.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString();

    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Restarted agent runtime: ${deploymentName}`);
    return { restarted: true, deployment: deploymentName, sharedGateway: runtimeType === 'moltbot' };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to restart ${deploymentName}:`, error.message);
    return { restarted: false, reason: error.message, sharedGateway: runtimeType === 'moltbot' };
  }
};

/**
 * Get agent runtime status
 */
const getAgentRuntimeStatus = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    try {
      const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
      const deployment = response.body;
      const replicas = deployment.spec.replicas || 0;
      const availableReplicas = deployment.status.availableReplicas || 0;
      const readyReplicas = deployment.status.readyReplicas || 0;

      let status = 'unknown';
      if (replicas === 0) status = 'stopped';
      else if (availableReplicas === replicas && readyReplicas === replicas) status = 'running';
      else if (availableReplicas > 0) status = 'starting';
      else status = 'pending';

      return {
        status,
        deployment: deploymentName,
        replicas,
        availableReplicas,
        readyReplicas,
        sharedGateway: true,
      };
    } catch (error) {
      return { status: 'not_found', deployment: deploymentName, sharedGateway: true };
    }
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    const replicas = deployment.spec.replicas || 0;
    const availableReplicas = deployment.status.availableReplicas || 0;
    const readyReplicas = deployment.status.readyReplicas || 0;

    let status = 'unknown';
    if (replicas === 0) {
      status = 'stopped';
    } else if (availableReplicas === replicas && readyReplicas === replicas) {
      status = 'running';
    } else if (availableReplicas > 0) {
      status = 'starting';
    } else {
      status = 'pending';
    }

    return {
      status,
      deployment: deploymentName,
      replicas,
      availableReplicas,
      readyReplicas,
    };
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      return { status: 'not-found', deployment: deploymentName };
    }
    return { status: 'error', reason: error.message };
  }
};

/**
 * Get agent runtime logs
 */
const getDeploymentLogs = async ({ deploymentName, lines, filterTokens = [] }) => {
  try {
    const deploymentResponse = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const matchLabels = deploymentResponse.body?.spec?.selector?.matchLabels || {};
    const labelSelector = Object.entries(matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    const podsResponse = await k8sApi.listNamespacedPod(
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector || undefined,
    );
    const pods = podsResponse.body.items || [];
    if (!pods.length) {
      return { logs: '', reason: 'No pods found for deployment' };
    }
    const pod = pods[0];
    const logsResponse = await k8sApi.readNamespacedPodLog(
      pod.metadata.name,
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lines,
    );
    let logs = logsResponse.body || '';
    const tokens = (filterTokens || []).map((t) => String(t || '').trim()).filter(Boolean);
    if (tokens.length) {
      logs = logs
        .split('\n')
        .filter((line) => {
          if (!line) return false;
          if (tokens.some((token) => line.includes(`[commonly] [${token}]`))) return true;
          if (tokens.some((token) => line.includes(token))) return true;
          return false;
        })
        .join('\n');
    }
    return { logs, pod: pod.metadata.name, deployment: deploymentName };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to get logs for ${deploymentName}:`, error.message);
    return { logs: '', reason: error.message };
  }
};

const getAgentRuntimeLogs = async (
  runtimeType,
  instanceId,
  lines = 200,
  options = {},
) => {
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    const filterTokens = options.filterTokens || [];
    return getDeploymentLogs({ deploymentName, lines, filterTokens });
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    // Find pods for this deployment
    return getDeploymentLogs({ deploymentName, lines });
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to get logs for ${deploymentName}:`, error.message);
    return { logs: '', reason: error.message };
  }
};

module.exports = {
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  resolveOpenClawAccountId,
};
