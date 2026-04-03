const fs = require('fs');
const os = require('os');
const path = require('path');
const { provisionAgentRuntime } = require('../../../services/agentProvisionerService');

describe('agentProvisionerService', () => {
  const tempDir = path.join(os.tmpdir(), 'commonly-agent-provisioner-tests');
  const openclawConfigPath = path.join(tempDir, 'moltbot.json');
  const commonlyConfigPath = path.join(tempDir, 'commonly-bot.json');

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    if (fs.existsSync(openclawConfigPath)) fs.unlinkSync(openclawConfigPath);
    if (fs.existsSync(commonlyConfigPath)) fs.unlinkSync(commonlyConfigPath);
    process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
    process.env.COMMONLY_BOT_CONFIG_PATH = commonlyConfigPath;
    process.env.OPENCLAW_WORKSPACE_ROOT = path.join(tempDir, 'workspaces');
    process.env.AGENT_PROVISIONER_K8S = '0';
  });

  afterAll(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.COMMONLY_BOT_CONFIG_PATH;
    delete process.env.OPENCLAW_WORKSPACE_ROOT;
    delete process.env.AGENT_PROVISIONER_K8S;
  });

  it('writes OpenClaw account config', async () => {
    const result = await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      baseUrl: 'http://backend:5000',
    });

    expect(result.configPath).toBe(openclawConfigPath);
    const raw = fs.readFileSync(openclawConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.channels.commonly.accounts.cuz.runtimeToken).toBe('cm_agent_test');
    expect(parsed.bindings.find((b) => b.match?.accountId === 'cuz')).toBeTruthy();
    const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');
    expect(agentEntry.workspace).toBe(path.join(tempDir, 'workspaces', 'cuz'));
  });

  it('writes connected integration channel accounts into OpenClaw config', async () => {
    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      baseUrl: 'http://backend:5000',
      integrationChannels: {
        discord: [{ accountId: 'disc-1', name: 'Discord Dev', token: 'disc-token' }],
        slack: [{
          accountId: 'slack-1',
          name: 'Slack Dev',
          botToken: 'xoxb-123',
          appToken: 'xapp-123',
          signingSecret: 'sig-123',
          channelId: 'C123',
        }],
        telegram: [{
          accountId: 'tg-1',
          name: 'Telegram Dev',
          botToken: 'tg-token',
          webhookSecret: 'tg-secret',
          chatId: '-1001',
        }],
      },
    });

    const raw = fs.readFileSync(openclawConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.channels.discord.token).toBe('disc-token');
    expect(parsed.channels.discord.accounts['disc-1'].token).toBe('disc-token');
    expect(parsed.channels.slack.botToken).toBe('xoxb-123');
    expect(parsed.channels.slack.accounts['slack-1'].botToken).toBe('xoxb-123');
    expect(parsed.channels.telegram.botToken).toBe('tg-token');
    expect(parsed.channels.telegram.accounts['tg-1'].botToken).toBe('tg-token');
  });

  it('applies global channel token env fallbacks when integration list is empty', async () => {
    process.env.DISCORD_BOT_TOKEN = 'env-disc-token';
    process.env.SLACK_BOT_TOKEN = 'env-slack-token';
    process.env.TELEGRAM_BOT_TOKEN = 'env-telegram-token';
    process.env.BRAVE_API_KEY = 'env-brave-key';
    try {
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        integrationChannels: { discord: [], slack: [], telegram: [] },
      });

      const raw = fs.readFileSync(openclawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.channels.discord.token).toBe('env-disc-token');
      expect(parsed.channels.slack.botToken).toBe('env-slack-token');
      expect(parsed.channels.telegram.botToken).toBe('env-telegram-token');
      expect(parsed.tools.web.search.provider).toBe('brave');
      expect(parsed.tools.web.search.apiKey).toBe('env-brave-key');
      expect(parsed.tools.web.search.enabled).toBe(true);
    } finally {
      delete process.env.DISCORD_BOT_TOKEN;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.BRAVE_API_KEY;
    }
  });

  it('overwrites stale OpenClaw workspace paths on reprovision', async () => {
    const seed = {
      channels: {
        commonly: {
          enabled: true,
          baseUrl: 'http://backend:5000',
          accounts: {
            cuz: {
              runtimeToken: 'cm_agent_old',
              userToken: 'cm_user_old',
              agentName: 'openclaw',
              instanceId: 'cuz',
            },
          },
        },
      },
      agents: {
        list: [{ id: 'cuz', name: 'Cuz', workspace: '/workspace/_master' }],
      },
      bindings: [
        {
          agentId: 'cuz',
          match: { channel: 'commonly', accountId: 'cuz' },
        },
      ],
    };
    fs.writeFileSync(openclawConfigPath, `${JSON.stringify(seed, null, 2)}\n`);

    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_new',
      userToken: 'cm_user_new',
      baseUrl: 'http://backend:5000',
    });

    const parsed = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
    const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');
    expect(agentEntry.workspace).toBe(path.join(tempDir, 'workspaces', 'cuz'));
  });

  it('removes stale OpenClaw account entries for the same agent instance', async () => {
    const seed = {
      channels: {
        commonly: {
          enabled: true,
          baseUrl: 'http://backend:5000',
          accounts: {
            default: {
              runtimeToken: 'cm_agent_old',
              userToken: 'cm_user_old',
              agentName: 'socialpulse',
              instanceId: 'default',
            },
          },
        },
      },
      agents: {
        list: [{ id: 'default', name: 'SocialPulse 📊' }],
      },
      bindings: [
        {
          agentId: 'default',
          match: { channel: 'commonly', accountId: 'default' },
        },
      ],
    };
    fs.writeFileSync(openclawConfigPath, `${JSON.stringify(seed, null, 2)}\n`);

    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'socialpulse',
      instanceId: 'default',
      runtimeToken: 'cm_agent_new',
      userToken: 'cm_user_new',
      baseUrl: 'http://backend:5000',
      displayName: 'SocialPulse 📊',
    });

    const raw = fs.readFileSync(openclawConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.channels.commonly.accounts.default).toBeUndefined();
    expect(parsed.channels.commonly.accounts['socialpulse-default'].runtimeToken).toBe('cm_agent_new');
    expect(parsed.agents.list.find((agent) => agent.id === 'default')).toBeUndefined();
    expect(parsed.bindings.find((b) => b.match?.accountId === 'default')).toBeUndefined();
  });

  it('writes Commonly bot runtime config', async () => {
    const result = await provisionAgentRuntime({
      runtimeType: 'internal',
      agentName: 'commonly-summarizer',
      instanceId: 'default',
      runtimeToken: 'cm_agent_summary',
      userToken: null,
    });

    expect(result.configPath).toBe(commonlyConfigPath);
    const raw = fs.readFileSync(commonlyConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.accounts.default.runtimeToken).toBe('cm_agent_summary');
  });

  describe('heartbeat configuration', () => {
    it('sets default heartbeat target to "commonly"', async () => {
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: true },
      });

      const raw = fs.readFileSync(openclawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');

      expect(agentEntry.heartbeat).toBeDefined();
      expect(agentEntry.heartbeat.target).toBe('commonly');
    });

    it('sets default heartbeat interval to 60m', async () => {
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: true },
      });

      const raw = fs.readFileSync(openclawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');

      expect(agentEntry.heartbeat.every).toBe('60m');
    });

    it('sets default heartbeat prompt that requires commonly reads before HEARTBEAT_OK', async () => {
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: true },
      });

      const raw = fs.readFileSync(openclawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');

      expect(agentEntry.heartbeat.prompt).toContain('read current pod activity');
      expect(agentEntry.heartbeat.prompt).toContain('runtime-token');
      expect(agentEntry.heartbeat.session).toBe('heartbeat');
      expect(parsed.agents.defaults.memorySearch.enabled).toBe(true);
      expect(parsed.agents.defaults.memorySearch.sources).toEqual(['memory']);
      expect(parsed.agents.defaults.contextPruning.mode).toBe('cache-ttl');
      expect(parsed.agents.defaults.contextPruning.ttl).toBe('90m');
      expect(parsed.agents.defaults.contextPruning.keepLastAssistants).toBe(2);
      expect(parsed.agents.defaults.model.primary).toBe('google/gemini-2.5-flash');
      expect(parsed.agents.defaults.model.fallbacks).toEqual(
        expect.arrayContaining(['google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash']),
      );
    });

    it('respects custom heartbeat target', async () => {
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: true, target: 'discord' },
      });

      const raw = fs.readFileSync(openclawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');

      expect(agentEntry.heartbeat.target).toBe('discord');
    });

    it('respects custom heartbeat interval in minutes', async () => {
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: true, everyMinutes: 10 },
      });

      const raw = fs.readFileSync(openclawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');

      expect(agentEntry.heartbeat.every).toBe('10m');
    });

    it('does not add heartbeat config when disabled', async () => {
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: false },
      });

      const raw = fs.readFileSync(openclawConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');

      expect(agentEntry.heartbeat).toBeUndefined();
    });

    it('removes existing heartbeat when disabled', async () => {
      // First provision with heartbeat
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test',
        userToken: 'cm_user_test',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: true },
      });

      // Verify it was added
      let raw = fs.readFileSync(openclawConfigPath, 'utf8');
      let parsed = JSON.parse(raw);
      let agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');
      expect(agentEntry.heartbeat).toBeDefined();

      // Re-provision with heartbeat disabled
      await provisionAgentRuntime({
        runtimeType: 'moltbot',
        agentName: 'openclaw',
        instanceId: 'cuz',
        runtimeToken: 'cm_agent_test2',
        userToken: 'cm_user_test2',
        baseUrl: 'http://backend:5000',
        heartbeat: { enabled: false },
      });

      // Verify it was removed
      raw = fs.readFileSync(openclawConfigPath, 'utf8');
      parsed = JSON.parse(raw);
      agentEntry = parsed.agents.list.find((agent) => agent.id === 'cuz');
      expect(agentEntry.heartbeat).toBeUndefined();
    });
  });
});
