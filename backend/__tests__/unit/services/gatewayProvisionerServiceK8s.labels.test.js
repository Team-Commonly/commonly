// The chart's backend and litellm NetworkPolicies admit a provisioned agent
// gateway by the label key `commonly.gateway` on its pods
// (k8s/helm/commonly/templates/network/ingress-allow.yaml, F511). The chart
// never renders these gateways, so this is the check that runs when only this
// service changes: if the pod template stops carrying that key, every new or
// re-provisioned gateway is cut off from the backend and litellm once those
// allows are on.

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

describe('a provisioned gateway carries the label its NetworkPolicy admits it by (F511)', () => {
  const oldNs = process.env.K8S_NAMESPACE;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.K8S_NAMESPACE = 'commonly-test';
  });
  afterAll(() => {
    if (oldNs === undefined) delete process.env.K8S_NAMESPACE; else process.env.K8S_NAMESPACE = oldNs;
  });

  it('puts commonly.gateway on the pod template, in the namespace the chart fences', async () => {
    await provisionGateway({ gateway: { slug: 'Team Alpha' }, token: 't' });

    expect(mockApps.createNamespacedDeployment).toHaveBeenCalledTimes(1);
    const [namespace, deployment] = mockApps.createNamespacedDeployment.mock.calls[0];
    expect(namespace).toBe('commonly-test');
    expect(deployment.metadata.name).toBe('gateway-team-alpha');
    // The pod template is what a NetworkPolicy peer selects, not the
    // Deployment's own metadata.
    expect(deployment.spec.template.metadata.labels).toEqual(expect.objectContaining({ 'commonly.gateway': 'team-alpha' }));
    expect(deployment.spec.selector.matchLabels).toEqual(deployment.spec.template.metadata.labels);
  });

  it('keeps the label on a gateway placed in its own namespace', async () => {
    await provisionGateway({ gateway: { slug: 'beta', metadata: { namespace: 'commonly-dev' } }, token: 't' });

    const [namespace, deployment] = mockApps.createNamespacedDeployment.mock.calls[0];
    expect(namespace).toBe('commonly-dev');
    expect(deployment.spec.template.metadata.labels['commonly.gateway']).toBe('beta');
  });
});
