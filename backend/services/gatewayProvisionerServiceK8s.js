const crypto = require('crypto');
const k8s = require('@kubernetes/client-node');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);

const DEFAULT_GATEWAY_IMAGE = 'gcr.io/commonly-test/clawdbot-gateway:latest';
const DEFAULT_GATEWAY_PORT = 18789;

const getNamespace = (gateway) => (
  gateway?.metadata?.namespace
  || process.env.K8S_NAMESPACE
  || 'commonly'
);

const getGatewaySlug = (gateway) => String(gateway?.slug || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '');

const resolveServiceName = (slug) => `gateway-${slug}`;
const resolveConfigMapName = (slug) => `gateway-${slug}-config`;
const resolveSecretName = (slug) => `gateway-${slug}-token`;
const resolveWorkspacePvcName = (slug) => `gateway-${slug}-workspace`;

const resolveBaseUrl = (slug, namespace) => (
  `http://${resolveServiceName(slug)}.${namespace}.svc.cluster.local:${DEFAULT_GATEWAY_PORT}`
);

const resolveBackendUrl = (namespace) => (
  process.env.COMMONLY_API_URL
  || `http://backend.${namespace}.svc.cluster.local:5000`
);

const buildGatewayConfig = ({ backendUrl }) => ({
  agents: {
    defaults: {
      model: { primary: 'google/gemini-2.5-flash' },
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
});

const createOrUpdateConfigMap = async ({ name, namespace, data }) => {
  const payload = {
    metadata: { name, namespace },
    data,
  };
  try {
    await k8sApi.readNamespacedConfigMap(name, namespace);
    await k8sApi.replaceNamespacedConfigMap(name, namespace, payload);
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      await k8sApi.createNamespacedConfigMap(namespace, payload);
    } else {
      throw error;
    }
  }
};

const ensureSecret = async ({ name, namespace, token }) => {
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
    if (error.response && error.response.statusCode === 404) {
      await k8sApi.createNamespacedSecret(namespace, payload);
    } else {
      throw error;
    }
  }
};

const ensureWorkspacePvc = async ({ name, namespace, storageClass, size }) => {
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
    if (error.response && error.response.statusCode === 404) {
      await k8sApi.createNamespacedPersistentVolumeClaim(namespace, pvc);
    } else {
      throw error;
    }
  }
};

const createOrUpdateService = async ({ name, namespace, labels }) => {
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
    if (error.response && error.response.statusCode === 404) {
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
}) => {
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
    if (error.response && error.response.statusCode === 404) {
      await k8sAppsApi.createNamespacedDeployment(namespace, payload);
    } else {
      throw error;
    }
  }
};

const provisionGateway = async ({ gateway, token }) => {
  const slug = getGatewaySlug(gateway);
  const namespace = getNamespace(gateway);
  if (!slug) throw new Error('gateway slug missing');

  const backendUrl = resolveBackendUrl(namespace);
  const config = buildGatewayConfig({ backendUrl });

  const configMapName = resolveConfigMapName(slug);
  const serviceName = resolveServiceName(slug);
  const secretName = resolveSecretName(slug);
  const workspacePvcName = resolveWorkspacePvcName(slug);

  const image = gateway?.metadata?.image || DEFAULT_GATEWAY_IMAGE;
  const storageClass = gateway?.metadata?.storageClass || 'standard-rwo';
  const workspaceSize = gateway?.metadata?.workspaceSize || '10Gi';

  const labels = {
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

const deleteGateway = async ({ gateway }) => {
  const slug = getGatewaySlug(gateway);
  const namespace = getNamespace(gateway);
  const names = {
    deployment: resolveServiceName(slug),
    service: resolveServiceName(slug),
    configMap: resolveConfigMapName(slug),
    secret: resolveSecretName(slug),
    workspacePvc: resolveWorkspacePvcName(slug),
  };

  const safeDelete = async (fn) => {
    try {
      await fn();
    } catch (error) {
      if (error.response && error.response.statusCode === 404) return;
      throw error;
    }
  };

  await safeDelete(() => k8sAppsApi.deleteNamespacedDeployment(names.deployment, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedService(names.service, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedConfigMap(names.configMap, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedSecret(names.secret, namespace));
  await safeDelete(() => k8sApi.deleteNamespacedPersistentVolumeClaim(names.workspacePvc, namespace));
};

const generateGatewayToken = () => (
  crypto.randomBytes(32).toString('base64url')
);

module.exports = {
  provisionGateway,
  deleteGateway,
  generateGatewayToken,
  resolveBaseUrl,
};
