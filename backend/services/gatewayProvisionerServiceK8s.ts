import crypto from 'crypto';

// eslint-disable-next-line global-require
const k8s = require('@kubernetes/client-node');
// eslint-disable-next-line global-require
const GlobalModelConfigService = require('./globalModelConfigService');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);

const DEFAULT_GATEWAY_IMAGE = 'gcr.io/commonly-test/clawdbot-gateway:latest';
const DEFAULT_GATEWAY_PORT = 18789;

interface GatewayMetadata {
  namespace?: string;
  image?: string;
  storageClass?: string;
  workspaceSize?: string;
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
}

interface GatewayDescriptor {
  slug?: string;
  metadata?: GatewayMetadata;
}

interface ProvisionResult {
  namespace: string;
  deployment: string;
  service: string;
  baseUrl: string;
}

interface CreateOrUpdateConfigMapOptions {
  name: string;
  namespace: string;
  data: Record<string, string>;
}

interface EnsureSecretOptions {
  name: string;
  namespace: string;
  token: string;
}

interface EnsureWorkspacePvcOptions {
  name: string;
  namespace: string;
  storageClass: string;
  size: string;
}

interface CreateOrUpdateServiceOptions {
  name: string;
  namespace: string;
  labels: Record<string, string>;
}

interface CreateOrUpdateDeploymentOptions {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  image: string;
  backendUrl: string;
  secretName: string;
  configMapName: string;
  workspacePvcName: string;
  nodeSelector?: Record<string, string>;
  tolerations?: unknown[];
}

const getNamespace = (gateway: GatewayDescriptor): string => (
  gateway?.metadata?.namespace
  || process.env.K8S_NAMESPACE
  || 'commonly'
);

