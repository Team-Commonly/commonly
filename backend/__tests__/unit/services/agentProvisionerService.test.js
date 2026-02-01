const fs = require('fs');
const path = require('path');
const { provisionAgentRuntime } = require('../../../services/agentProvisionerService');

describe('agentProvisionerService', () => {
  const tempDir = path.join(__dirname, '../../../__tests__/tmp');
  const openclawConfigPath = path.join(tempDir, 'moltbot.json');
  const commonlyConfigPath = path.join(tempDir, 'commonly-bot.json');

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    if (fs.existsSync(openclawConfigPath)) fs.unlinkSync(openclawConfigPath);
    if (fs.existsSync(commonlyConfigPath)) fs.unlinkSync(commonlyConfigPath);
    process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
    process.env.COMMONLY_BOT_CONFIG_PATH = commonlyConfigPath;
  });

  afterAll(() => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.COMMONLY_BOT_CONFIG_PATH;
  });

  it('writes OpenClaw account config', () => {
    const result = provisionAgentRuntime({
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
    expect(agentEntry.workspace).toBe('/home/node/clawd/cuz');
  });

  it('removes stale OpenClaw account entries for the same agent instance', () => {
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

    provisionAgentRuntime({
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

  it('writes Commonly bot runtime config', () => {
    const result = provisionAgentRuntime({
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
});
