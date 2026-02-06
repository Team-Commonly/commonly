jest.mock('@kubernetes/client-node', () => {
  const mock = {
    readNamespacedDeployment: jest.fn(async () => ({
      body: {
        spec: {
          template: {
            metadata: {},
          },
        },
      },
    })),
    replaceNamespacedDeployment: jest.fn(async () => ({})),
    readNamespacedConfigMap: jest.fn(async () => ({ body: { data: {} } })),
    replaceNamespacedConfigMap: jest.fn(async () => ({})),
    createNamespacedConfigMap: jest.fn(async () => ({})),
  };

  class KubeConfig {
    loadFromDefault() {}
    makeApiClient(api) {
      if (api && api.name === 'AppsV1Api') {
        return {
          readNamespacedDeployment: mock.readNamespacedDeployment,
          replaceNamespacedDeployment: mock.replaceNamespacedDeployment,
        };
      }
      return {
        readNamespacedConfigMap: mock.readNamespacedConfigMap,
        replaceNamespacedConfigMap: mock.replaceNamespacedConfigMap,
        createNamespacedConfigMap: mock.createNamespacedConfigMap,
      };
    }
  }
  class CoreV1Api {}
  class AppsV1Api {}
  return {
    KubeConfig,
    CoreV1Api,
    AppsV1Api,
    __mock: mock,
  };
});

const k8s = require('@kubernetes/client-node');
const { restartAgentRuntime, provisionAgentRuntime } = require('../../../services/agentProvisionerServiceK8s');

describe('agentProvisionerServiceK8s', () => {
  beforeEach(() => {
    k8s.__mock.readNamespacedDeployment.mockClear();
    k8s.__mock.replaceNamespacedDeployment.mockClear();
  });

  it('restarts the shared gateway deployment for OpenClaw runtimes', async () => {
    const result = await restartAgentRuntime('moltbot', 'cuz');

    expect(k8s.__mock.readNamespacedDeployment).toHaveBeenCalledWith('clawdbot-gateway', 'commonly');
    expect(k8s.__mock.replaceNamespacedDeployment).toHaveBeenCalled();
    expect(result.restarted).toBe(true);
    expect(result.sharedGateway).toBe(true);

    const replaced = k8s.__mock.replaceNamespacedDeployment.mock.calls[0][2];
    const annotations = replaced?.spec?.template?.metadata?.annotations || {};
    expect(annotations['kubectl.kubernetes.io/restartedAt']).toBeDefined();
  });

  it('stores custom auth profiles in the gateway config map', async () => {
    const authProfiles = {
      'google:default': { type: 'api_key', provider: 'google', key: 'test-google' },
      'openai:default': { type: 'api_key', provider: 'openai', key: 'test-openai' },
    };

    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      baseUrl: 'http://backend',
      displayName: 'Cuz',
      heartbeat: null,
      authProfiles,
    });

    const calls = k8s.__mock.replaceNamespacedConfigMap.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const configMapPayload = calls[calls.length - 1][2];
    const raw = configMapPayload?.data?.['moltbot.json'];
    const config = JSON.parse(raw);
    expect(config.channels.commonly.accounts.cuz.authProfiles).toEqual(authProfiles);
  });
});
