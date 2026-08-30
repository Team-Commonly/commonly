// ADR-023 W2 hosted runtime — kernel-side half: config, Map-vs-lean reads,
// the two D3.1 caps, and the worker client (auth header, timeout, non-2xx).
const mockInstallationCount = jest.fn();
const mockEventCount = jest.fn();

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { countDocuments: (...args) => mockInstallationCount(...args) },
}));
jest.mock('../../../models/AgentEvent', () => ({
  countDocuments: (...args) => mockEventCount(...args),
}));

const hosted = require('../../../services/hostedRuntimeService');

const ENV_KEYS = ['HOSTED_RUNTIME_URL', 'HOSTED_RUNTIME_ADMIN_TOKEN', 'HOSTED_AGENTS_PER_USER', 'HOSTED_TURNS_PER_DAY'];

describe('hostedRuntimeService', () => {
  const saved = {};
  beforeEach(() => {
    ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    mockInstallationCount.mockReset();
    mockEventCount.mockReset();
    global.fetch = jest.fn();
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    delete global.fetch;
  });

  describe('configuration', () => {
    it('is unconfigured unless both URL and admin token are present', () => {
      expect(hosted.isConfigured()).toBe(false);
      process.env.HOSTED_RUNTIME_URL = 'https://runtime.example';
      expect(hosted.isConfigured()).toBe(false);
      process.env.HOSTED_RUNTIME_ADMIN_TOKEN = 'secret';
      expect(hosted.isConfigured()).toBe(true);
    });

    it('applies defaults and ignores garbage cap values', () => {
      expect(hosted.hostedCaps()).toEqual({ agentsPerUser: 1, turnsPerDay: 200 });
      process.env.HOSTED_AGENTS_PER_USER = '3';
      process.env.HOSTED_TURNS_PER_DAY = 'lots';
      expect(hosted.hostedCaps()).toEqual({ agentsPerUser: 3, turnsPerDay: 200 });
    });
  });

  describe('readRuntimeConfig / isHostedInstallation', () => {
    it('reads a hydrated Map config and a lean object config identically', () => {
      const hydrated = { config: new Map([['runtime', { runtimeType: 'hosted' }]]) };
      const lean = { config: { runtime: { runtimeType: 'HOSTED' } } };
      expect(hosted.isHostedInstallation(hydrated)).toBe(true);
      expect(hosted.isHostedInstallation(lean)).toBe(true);
      expect(hosted.isHostedInstallation({ config: { runtime: { runtimeType: 'webhook' } } })).toBe(false);
      expect(hosted.isHostedInstallation({ config: new Map() })).toBe(false);
      expect(hosted.isHostedInstallation(null)).toBe(false);
    });
  });

  describe('caps', () => {
    it('counts active hosted installs by the path the install route writes', async () => {
      mockInstallationCount.mockResolvedValue(2);
      await expect(hosted.countHostedAgentsForUser('user-1')).resolves.toBe(2);
      expect(mockInstallationCount).toHaveBeenCalledWith({
        installedBy: 'user-1',
        status: 'active',
        'config.runtime.runtimeType': 'hosted',
      });
    });

    it('meters acked events since the UTC day start and reports the reset', async () => {
      process.env.HOSTED_TURNS_PER_DAY = '2';
      mockEventCount.mockResolvedValue(1);
      const meter = await hosted.meterAllowsTurn('Scout', 'default');
      expect(meter).toMatchObject({ allowed: true, used: 1, cap: 2 });
      const filter = mockEventCount.mock.calls[0][0];
      expect(filter).toMatchObject({ agentName: 'scout', instanceId: 'default', status: 'acked' });
      expect(filter.createdAt.$gte.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(new Date(meter.resetsAt).getTime() - filter.createdAt.$gte.getTime()).toBe(24 * 3600 * 1000);

      mockEventCount.mockResolvedValue(2);
      await expect(hosted.meterAllowsTurn('scout', 'default')).resolves.toMatchObject({ allowed: false, used: 2 });
    });
  });

  describe('worker client', () => {
    beforeEach(() => {
      process.env.HOSTED_RUNTIME_URL = 'https://runtime.example/';
      process.env.HOSTED_RUNTIME_ADMIN_TOKEN = 'admin-secret';
    });

    const okResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

    it('provisions with the admin bearer, a non-default UA, and the DO path', async () => {
      global.fetch.mockResolvedValue(okResponse({ provisioned: true }));
      await expect(hosted.provisionAgent({ agentName: 'scout', instanceId: 'default', runtimeToken: 'cm_agent_x' }))
        .resolves.toEqual({ provisioned: true });
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe('https://runtime.example/agents/scout/default/provision');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer admin-secret');
      expect(init.headers['User-Agent']).toMatch(/^commonly-backend/);
      expect(JSON.parse(init.body)).toEqual({ agentName: 'scout', instanceId: 'default', runtimeToken: 'cm_agent_x' });
    });

    it('throws 503 when unconfigured, 502 on non-2xx, 502 on network failure', async () => {
      delete process.env.HOSTED_RUNTIME_ADMIN_TOKEN;
      await expect(hosted.getAgentStatus('scout', 'default')).rejects.toMatchObject({ status: 503 });
      expect(global.fetch).not.toHaveBeenCalled();

      process.env.HOSTED_RUNTIME_ADMIN_TOKEN = 'admin-secret';
      global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'unauthorized' }) });
      await expect(hosted.getAgentStatus('scout', 'default')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('401') });

      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(hosted.deprovisionAgent('scout', 'default')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('ECONNREFUSED') });
    });

    it('never leaks the admin token into the error message', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
      await expect(hosted.getAgentStatus('scout', 'default')).rejects.not.toMatchObject({ message: expect.stringContaining('admin-secret') });
    });
  });
});
