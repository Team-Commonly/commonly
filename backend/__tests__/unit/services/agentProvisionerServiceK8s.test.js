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
    // Every `sh -lc` script the provisioner runs inside the gateway pod. The
    // HEARTBEAT.md the fleet actually receives is a base64 blob inside one of
    // these, so this is the only place a test can assert on the delivered file
    // rather than on the source that composes it.
    readNamespacedPodLog: jest.fn(),
    execCommands: [],
    execArgv: [],
    // What the next exec writes to its stdout sink; empty = no output.
    execStdout: '',
    execStatus: { status: 'Success' },
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
        readNamespacedPodLog: mock.readNamespacedPodLog,
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
      mock.execCommands.push(Array.isArray(_command) ? _command.join(' ') : String(_command));
      mock.execArgv.push(_command);
      if (mock.execStdout && _stdout && typeof _stdout.write === 'function') {
        _stdout.write(mock.execStdout);
        if (typeof statusCallback === 'function') setImmediate(() => statusCallback({ status: 'Success' }));
        return Promise.resolve();
      }
      if (typeof statusCallback === 'function') {
        statusCallback(mock.execStatus);
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
const {
  restartAgentRuntime, provisionAgentRuntime, buildPvcVirtualKeyReadScript, issueLiteLLMVirtualKey, issueLiteLLMOpenRouterKey,
  readOpenClawIdentityFile, getAgentRuntimeLogs,
} = require('../../../services/agentProvisionerServiceK8s');
const { CYCLES_DIRECTIVE_MARKER } = require('../../../routes/registry/presets');

describe('agentProvisionerServiceK8s', () => {
  beforeEach(() => {
    k8s.__mock.readNamespacedDeployment.mockClear();
    k8s.__mock.replaceNamespacedDeployment.mockClear();
  });

  it('distinguishes missing identities from read and parent-access failures', async () => {
    k8s.__mock.execStatus = { status: 'Failure', message: 'Permission denied' };
    try {
      await expect(readOpenClawIdentityFile('curator')).rejects.toThrow('Permission denied');
      const command = k8s.__mock.execArgv.at(-1);
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { spawnSync } = require('child_process');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reader-'));
      const identity = path.join(dir, 'IDENTITY.md');
      const run = () => spawnSync(process.execPath, [...command.slice(1, -1), identity], { encoding: 'utf8' });
      try {
        expect(run().status).toBe(0);
        fs.writeFileSync(identity, 'Name: Curator');
        const read = run();
        expect(read.status).toBe(0);
        expect(read.stdout).toBe('Name: Curator');
        fs.chmodSync(dir, 0o000);
        const inaccessible = run();
        expect(inaccessible.status).not.toBe(0);
        expect(inaccessible.stderr).toContain('EACCES');
        fs.chmodSync(dir, 0o700);
        fs.unlinkSync(identity);
        fs.mkdirSync(identity);
        expect(run().status).not.toBe(0);
      } finally {
        fs.chmodSync(dir, 0o700);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      k8s.__mock.execStatus = { status: 'Success' };
    }
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

  it('never emits heartbeat.global/fixedPod (openclaw HeartbeatSchema is strict)', async () => {
    // Regression for the 2026-06-28 fleet outage: emitting `global` made the
    // gateway fail openclaw's strict HeartbeatSchema validation and crash-loop
    // ("Unrecognized key: global"). The provisioner must translate everyMinutes
    // into `every` and drop global/fixedPod entirely.
    await provisionAgentRuntime({
      runtimeType: 'moltbot',
      agentName: 'openclaw',
      instanceId: 'cuz',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      baseUrl: 'http://backend',
      displayName: 'Cuz',
      heartbeat: { global: true, fixedPod: true, everyMinutes: 30, prompt: 'hb', session: 'heartbeat' },
    });

    const calls = k8s.__mock.replaceNamespacedConfigMap.mock.calls;
    const configMapPayload = calls[calls.length - 1][2];
    const config = JSON.parse(configMapPayload.data['moltbot.json']);
    const agent = config.agents.list.find((a) => a.id === 'cuz');
    expect(agent).toBeTruthy();
    expect(agent.heartbeat).toBeTruthy();
    expect(agent.heartbeat.every).toBe('30m');
    expect(agent.heartbeat).not.toHaveProperty('global');
    expect(agent.heartbeat).not.toHaveProperty('fixedPod');
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
      // The Slack env token is retired (TASK-151): it must not create the key.
      expect(config.channels.slack).toBeUndefined();
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

  // TASK-151 witness: the WHOLE Slack block had to go, not just the token
  // assignments — with only the signing secret set, a block that kept its
  // signing-secret read would still create `channels.slack`.
  it('creates no slack channel when only the signing secret is set', async () => {
    process.env.SLACK_SIGNING_SECRET = 'env-slack-signing-secret';
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

      const { calls } = k8s.__mock.replaceNamespacedConfigMap.mock;
      const [, , configMapPayload] = calls[calls.length - 1];
      const config = JSON.parse(configMapPayload?.data?.['moltbot.json']);
      expect(config.channels.slack).toBeUndefined();
    } finally {
      delete process.env.SLACK_SIGNING_SECRET;
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
    // Community agents (cuz is not in DEFAULT_DEV_AGENT_IDS) inherit the
    // gateway-level default — nemotron, no openai-codex. Codex is gated to
    // dev agents via the per-agent override in provisionOpenClawAccount.
    expect(config.agents.defaults.model.primary).toBe('openrouter/nvidia/nemotron-3-super-120b-a12b:free');
    // Trinity removed 2026-05-03 (deregistered at OpenRouter, 404). Gemini
    // entries remain as inert placeholders until GEMINI_API_KEY is reinstated.
    expect(config.agents.defaults.model.fallbacks).toEqual(
      expect.arrayContaining(['google/gemini-2.5-flash']),
    );
    expect(config.agents.defaults.model.fallbacks).not.toContain('openrouter/arcee-ai/trinity-large-preview:free');
    expect(config.agents.defaults.model.fallbacks).not.toContain('openai-codex/gpt-5.4-mini');
    expect(config.agents.defaults.model.fallbacks).not.toContain('openai-codex/gpt-5.4');
  });
});

describe('HEARTBEAT.md delivery — cycle directive reaches unmatched agents', () => {
  // 2026-08-04: 10 of 27 deployed moltbots had no cycle directive in their
  // HEARTBEAT.md. The trailer was applied only to `matchedPreset.heartbeatTemplate`
  // at the two registry call sites; preset ids are role names, the fallback match
  // is `p.id === instanceId`, so every agent installed without an explicit
  // `presetId` fell through to the raw default. These tests assert on the file
  // content actually written into the pod, because the defect was invisible at
  // every layer above it — the constant was correct the whole time.
  const heartbeatWrites = () => k8s.__mock.execCommands
    .filter((cmd) => cmd.includes('HEARTBEAT.md'));

  // The provisioner ships the file as base64 to survive shell quoting; decode it
  // back so assertions read the agent-visible text rather than the transport.
  const decodeWrittenFiles = (script) => (script.match(/'([A-Za-z0-9+/=]{64,})'/g) || [])
    .map((chunk) => Buffer.from(chunk.slice(1, -1), 'base64').toString('utf8'));

  beforeEach(() => {
    k8s.__mock.execCommands.length = 0;
  });

  const provisionWithoutPreset = () => provisionAgentRuntime({
    runtimeType: 'moltbot',
    agentName: 'openclaw',
    instanceId: 'cuz',
    runtimeToken: 'cm_agent_test',
    userToken: 'cm_user_test',
    baseUrl: 'http://backend',
    displayName: 'Cuz',
    // No customContent: this is the no-preset-matched path, the one 10 agents took.
    heartbeat: { everyMinutes: 30 },
  });

  it('writes the cycle directive even when no preset matched', async () => {
    await provisionWithoutPreset();

    const writes = heartbeatWrites();
    expect(writes.length).toBeGreaterThan(0);

    const delivered = writes.flatMap(decodeWrittenFiles).filter((f) => f.includes('HEARTBEAT'));
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.some((f) => f.includes(CYCLES_DIRECTIVE_MARKER))).toBe(true);
    expect(delivered.some((f) => f.includes('commonly_log_cycle'))).toBe(true);
  });

  it('never names a tool that cannot append to cycles', async () => {
    await provisionWithoutPreset();

    const delivered = heartbeatWrites().flatMap(decodeWrittenFiles).join('\n');
    // theo's fossil file told agents to append cycles via commonly_write_agent_memory
    // (writes the whole envelope) and commonly_save_my_memory({sections:{cycles}})
    // (400s — no such section). Neither may appear as the cycles writer.
    expect(delivered).not.toMatch(/cycles[^\n]*commonly_write_agent_memory/i);
    expect(delivered).not.toMatch(/commonly_save_my_memory\s*\(\s*\{\s*sections/);
  });

  it('treats a file missing the directive as stale, so existing agents get rewritten', async () => {
    await provisionWithoutPreset();

    // Without this clause the only rewrite triggers are two 2026-era marker
    // strings, so a pre-trailer HEARTBEAT.md survives every reprovision forever.
    const script = heartbeatWrites().find((cmd) => cmd.includes('grep'));
    expect(script).toBeDefined();
    expect(script).toContain(`! grep -qF "${CYCLES_DIRECTIVE_MARKER}"`);
  });
});

// The reuse read that decides whether a reprovision mints a new LiteLLM key.
// Reading only openai-codex:codex-cli (the JWT slot under CODEX_BYPASS_LITELLM)
// never found the key, so every reprovision minted one: 5,891 orphans by 07-01.
describe('buildPvcVirtualKeyReadScript', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const vm = require('vm');
  const { execFileSync } = require('child_process');

  let stateDir;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvc-key-'));
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const writeProfiles = (agentId, profiles) => {
    const dir = path.join(stateDir, 'agents', agentId, 'agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth-profiles.json'), JSON.stringify({ profiles }));
  };
  const read = (agentId) => execFileSync('sh', ['-c', buildPvcVirtualKeyReadScript(agentId, stateDir)]).toString();

  it('finds the virtual key in openrouter:default when codex-cli holds the ChatGPT JWT', () => {
    writeProfiles('liz', {
      'openrouter:default': { key: 'sk-virtual-liz' },
      'openai-codex:codex-cli': { access: 'eyJhbGciOiJSUzI1NiJ9.jwt' },
    });
    expect(read('liz')).toBe('sk-virtual-liz');
  });

  it('falls back to codex-cli.access, and never returns a real OpenRouter key', () => {
    writeProfiles('theo', {
      'openrouter:default': { key: 'sk-or-v1-real-openrouter' },
      'openai-codex:codex-cli': { access: 'sk-virtual-theo' },
    });
    expect(read('theo')).toBe('sk-virtual-theo');
  });

  it('prints nothing when there is no profile file', () => {
    expect(read('nobody')).toBe('');
  });

  it('is plain JavaScript, so it parses on a gateway Node that does not strip types', () => {
    const script = buildPvcVirtualKeyReadScript('liz');
    const body = script.slice('node -e "'.length, -1);
    expect(() => new vm.Script(body)).not.toThrow();
  });
});

// The issuance-failure fallback writes LITELLM_MASTER_KEY into the same slots
// the reuse read looks at. The dev issuer has no master-key guard of its own,
// so the read must never return it: otherwise the master key goes to
// /key/info and then /key/delete.
describe('issueLiteLLMVirtualKey never sends the master key to LiteLLM', () => {
  const axios = require('axios');
  const MASTER = 'sk-master-for-test';
  let saved;
  beforeEach(() => {
    saved = { base: process.env.LITELLM_BASE_URL, master: process.env.LITELLM_MASTER_KEY };
    process.env.LITELLM_BASE_URL = 'http://litellm:4000';
    process.env.LITELLM_MASTER_KEY = MASTER;
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { info: { metadata: { agent_id: 'theo' } } } });
    jest.spyOn(axios, 'delete').mockResolvedValue({});
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { key: 'sk-freshly-issued' } });
  });
  afterEach(() => {
    k8s.__mock.execStdout = '';
    jest.restoreAllMocks();
    if (saved.base === undefined) delete process.env.LITELLM_BASE_URL; else process.env.LITELLM_BASE_URL = saved.base;
    if (saved.master === undefined) delete process.env.LITELLM_MASTER_KEY; else process.env.LITELLM_MASTER_KEY = saved.master;
  });

  it('with the master key in openrouter:default, makes no /key/info or /key/delete call and mints a fresh key', async () => {
    k8s.__mock.execStdout = MASTER; // what the read script prints for that profile

    const key = await issueLiteLLMVirtualKey('theo');

    expect(key).toBe('sk-freshly-issued');
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.delete).not.toHaveBeenCalled();
    for (const [url] of axios.post.mock.calls) expect(url).not.toContain(MASTER);
  });

  it('control: an ordinary virtual key IS checked with /key/info and reused', async () => {
    k8s.__mock.execStdout = 'sk-virtual-theo';

    const key = await issueLiteLLMVirtualKey('theo');

    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/key/info?key=sk-virtual-theo'), expect.anything());
    expect(key).toBe('sk-virtual-theo');
  });

  // D111: these keys now route to a paid model, and the $60 group budget is on
  // the deepseek-v4-flash model name, which alias callers never touch.
  it('mints a fresh key with a monthly spend budget', async () => {
    k8s.__mock.execStdout = '';

    await issueLiteLLMVirtualKey('theo');

    const [url, body] = axios.post.mock.calls.find(([u]) => u.endsWith('/key/generate'));
    expect(url).toBe('http://litellm:4000/key/generate');
    // Sized above the heaviest agent's measured monthly (~$88/mo) with headroom;
    // a bare max_budget is lifetime in LiteLLM, so budget_duration is required.
    expect(body.max_budget).toBe(150);
    expect(body.budget_duration).toBe('30d');
  });

  it('mints a fresh community key with the same monthly spend budget', async () => {
    k8s.__mock.execStdout = '';

    await issueLiteLLMOpenRouterKey('community-agent');

    const [url, body] = axios.post.mock.calls.find(([u]) => u.endsWith('/key/generate'));
    expect(url).toBe('http://litellm:4000/key/generate');
    expect(body.user_id).toBe('community-agent');
    expect(body.max_budget).toBe(150);
    expect(body.budget_duration).toBe('30d');
  });

  // 2026-10-28 key audit found 73 keys with no alias — attribution had to lean on
  // user_id. Both mint paths now stamp a unique, human-readable key_alias so a
  // key is traceable to its agent, and the uniqueness suffix avoids a 409 on
  // delete-then-remint for the same agent (which would silently fail the seat).
  it('stamps a unique, attributable key_alias on the virtual key', async () => {
    k8s.__mock.execStdout = '';

    await issueLiteLLMVirtualKey('theo');

    const [, body] = axios.post.mock.calls.find(([u]) => u.endsWith('/key/generate'));
    expect(body.key_alias).toMatch(/^agent-theo-\d+-[0-9a-f]{12}$/);
  });

  it('stamps a unique, attributable key_alias on the community/openrouter key', async () => {
    k8s.__mock.execStdout = '';

    await issueLiteLLMOpenRouterKey('community-agent');

    const [, body] = axios.post.mock.calls.find(([u]) => u.endsWith('/key/generate'));
    expect(body.key_alias).toMatch(/^agent-community-agent-openrouter-\d+-[0-9a-f]{12}$/);
  });
});



describe('runtime account log filtering', () => {
  const { buildRuntimeLogFilters } = require('../../../routes/registry/helpers');
  it.each([['bob', 'default', 'bob-default'], ['openclaw', 'default', 'default']])(
    'returns only the exact account tag for %s', async (agentName, instanceId, accountId) => {
      const own = `[commonly] [${accountId}] own line`;
      const peerId = accountId === 'default' ? 'bob-default' : 'default';
      k8s.__mock.readNamespacedPodLog.mockResolvedValue({ body: [
        own, `[commonly] [${peerId}] peer line`, `[commonly] [${accountId}-other] suffix peer`,
        `[commonly] [${peerId}] content repeats [commonly] [${accountId}] marker`,
        `diagnostic mentions ${accountId}`, `[commonly] [elsewhere] text mentions ${accountId}`,
      ].join('\n') });
      const filterTokens = buildRuntimeLogFilters({ runtimeType: 'moltbot', agentName, instanceId });
      expect(filterTokens).toEqual([accountId]);
      const result = await getAgentRuntimeLogs('moltbot', instanceId, 200, { filterTokens });
      expect(result.logs).toBe(own);
    },
  );
});
