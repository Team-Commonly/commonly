const fs = require('fs');
const os = require('os');
const path = require('path');
const { provisionAgentRuntime } = require('../../../services/agentProvisionerService');

// The OpenClaw (moltbot) cases left with that driver (ADR-021). What stays is
// the Commonly bot account file the internal runtime reads.
describe('agentProvisionerService', () => {
  const tempDir = path.join(os.tmpdir(), 'commonly-agent-provisioner-tests');
  const commonlyConfigPath = path.join(tempDir, 'commonly-bot.json');

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    if (fs.existsSync(commonlyConfigPath)) fs.unlinkSync(commonlyConfigPath);
    process.env.COMMONLY_BOT_CONFIG_PATH = commonlyConfigPath;
    process.env.AGENT_PROVISIONER_K8S = '0';
  });

  afterAll(() => {
    delete process.env.COMMONLY_BOT_CONFIG_PATH;
    delete process.env.AGENT_PROVISIONER_K8S;
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

  it('keeps a Commonly bot account\'s saved tokens when a reprovision has none to give', async () => {
    // A stored token is a hash, so reissuing an existing one returns no bearer.
    fs.writeFileSync(commonlyConfigPath, JSON.stringify({
      accounts: { default: { runtimeToken: 'cm_agent_saved', userToken: 'cm_user_saved' } },
    }));
    await provisionAgentRuntime({
      runtimeType: 'internal',
      agentName: 'commonly-summarizer',
      instanceId: 'default',
      runtimeToken: null,
      userToken: null,
    });
    const kept = JSON.parse(fs.readFileSync(commonlyConfigPath, 'utf8')).accounts.default;
    expect(kept.runtimeToken).toBe('cm_agent_saved');
    expect(kept.userToken).toBe('cm_user_saved');

    await provisionAgentRuntime({
      runtimeType: 'internal',
      agentName: 'commonly-summarizer',
      instanceId: 'default',
      runtimeToken: 'cm_agent_new',
      userToken: 'cm_user_new',
    });
    const replaced = JSON.parse(fs.readFileSync(commonlyConfigPath, 'utf8')).accounts.default;
    expect(replaced.runtimeToken).toBe('cm_agent_new');
    expect(replaced.userToken).toBe('cm_user_new');
  });

  it('writes no gateway config for a moltbot runtime: provisioning refuses it', async () => {
    await expect(provisionAgentRuntime({
      runtimeType: 'moltbot', agentName: 'openclaw', instanceId: 'theo', runtimeToken: 'cm_agent_x', userToken: null,
    })).rejects.toThrow('Provisioning not supported for runtime: moltbot');
    expect(fs.existsSync(commonlyConfigPath)).toBe(false);
  });
});
