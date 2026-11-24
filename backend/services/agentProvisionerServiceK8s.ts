/**
 * Kubernetes-native Agent Provisioner Service
 * Replaces Docker socket mounting with K8s API for agent runtime provisioning
 */

export {};

const k8s = require('@kubernetes/client-node');

// Initialize K8s client
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);

const NAMESPACE = process.env.K8S_NAMESPACE || 'commonly';

/**
 * Read ConfigMap data
 */
const readConfigMap = async (configMapName: any, key: any) => {
  try {
    const response = await k8sApi.readNamespacedConfigMap(configMapName, NAMESPACE);
    const data = response.body.data || {};
    const raw = data[key] || '{}';
    return JSON.parse(raw);
  } catch (error: any) {
    if ((error as any).response && (error as any).response.statusCode === 404) {
      console.log(`[k8s-provisioner] ConfigMap ${configMapName} not found, will create`);
      return {};
    }
    throw new Error(`Failed to read ConfigMap ${configMapName}: ${(error as Error).message}`);
  }
};

/**
 * Write ConfigMap data
 */
const writeConfigMap = async (configMapName: any, key: any, data: any) => {
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
      (configMap as any).metadata.resourceVersion = existing.body.metadata.resourceVersion;
    }
    await k8sApi.replaceNamespacedConfigMap(configMapName, NAMESPACE, configMap);
    console.log(`[k8s-provisioner] Updated ConfigMap ${configMapName}`);
  } catch (error: any) {
    if ((error as any).response && (error as any).response.statusCode === 404) {
      // Create new ConfigMap
      await k8sApi.createNamespacedConfigMap(NAMESPACE, configMap);
      console.log(`[k8s-provisioner] Created ConfigMap ${configMapName}`);
    } else {
      throw new Error(`Failed to write ConfigMap ${configMapName}: ${(error as Error).message}`);
    }
  }
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
}: any) => {
  const configMapName = 'commonly-bot-config';
  const configKey = 'runtime.json';

  const config = await readConfigMap(configMapName, configKey);
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

  await writeConfigMap(configMapName, configKey, config);

  return {
    configMap: configMapName,
    accountId,
    restartRequired: false,
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
}: any) => {
  console.log(`[k8s-provisioner] Provisioning ${runtimeType} agent: ${agentName}/${instanceId}`);

  let result;
  let accountId;
  let deploymentName = null;

  if (runtimeType === 'internal') {
    accountId = instanceId;
    result = await provisionCommonlyBotAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
    });
    deploymentName = `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await cleanupLegacyInternalDeployment(deploymentName);
  } else if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    // External runtimes — no K8s deployment; agent manages its own compute
    return { provisioned: true, external: true, runtimeType };
  } else if (runtimeType === 'native') {
    // Native agents run in-process inside the backend pod via
    // nativeRuntimeService. No K8s deployment, no gateway, no tokens — the
    // event dispatcher picks them up directly on enqueue.
    return { provisioned: true, runtimeType: 'native', inProcess: true };
  } else if (runtimeType === 'managed-agents') {
    // Delegate to the managed-agents adapter for provisioning.
    // The adapter handles beta.agents.create() + beta.environments.create()
    // and (in the full flow) stores the returned ids on the installation config.
    //
    // Scaffolding only — actual provision flow (creating agent, environment,
    // storing ids on the installation) is a follow-up track. For now we
    // verify configuration and throw a typed error so the route surfaces a
    // clear 501-ish response if someone tries to use this runtimeType before
    // it's finished.
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
  } else {
    throw new Error(`Provisioning not supported for runtime: ${runtimeType}`);
  }

  return {
    ...result,
    deployment: deploymentName,
    namespace: NAMESPACE,
  };
};

const resolveRuntimeDeploymentName = (runtimeType: any, instanceId: any) => {
  const accountId = instanceId;
  return `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
};

const cleanupLegacyInternalDeployment = async (deploymentName: any) => {
  if (!deploymentName) return;
  try {
    await k8sAppsApi.deleteNamespacedDeployment(deploymentName, NAMESPACE);
    console.log(`[k8s-provisioner] Removed legacy internal deployment: ${deploymentName}`);
  } catch (error: any) {
    if (error?.response?.statusCode !== 404) {
      console.warn(`[k8s-provisioner] Failed to remove legacy internal deployment ${deploymentName}:`, (error as Error).message);
    }
  }
};

/**
 * Start agent runtime (scale to 1 replica)
 */
