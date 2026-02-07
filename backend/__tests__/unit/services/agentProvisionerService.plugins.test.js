describe('agentProvisionerService plugin operations', () => {
  const originalK8sMode = process.env.AGENT_PROVISIONER_K8S;

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (originalK8sMode === undefined) {
      delete process.env.AGENT_PROVISIONER_K8S;
    } else {
      process.env.AGENT_PROVISIONER_K8S = originalK8sMode;
    }
  });

  it('delegates list/install plugin operations to k8s provisioner in k8s mode', async () => {
    process.env.AGENT_PROVISIONER_K8S = '1';

    const listOpenClawPluginsMock = jest.fn().mockResolvedValue({
      plugins: [{ name: 'tavily-search' }],
      pod: 'clawdbot-gateway-abc123',
    });
    const installOpenClawPluginMock = jest.fn().mockResolvedValue({
      stdout: 'installed',
      stderr: '',
      command: 'node dist/index.js plugins install @openclaw/tavily-search',
      pod: 'clawdbot-gateway-abc123',
    });

    jest.doMock('../../../services/agentProvisionerServiceK8s', () => ({
      listOpenClawPlugins: listOpenClawPluginsMock,
      installOpenClawPlugin: installOpenClawPluginMock,
    }));

    // eslint-disable-next-line global-require
    const service = require('../../../services/agentProvisionerService');
    const gateway = { _id: 'gateway-1', slug: 'dev', mode: 'k8s' };

    const listResult = await service.listOpenClawPlugins({ gateway });
    expect(listOpenClawPluginsMock).toHaveBeenCalledWith({ gateway });
    expect(listResult.plugins).toHaveLength(1);

    const installResult = await service.installOpenClawPlugin({
      spec: '@openclaw/tavily-search',
      link: false,
      gateway,
    });
    expect(installOpenClawPluginMock).toHaveBeenCalledWith({
      spec: '@openclaw/tavily-search',
      link: false,
      gateway,
    });
    expect(installResult.stdout).toBe('installed');
  });
});
