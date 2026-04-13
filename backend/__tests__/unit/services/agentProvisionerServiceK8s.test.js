jest.mock('@kubernetes/client-node', () => {
const mock = {
    readNamespacedDeployment: jest.fn(async () => ({
      body: {
        spec: {
          selector: {
            matchLabels: {
              app: 'clawdbot-gateway',
            },
          },
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
    listNamespacedPod: jest.fn(async () => ({
      body: {
        items: [{
          metadata: { name: 'clawdbot-gateway-test-pod' },
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        }],
      },
    })),
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
        listNamespacedPod: mock.listNamespacedPod,
      };
    }
  }
  class CoreV1Api {}
  class AppsV1Api {}
  class Exec {
    // eslint-disable-next-line class-methods-use-this
    exec(
      _namespace,
      _podName,
      _containerName,
      _command,
      _stdout,
      _stderr,
      _stdin,
      _tty,
      statusCallback,
    ) {
      if (typeof statusCallback === 'function') {
        statusCallback({ status: 'Success' });
      }
      return Promise.resolve();
    }
  }
  return {
    KubeConfig,
    CoreV1Api,
    AppsV1Api,
    Exec,
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

  it('stores connected integration channel accounts in gateway config map', async () => {
    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      baseUrl: 'http://backend',
      displayName: 'Cuz',
      heartbeat: null,
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

    const calls = k8s.__mock.replaceNamespacedConfigMap.mock.calls;
    const configMapPayload = calls[calls.length - 1][2];
    const raw = configMapPayload?.data?.['moltbot.json'];
    const config = JSON.parse(raw);
    expect(config.channels.discord.token).toBe('disc-token');
    expect(config.channels.discord.accounts['disc-1'].token).toBe('disc-token');
    expect(config.channels.slack.botToken).toBe('xoxb-123');
    expect(config.channels.slack.accounts['slack-1'].botToken).toBe('xoxb-123');
    expect(config.channels.telegram.botToken).toBe('tg-token');
    expect(config.channels.telegram.accounts['tg-1'].botToken).toBe('tg-token');
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
        baseUrl: 'http://backend',
        displayName: 'Cuz',
        heartbeat: null,
        integrationChannels: { discord: [], slack: [], telegram: [] },
      });

      const calls = k8s.__mock.replaceNamespacedConfigMap.mock.calls;
      const configMapPayload = calls[calls.length - 1][2];
      const raw = configMapPayload?.data?.['moltbot.json'];
      const config = JSON.parse(raw);
      expect(config.channels.discord.token).toBe('env-disc-token');
      expect(config.channels.slack.botToken).toBe('env-slack-token');
      expect(config.channels.telegram.botToken).toBe('env-telegram-token');
      expect(config.tools.web.search.provider).toBe('brave');
      expect(config.tools.web.search.apiKey).toBe('env-brave-key');
      expect(config.tools.web.search.enabled).toBe(true);
    } finally {
      delete process.env.DISCORD_BOT_TOKEN;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.BRAVE_API_KEY;
    }
  });

  it('overwrites stale workspace paths for existing OpenClaw agents', async () => {
    const staleConfig = {
      channels: {
        commonly: {
          enabled: true,
          baseUrl: 'http://backend',
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
      bindings: [{ agentId: 'cuz', match: { channel: 'commonly', accountId: 'cuz' } }],
    };

    k8s.__mock.readNamespacedConfigMap.mockResolvedValueOnce({
      body: { data: { 'moltbot.json': JSON.stringify(staleConfig) } },
    });

    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      baseUrl: 'http://backend',
      displayName: 'Cuz',
      heartbeat: null,
    });

    const calls = k8s.__mock.replaceNamespacedConfigMap.mock.calls;
    const configMapPayload = calls[calls.length - 1][2];
    const raw = configMapPayload?.data?.['moltbot.json'];
    const config = JSON.parse(raw);
    const agentEntry = config.agents.list.find((agent) => agent.id === 'cuz');
    expect(agentEntry.workspace).toBe('/workspace/cuz');
  });

  it('sets default heartbeat prompt that requires commonly reads before HEARTBEAT_OK', async () => {
    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      baseUrl: 'http://backend',
      displayName: 'Cuz',
      heartbeat: { enabled: true, everyMinutes: 10 },
    });

    const calls = k8s.__mock.replaceNamespacedConfigMap.mock.calls;
    const configMapPayload = calls[calls.length - 1][2];
    const raw = configMapPayload?.data?.['moltbot.json'];
    const config = JSON.parse(raw);
    const agentEntry = config.agents.list.find((agent) => agent.id === 'cuz');

    expect(agentEntry.heartbeat.prompt).toContain('Read current pod activity');
    expect(agentEntry.heartbeat.prompt).toContain('runtime-token');
    expect(agentEntry.heartbeat.session).toBe('heartbeat');
    expect(config.agents.defaults.memorySearch.enabled).toBe(true);
    expect(config.agents.defaults.memorySearch.sources).toEqual(['memory']);
    expect(config.agents.defaults.contextPruning.mode).toBe('cache-ttl');
    expect(config.agents.defaults.contextPruning.ttl).toBe('90m');
    expect(config.agents.defaults.contextPruning.keepLastAssistants).toBe(2);
    expect(config.agents.defaults.model.primary).toBe('openai-codex/gpt-5.4-mini');
    expect(config.agents.defaults.model.fallbacks).toEqual(
      expect.arrayContaining(['openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'google/gemini-2.5-flash']),
    );
  });
});