const startAgentRuntime = async (runtimeType: any, instanceId: any) => {
  if (runtimeType === 'internal') {
    return { started: true, managedExternally: true, reason: 'internal runtime is config-only on k8s' };
  }
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { started: false, external: true, reason: 'external runtime — agent manages its own process' };
  }
  if (runtimeType === 'native') {
    return { started: true, inProcess: true, reason: 'native runtime is in-process — nothing to start' };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    deployment.spec.replicas = 1;
    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Started agent runtime: ${deploymentName}`);
    return { started: true, deployment: deploymentName };
  } catch (error: any) {
    console.error(`[k8s-provisioner] Failed to start ${deploymentName}:`, (error as Error).message);
    return { started: false, reason: (error as Error).message };
  }
};

/**
 * Stop agent runtime (scale to 0 replicas)
 */
const stopAgentRuntime = async (runtimeType: any, instanceId: any) => {
  if (runtimeType === 'internal') {
    return { stopped: true, managedExternally: true, reason: 'internal runtime is config-only on k8s' };
  }
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { stopped: false, external: true, reason: 'external runtime — agent manages its own process' };
  }
  if (runtimeType === 'native') {
    return { stopped: true, inProcess: true, reason: 'native runtime is in-process — nothing to stop' };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    deployment.spec.replicas = 0;
    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Stopped agent runtime: ${deploymentName}`);
    return { stopped: true, deployment: deploymentName };
  } catch (error: any) {
    console.error(`[k8s-provisioner] Failed to stop ${deploymentName}:`, (error as Error).message);
    return { stopped: false, reason: (error as Error).message };
  }
};

/**
 * Restart agent runtime (trigger rolling restart)
 */
const restartAgentRuntime = async (runtimeType: any, instanceId: any) => {
  if (runtimeType === 'internal') {
    return { restarted: true, managedExternally: true, reason: 'internal runtime is config-only on k8s' };
  }
  if (runtimeType === 'native') {
    return { restarted: true, inProcess: true, reason: 'native runtime is in-process — nothing to restart' };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    // Add restart annotation to trigger rolling restart
    deployment.spec.template.metadata = deployment.spec.template.metadata || {};
    deployment.spec.template.metadata.annotations = deployment.spec.template.metadata.annotations || {};
    deployment.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString();

    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Restarted agent runtime: ${deploymentName}`);
    return { restarted: true, deployment: deploymentName };
  } catch (error: any) {
    console.error(`[k8s-provisioner] Failed to restart ${deploymentName}:`, (error as Error).message);
    return { restarted: false, reason: (error as Error).message };
  }
};

/**
 * Get agent runtime status
 */
const getAgentRuntimeStatus = async (runtimeType: any, instanceId: any) => {
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { status: 'external', reason: 'agent manages its own compute' };
  }
  if (runtimeType === 'native') {
    return { status: 'in-process', reason: 'native runtime runs inside the backend process' };
  }
  if (runtimeType === 'internal') {
    return {
      status: 'managed-externally',
      deployment: null,
      replicas: 0,
      availableReplicas: 0,
      readyReplicas: 0,
      reason: 'internal runtime is config-only on k8s',
    };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId);

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
  } catch (error: any) {
    if ((error as any).response && (error as any).response.statusCode === 404) {
      return { status: 'not-found', deployment: deploymentName };
    }
    return { status: 'error', reason: (error as Error).message };
  }
};

/**
 * Get agent runtime logs
 */
const getDeploymentLogs = async ({ deploymentName, lines }: any) => {
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
    return { logs: logsResponse.body || '', pod: pod.metadata.name, deployment: deploymentName };
  } catch (error: any) {
    console.error(`[k8s-provisioner] Failed to get logs for ${deploymentName}:`, (error as Error).message);
    return { logs: '', reason: (error as Error).message };
  }
};

const getAgentRuntimeLogs = async (
  runtimeType: any,
  instanceId: any,
  lines = 200,
) => {
  if (runtimeType === 'internal') {
    return {
      logs: 'No deployment logs: internal runtime is config-only on k8s.',
      status: 'managed-externally',
    };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId);

  try {
    // Find pods for this deployment
    return getDeploymentLogs({ deploymentName, lines });
  } catch (error: any) {
    console.error(`[k8s-provisioner] Failed to get logs for ${deploymentName}:`, (error as Error).message);
    return { logs: '', reason: (error as Error).message };
  }
};

module.exports = {
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
};
