// A provisioned agent gateway runs agent turns, so it must not carry a
// Kubernetes token. Its pods run as the agent-provisioner service account,
// which can read every Secret in the namespace and exec into pods; the gateway
// itself never calls the Kubernetes API (F533). The chart's own workloads are
// checked by scripts/verify-service-account-tokens-chart.js.

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
});
