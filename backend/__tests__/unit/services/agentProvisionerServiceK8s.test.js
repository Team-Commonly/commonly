// The OpenClaw gateway cases (its ConfigMap, HEARTBEAT.md delivery, LiteLLM
// keys, session sizes, account removal) left with that driver (ADR-021). What
// stays is the Commonly bot account the internal runtime reads from its
// ConfigMap.
jest.mock('@kubernetes/client-node', () => {
  const mock = {
    readNamespacedDeployment: jest.fn(async () => ({ body: { spec: { template: { metadata: {} } } } })),
    replaceNamespacedDeployment: jest.fn(async () => ({})),
    readNamespacedConfigMap: jest.fn(async () => ({ body: { data: {} } })),
    replaceNamespacedConfigMap: jest.fn(async () => ({})),
    createNamespacedConfigMap: jest.fn(async () => ({})),
  };
  class KubeConfig {
    loadFromDefault() {}
    // eslint-disable-next-line class-methods-use-this
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
    KubeConfig, CoreV1Api, AppsV1Api, __mock: mock,
  };
});

const k8s = require('@kubernetes/client-node');
const { provisionAgentRuntime } = require('../../../services/agentProvisionerServiceK8s');

describe('agentProvisionerServiceK8s', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps a Commonly bot account\'s saved tokens when a reprovision has none to give', async () => {
    // A stored token is a hash, so reissuing an existing one returns no bearer.
    k8s.__mock.readNamespacedConfigMap.mockResolvedValueOnce({
      body: {
        data: {
          'runtime.json': JSON.stringify({
            accounts: { default: { runtimeToken: 'cm_agent_saved', userToken: 'cm_user_saved' } },
          }),
        },
      },
    });

    await provisionAgentRuntime({
      runtimeType: 'internal',
      agentName: 'commonly-summarizer',
      instanceId: 'default',
      runtimeToken: null,
      userToken: null,
    });

    const calls = k8s.__mock.replaceNamespacedConfigMap.mock.calls;
    const written = JSON.parse(calls[calls.length - 1][2].data['runtime.json']);
    expect(written.accounts.default.runtimeToken).toBe('cm_agent_saved');
    expect(written.accounts.default.userToken).toBe('cm_user_saved');
  });

  it('refuses a moltbot runtime and writes no ConfigMap', async () => {
    await expect(provisionAgentRuntime({
      runtimeType: 'moltbot', agentName: 'openclaw', instanceId: 'theo', runtimeToken: 'cm_agent_x', userToken: null,
    })).rejects.toThrow(/moltbot/);
    expect(k8s.__mock.replaceNamespacedConfigMap).not.toHaveBeenCalled();
    expect(k8s.__mock.createNamespacedConfigMap).not.toHaveBeenCalled();
  });
});