const getGatewaySlug = (gateway: GatewayDescriptor): string => String(gateway?.slug || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const resolveServiceName = (slug: string): string => `gateway-${slug}`;
const resolveConfigMapName = (slug: string): string => `gateway-${slug}-config`;
const resolveSecretName = (slug: string): string => `gateway-${slug}-token`;
const resolveWorkspacePvcName = (slug: string): string => `gateway-${slug}-workspace`;

const resolveBaseUrl = (slug: string, namespace: string): string => (
  `http://${resolveServiceName(slug)}.${namespace}.svc.cluster.local:${DEFAULT_GATEWAY_PORT}`
);

const resolveBackendUrl = (namespace: string): string => (
  process.env.COMMONLY_API_URL
  || `http://backend.${namespace}.svc.cluster.local:5000`
);

const buildGatewayConfig = async ({ backendUrl }: { backendUrl: string }): Promise<Record<string, unknown>> => {
  let modelConfig: Record<string, unknown> | null = null;
  try {
    modelConfig = await GlobalModelConfigService.getConfig({ includeSecrets: false }) as Record<string, unknown>;
  } catch (error) {
    modelConfig = null;
  }
  const openclaw = modelConfig?.openclaw as Record<string, unknown> | undefined;
  const defaultPrimary = String(
    openclaw?.model
    || openclaw?.defaultModel
    || '',
  ).trim() || 'google/gemini-2.5-flash';

  return {
    agents: {
      defaults: {
        model: { primary: defaultPrimary },
        maxConcurrent: 4,
        subagents: { maxConcurrent: 8 },
      },
      list: [],
    },
    commands: { native: 'auto', nativeSkills: 'auto' },
    channels: {
      commonly: {
        enabled: true,
        baseUrl: backendUrl,
        accounts: {},
      },
    },
    gateway: {
      mode: 'local',
      bind: 'lan',
      auth: { mode: 'token' },
      controlUi: { allowInsecureAuth: true },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    messages: { ackReactionScope: 'group-mentions' },
    bindings: [],
    plugins: { entries: { commonly: { enabled: true } } },
    skills: {
      load: {
        watch: true,
        watchDebounceMs: 250,
      },
    },
  };
};

const createOrUpdateConfigMap = async ({ name, namespace, data }: CreateOrUpdateConfigMapOptions): Promise<void> => {
  const payload = {
    metadata: { name, namespace },
    data,
  };
  try {
    await k8sApi.readNamespacedConfigMap(name, namespace);
    await k8sApi.replaceNamespacedConfigMap(name, namespace, payload);
  } catch (error) {
    const k8sErr = error as { response?: { statusCode?: number } };
    if (k8sErr.response && k8sErr.response.statusCode === 404) {
      await k8sApi.createNamespacedConfigMap(namespace, payload);
    } else {
      throw error;
    }
  }
};

const ensureSecret = async ({ name, namespace, token }: EnsureSecretOptions): Promise<void> => {
  const payload = {
    metadata: { name, namespace },
    type: 'Opaque',
    data: {
      'gateway-token': Buffer.from(token).toString('base64'),
    },
  };
  try {
    await k8sApi.readNamespacedSecret(name, namespace);
    await k8sApi.replaceNamespacedSecret(name, namespace, payload);
  } catch (error) {
    const k8sErr = error as { response?: { statusCode?: number } };
    if (k8sErr.response && k8sErr.response.statusCode === 404) {
      await k8sApi.createNamespacedSecret(namespace, payload);
    } else {
      throw error;
    }
  }
};

const ensureWorkspacePvc = async ({
  name,
  namespace,
  storageClass,
  size,
}: EnsureWorkspacePvcOptions): Promise<void> => {
  const pvc = {
    metadata: { name, namespace },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: storageClass,
      resources: { requests: { storage: size } },
    },
  };
  try {
    await k8sApi.readNamespacedPersistentVolumeClaim(name, namespace);
  } catch (error) {
    const k8sErr = error as { response?: { statusCode?: number } };
    if (k8sErr.response && k8sErr.response.statusCode === 404) {
      await k8sApi.createNamespacedPersistentVolumeClaim(namespace, pvc);
    } else {
      throw error;
    }
  }
};

const createOrUpdateService = async ({ name, namespace, labels }: CreateOrUpdateServiceOptions): Promise<void> => {
  const payload = {
    metadata: { name, namespace, labels },
    spec: {
      type: 'ClusterIP',
      selector: labels,
      ports: [
        { name: 'gateway', port: DEFAULT_GATEWAY_PORT, targetPort: 'gateway' },
      ],
    },
  };
  try {
    await k8sApi.readNamespacedService(name, namespace);
    await k8sApi.replaceNamespacedService(name, namespace, payload);
  } catch (error) {
    const k8sErr = error as { response?: { statusCode?: number } };
    if (k8sErr.response && k8sErr.response.statusCode === 404) {
      await k8sApi.createNamespacedService(namespace, payload);
    } else {
      throw error;
    }
  }
};

const createOrUpdateDeployment = async ({
  name,
  namespace,
  labels,
  image,
  backendUrl,
  secretName,
  configMapName,
  workspacePvcName,
  nodeSelector,
  tolerations,
}: CreateOrUpdateDeploymentOptions): Promise<void> => {
  const payload = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: 'agent-provisioner',
          ...(nodeSelector ? { nodeSelector } : {}),
          ...(tolerations ? { tolerations } : {}),
          containers: [
            {
              name: 'clawdbot-gateway',
              image,
              imagePullPolicy: 'IfNotPresent',
              command: [
                'node',
                'dist/index.js',
                'gateway',
                '--bind',
                'lan',
                '--port',
                String(DEFAULT_GATEWAY_PORT),
                '--allow-unconfigured',
              ],
              env: [
                { name: 'CLAWDBOT_GATEWAY_PORT', value: String(DEFAULT_GATEWAY_PORT) },
                { name: 'CLAWDBOT_GATEWAY_BIND', value: 'lan' },
                {
                  name: 'CLAWDBOT_GATEWAY_TOKEN',
                  valueFrom: { secretKeyRef: { name: secretName, key: 'gateway-token' } },
                },
                {
                  name: 'OPENCLAW_GATEWAY_TOKEN',
                  valueFrom: { secretKeyRef: { name: secretName, key: 'gateway-token' } },
                },
                { name: 'CLAWDBOT_CONFIG_DIR', value: '/config' },
                { name: 'OPENCLAW_STATE_DIR', value: '/state' },
                { name: 'OPENCLAW_CONFIG_PATH', value: '/config/moltbot.json' },
                { name: 'CLAWDBOT_WORKSPACE_DIR', value: '/workspace' },
                { name: 'CLAWDBOT_SKIP_BROWSER_CONTROL_SERVER', value: '1' },
                { name: 'CLAWDBOT_SKIP_CANVAS_HOST', value: '1' },
                { name: 'COMMONLY_API_URL', value: backendUrl },
                {
                  name: 'GEMINI_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-keys', key: 'gemini-api-key' } },
                },
                {
                  name: 'ANTHROPIC_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-keys', key: 'anthropic-api-key', optional: true } },
                },
                {
                  name: 'OPENAI_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-keys', key: 'openai-api-key', optional: true } },
                },
                {
                  name: 'BRAVE_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-keys', key: 'brave-api-key', optional: true } },
                },
                {
                  name: 'FIRECRAWL_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-keys', key: 'firecrawl-api-key', optional: true } },
                },
                {
                  name: 'DEEPGRAM_API_KEY',
                  valueFrom: { secretKeyRef: { name: 'api-keys', key: 'deepgram-api-key', optional: true } },
                },
              ],
              ports: [
                { containerPort: DEFAULT_GATEWAY_PORT, name: 'gateway' },
              ],
              resources: {
                requests: { memory: '512Mi', cpu: '200m' },
                limits: { memory: '2Gi', cpu: '1000m' },
              },
              volumeMounts: [
                { name: 'gateway-config', mountPath: '/config', readOnly: true },
                { name: 'gateway-state', mountPath: '/state' },
                { name: 'gateway-workspace', mountPath: '/workspace' },
              ],
            },
          ],
          volumes: [
            { name: 'gateway-config', configMap: { name: configMapName } },
            { name: 'gateway-state', emptyDir: {} },
            { name: 'gateway-workspace', persistentVolumeClaim: { claimName: workspacePvcName } },
          ],
        },
      },
    },
  };

  try {
    await k8sAppsApi.readNamespacedDeployment(name, namespace);
    await k8sAppsApi.replaceNamespacedDeployment(name, namespace, payload);
  } catch (error) {
    const k8sErr = error as { response?: { statusCode?: number } };
    if (k8sErr.response && k8sErr.response.statusCode === 404) {
      await k8sAppsApi.createNamespacedDeployment(namespace, payload);
    } else {
      throw error;
    }
  }
};

