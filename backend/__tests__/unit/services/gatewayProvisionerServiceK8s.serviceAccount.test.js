// A provisioned agent gateway runs agent turns, so it must not carry a
// Kubernetes token, nor run as an account that holds a Role: the gateway never
// calls the Kubernetes API, and agent-provisioner can read every Secret in the
// namespace and exec into pods (F533). It runs as the chart's agent-runtime
// account, which has no Role. The chart side is checked by
// scripts/verify-service-account-tokens-chart.js.

const notFound = () => Object.assign(new Error('not found'), { response: { statusCode: 404 } });

const mockCore = {
  readNamespacedConfigMap: jest.fn(async () => { throw notFound(); }),
  createNamespacedConfigMap: jest.fn(async () => ({})),
  readNamespacedSecret: jest.fn(async () => { throw notFound(); }),
  createNamespacedSecret: jest.fn(async () => ({})),
  readNamespacedPersistentVolumeClaim: jest.fn(async () => { throw notFound(); }),
  createNamespacedPersistentVolumeClaim: jest.fn(async () => ({})),
  readNamespacedService: jest.fn(async () => { throw notFound(); }),
  createNamespacedService: jest.fn(async () => ({})),
};
const mockApps = {
  readNamespacedDeployment: jest.fn(async () => { throw notFound(); }),
  createNamespacedDeployment: jest.fn(async () => ({})),
  replaceNamespacedDeployment: jest.fn(async () => ({})),
};

jest.mock('@kubernetes/client-node', () => {
  class CoreV1Api {}
  class AppsV1Api {}
  class KubeConfig {
    loadFromDefault() {}

    makeApiClient(api) { return api && api.name === 'AppsV1Api' ? mockApps : mockCore; }
  }
  return { KubeConfig, CoreV1Api, AppsV1Api };
});

jest.mock('../../../services/globalModelConfigService', () => ({
  getConfig: jest.fn(async () => ({})),
}));

const { provisionGateway } = require('../../../services/gatewayProvisionerServiceK8s');

describe('a provisioned gateway mounts no Kubernetes token (F533)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('turns off the service account token on a new gateway', async () => {
    await provisionGateway({ gateway: { slug: 'team-alpha' }, token: 't' });

    expect(mockApps.createNamespacedDeployment).toHaveBeenCalledTimes(1);
    const [, deployment] = mockApps.createNamespacedDeployment.mock.calls[0];
    expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it('turns it off on a gateway that already exists, too', async () => {
    mockApps.readNamespacedDeployment.mockResolvedValueOnce({ body: { metadata: { resourceVersion: '7' } } });

    await provisionGateway({ gateway: { slug: 'team-beta' }, token: 't' });

    expect(mockApps.replaceNamespacedDeployment).toHaveBeenCalledTimes(1);
    const [, , deployment] = mockApps.replaceNamespacedDeployment.mock.calls[0];
    expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it('runs as the agent-runtime account, never the provisioner', async () => {
    await provisionGateway({ gateway: { slug: 'team-gamma' }, token: 't' });

    const [, deployment] = mockApps.createNamespacedDeployment.mock.calls[0];
    expect(deployment.spec.template.spec.serviceAccountName).toBe('agent-runtime');
  });

  it('takes the account name the chart passes in AGENT_RUNTIME_SERVICE_ACCOUNT', async () => {
    const saved = process.env.AGENT_RUNTIME_SERVICE_ACCOUNT;
    process.env.AGENT_RUNTIME_SERVICE_ACCOUNT = 'team-agents';
    try {
      let provision;
      jest.isolateModules(() => {
        ({ provisionGateway: provision } = require('../../../services/gatewayProvisionerServiceK8s'));
      });
      await provision({ gateway: { slug: 'team-delta' }, token: 't' });
      const [, deployment] = mockApps.createNamespacedDeployment.mock.calls[0];
      expect(deployment.spec.template.spec.serviceAccountName).toBe('team-agents');
      expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AGENT_RUNTIME_SERVICE_ACCOUNT;
      else process.env.AGENT_RUNTIME_SERVICE_ACCOUNT = saved;
    }
  });
});