const provisionGateway = async ({ gateway, token }: { gateway: GatewayDescriptor; token: string }): Promise<ProvisionResult> => {
  const slug = getGatewaySlug(gateway);
  const namespace = getNamespace(gateway);
  if (!slug) throw new Error('gateway slug missing');

  const backendUrl = resolveBackendUrl(namespace);
  const config = await buildGatewayConfig({ backendUrl });

  const configMapName = resolveConfigMapName(slug);
  const serviceName = resolveServiceName(slug);
  const secretName = resolveSecretName(slug);
  const workspacePvcName = resolveWorkspacePvcName(slug);

  const image = gateway?.metadata?.image || DEFAULT_GATEWAY_IMAGE;
  const storageClass = gateway?.metadata?.storageClass || 'standard-rwo';
  const workspaceSize = gateway?.metadata?.workspaceSize || '10Gi';

  const labels: Record<string, string> = {
    app: serviceName,
    'commonly.gateway': slug,
  };

  await createOrUpdateConfigMap({
    name: configMapName,
    namespace,
    data: { 'moltbot.json': JSON.stringify(config, null, 2) },
  });

  await ensureSecret({ name: secretName, namespace, token });
  await ensureWorkspacePvc({
    name: workspacePvcName,
    namespace,
    storageClass,
    size: workspaceSize,
  });

  await createOrUpdateService({ name: serviceName, namespace, labels });
  await createOrUpdateDeployment({
    name: serviceName,
    namespace,
    labels,
    image,
    backendUrl,
    secretName,
    configMapName,
    workspacePvcName,
    nodeSelector: gateway?.metadata?.nodeSelector,
    tolerations: gateway?.metadata?.tolerations,
  });

  return {
    namespace,
    deployment: serviceName,
    service: serviceName,
    baseUrl: resolveBaseUrl(slug, namespace),
  };
};

const deleteGateway = async ({ gateway }: { gateway: GatewayDescriptor }): Promise<void> => {
  const slug = getGatewaySlug(gateway);
  const namespace = getNamespace(gateway);
  const names = {
    deployment: resolveServiceName(slug),
    service: resolveServiceName(slug),
    configMap: resolveConfigMapName(slug),
    secret: resolveSecretName(slug),
    workspacePvc: resolveWorkspacePvcName(slug),
  };

  const safeDelete = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      const k8sErr = error as { response?: { statusCode?: number } };
      if (k8sErr.response && k8sErr.response.statusCode === 404) return;
      throw error;
    }
  };

  await safeDelete(() => k8sAppsApi.deleteNamespacedDeployment(names.deployment, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedService(names.service, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedConfigMap(names.configMap, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedSecret(names.secret, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedPersistentVolumeClaim(names.workspacePvc, namespace));
};

const generateGatewayToken = (): string => (
  crypto.randomBytes(32).toString('base64url')
);

export {
  provisionGateway,
  deleteGateway,
  generateGatewayToken,
  resolveBaseUrl,
};
