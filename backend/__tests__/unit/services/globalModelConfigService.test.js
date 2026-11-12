jest.mock('../../../models/SystemSetting', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const SystemSetting = require('../../../models/SystemSetting');
const GlobalModelConfigService = require('../../../services/globalModelConfigService');

describe('globalModelConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    GlobalModelConfigService.resetCache();
  });

  it('returns defaults when no setting exists', async () => {
    SystemSetting.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValueOnce(null),
    });
    const result = await GlobalModelConfigService.getConfig();
    expect(result.llmService.provider).toBe('auto');
    // F105: no default names a Gemini name LiteLLM served with DeepSeek.
    expect(result.llmService.model).toBe('deepseek-v4-flash');
    expect(result.llmService.openrouter).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: '',
    });
    expect(result.openclaw.provider).toBe('openrouter');
    expect(result.openclaw.model).toBe('openrouter/deepseek-v4-flash');
    expect(result.openclaw.fallbackModels).toEqual([]);
  });

  it('drops stored OpenRouter key and keeps only routing fields', async () => {
    SystemSetting.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValueOnce({
        key: 'llm.globalModelConfig',
        value: {
          llmService: {
            provider: 'openrouter',
            model: 'openai/gpt-4.1-mini',
            openrouter: {
              baseUrl: 'https://openrouter.ai/api/v1',
              model: 'openai/gpt-4.1-mini',
              apiKey: 'sk-or-existing',
            },
          },
          openclaw: {
            provider: 'google',
            model: 'google/gemini-2.5-flash',
            fallbackModels: ['google/gemini-2.0-flash'],
          },
        },
      }),
    });
    SystemSetting.findOneAndUpdate.mockResolvedValueOnce({});

    const result = await GlobalModelConfigService.setConfig({
      llmService: {
        provider: 'openrouter',
        model: 'openai/gpt-4.1-nano',
        openrouter: {
          model: 'openai/gpt-4.1-nano',
          apiKey: 'sk-or-new-value',
        },
      },
    }, 'u1');

    expect(SystemSetting.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'llm.globalModelConfig' },
      expect.objectContaining({
        $set: expect.objectContaining({
          value: expect.objectContaining({
            llmService: expect.objectContaining({
              openrouter: expect.objectContaining({
                model: 'openai/gpt-4.1-nano',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
    const updateArg = SystemSetting.findOneAndUpdate.mock.calls[0][1];
    expect(updateArg.$set.value.llmService.openrouter.apiKey).toBeUndefined();
    expect(result.llmService.openrouter.apiKey).toBeUndefined();
  });

  it('normalizes openclaw openrouter models with provider prefix', async () => {
    SystemSetting.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValueOnce(null),
    });
    SystemSetting.findOneAndUpdate.mockResolvedValueOnce({});

    await GlobalModelConfigService.setConfig({
      openclaw: {
        provider: 'openrouter',
        model: 'arcee-ai/trinity-large-preview:free',
      },
    }, 'u1');

    const updateArg = SystemSetting.findOneAndUpdate.mock.calls[0][1];
    expect(updateArg.$set.value.openclaw.model).toBe('openrouter/arcee-ai/trinity-large-preview:free');
  });

  it('rejects an unsupported backend LLM provider instead of silently routing it to Gemini', async () => {
    await expect(GlobalModelConfigService.setConfig({
      llmService: { provider: 'openai' },
    }, 'u1')).rejects.toThrow('Unsupported backend LLM provider');

    expect(SystemSetting.findOne).not.toHaveBeenCalled();
    expect(SystemSetting.findOneAndUpdate).not.toHaveBeenCalled();
  });

  describe('LITELLM_CHAT_MODEL as the llmService default', () => {
    const original = process.env.LITELLM_CHAT_MODEL;
    afterEach(() => {
      if (original === undefined) delete process.env.LITELLM_CHAT_MODEL;
      else process.env.LITELLM_CHAT_MODEL = original;
    });

    const stored = (value) => SystemSetting.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValueOnce(value ? { key: 'llm.globalModelConfig', value } : null),
    });

    it('defaults an auto-routed llmService to the operator chat model when none is persisted', async () => {
      process.env.LITELLM_CHAT_MODEL = 'deepseek-v4-flash';
      stored(null);
      const result = await GlobalModelConfigService.getConfig();
      expect(result.llmService.model).toBe('deepseek-v4-flash');
    });

    it('keeps an admin-persisted model over the env default', async () => {
      process.env.LITELLM_CHAT_MODEL = 'deepseek-v4-flash';
      stored({ llmService: { provider: 'litellm', model: 'cloudflare/llama-3.1-8b' } });
      const result = await GlobalModelConfigService.getConfig();
      expect(result.llmService.model).toBe('cloudflare/llama-3.1-8b');
    });

    it('keeps a legacy persisted defaultModel over the env default', async () => {
      process.env.LITELLM_CHAT_MODEL = 'deepseek-v4-flash';
      stored({ llmService: { provider: 'auto', defaultModel: 'cloudflare/llama-3.1-8b' } });
      const result = await GlobalModelConfigService.getConfig();
      expect(result.llmService.model).toBe('cloudflare/llama-3.1-8b');
    });

    it('does not hand a LiteLLM model name to a Gemini-direct provider', async () => {
      process.env.LITELLM_CHAT_MODEL = 'deepseek-v4-flash';
      stored({ llmService: { provider: 'gemini' } });
      const result = await GlobalModelConfigService.getConfig();
      expect(result.llmService.model).toBe('gemini-2.5-flash');
    });

    // F105: with no chat model set, the llmService and OpenClaw defaults follow
    // the configured agent default, never a Gemini name.
    it('follows AGENT_DEFAULT_MODEL when no chat model is set, for llmService and OpenClaw', async () => {
      const savedAgent = process.env.AGENT_DEFAULT_MODEL;
      delete process.env.LITELLM_CHAT_MODEL;
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      try {
        stored(null);
        const result = await GlobalModelConfigService.getConfig();
        expect(result.llmService.model).toBe('claude-haiku-5-5');
        expect(result.openclaw.model).toBe('openrouter/claude-haiku-5-5');
        expect(result.openclaw.fallbackModels).toEqual([]);
      } finally {
        if (savedAgent === undefined) delete process.env.AGENT_DEFAULT_MODEL;
        else process.env.AGENT_DEFAULT_MODEL = savedAgent;
      }
    });

    it('prefers the chat model over the agent default for llmService', async () => {
      const savedAgent = process.env.AGENT_DEFAULT_MODEL;
      process.env.LITELLM_CHAT_MODEL = 'deepseek-flash-1017';
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      try {
        stored(null);
        const result = await GlobalModelConfigService.getConfig();
        expect(result.llmService.model).toBe('deepseek-flash-1017');
        expect(result.openclaw.model).toBe('openrouter/claude-haiku-5-5');
      } finally {
        if (savedAgent === undefined) delete process.env.AGENT_DEFAULT_MODEL;
        else process.env.AGENT_DEFAULT_MODEL = savedAgent;
      }
    });

    it('keeps a stored Gemini OpenClaw model an admin saved', async () => {
      stored({ openclaw: { provider: 'google', model: 'google/gemini-2.5-flash', fallbackModels: ['google/gemini-2.0-flash'] } });
      const result = await GlobalModelConfigService.getConfig();
      expect(result.openclaw.model).toBe('google/gemini-2.5-flash');
      expect(result.openclaw.fallbackModels).toEqual(['google/gemini-2.0-flash']);
    });
  });

  // F103: the community default names the configured model by its own name,
  // not the nemotron slug LiteLLM used to serve with DeepSeek.
  describe('AGENT_DEFAULT_MODEL as the community agent default', () => {
    const original = process.env.AGENT_DEFAULT_MODEL;
    afterEach(() => {
      if (original === undefined) delete process.env.AGENT_DEFAULT_MODEL;
      else process.env.AGENT_DEFAULT_MODEL = original;
    });
    const stored = (value) => SystemSetting.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValueOnce(value ? { key: 'llm.globalModelConfig', value } : null),
    });

    it.each([
      ['unset', undefined, 'openrouter/deepseek-v4-flash'],
      ['claude-haiku-5-5', 'claude-haiku-5-5', 'openrouter/claude-haiku-5-5'],
    ])('with AGENT_DEFAULT_MODEL %s, defaults() and an unpersisted config both name it', async (_label, env, primary) => {
      if (env === undefined) delete process.env.AGENT_DEFAULT_MODEL; else process.env.AGENT_DEFAULT_MODEL = env;
      stored(null);

      const result = await GlobalModelConfigService.getConfig();

      expect(result.openclaw.communityAgentModel).toEqual({ primary, fallbacks: [] });
      expect(GlobalModelConfigService.defaults().openclaw.communityAgentModel).toEqual({ primary, fallbacks: [] });
    });

    it('keeps an admin-persisted community primary over the env default', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored({ openclaw: { communityAgentModel: { primary: 'openrouter/some-admin-pick', fallbacks: [] } } });

      const result = await GlobalModelConfigService.getConfig();

      expect(result.openclaw.communityAgentModel.primary).toBe('openrouter/some-admin-pick');
    });

    // CodeRabbit on #3421: setConfig stores the resolved config, so without
    // this every admin save would pin today's default as an explicit choice.
    const savedValue = () => SystemSetting.findOneAndUpdate.mock.calls[0][1].$set.value;

    it('an admin save that leaves the community model at its default stores none, so it keeps following the env', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored(null);

      await GlobalModelConfigService.setConfig({ llmService: { provider: 'auto' } });

      expect(savedValue().openclaw).not.toHaveProperty('communityAgentModel');
    });

    it('an admin\'s own community model is stored', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored(null);

      await GlobalModelConfigService.setConfig({
        openclaw: { communityAgentModel: { primary: 'openrouter/some-admin-pick', fallbacks: [] } },
      });

      expect(savedValue().openclaw.communityAgentModel).toEqual({ primary: 'openrouter/some-admin-pick', fallbacks: [] });
    });

    // CodeRabbit on #3421: an admin's saved pick that later equals the
    // default is still their pick, so it survives saves and default changes.
    it.each([
      ['an unrelated save', { llmService: { provider: 'auto' } }],
      ['a save that posts the model back unchanged', { openclaw: { communityAgentModel: { primary: 'openrouter/claude-haiku-5-5', fallbacks: [] } } }],
    ])('an admin\'s pick that equals the default survives %s, and a later default change', async (_label, patch) => {
      const pick = { primary: 'openrouter/claude-haiku-5-5', fallbacks: [] };
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored({ openclaw: { communityAgentModel: pick } });

      await GlobalModelConfigService.setConfig(patch);
      expect(savedValue().openclaw.communityAgentModel).toEqual(pick);

      process.env.AGENT_DEFAULT_MODEL = 'claude-sonnet-5-5';
      stored(savedValue());
      const result = await GlobalModelConfigService.getConfig({ forceRefresh: true });
      expect(result.openclaw.communityAgentModel).toEqual(pick);
    });

    it('a save over the stored retired slug does not pin today\'s default', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored({ openclaw: { communityAgentModel: { primary: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', fallbacks: [] } } });

      await GlobalModelConfigService.setConfig({ llmService: { provider: 'auto' } });

      expect(savedValue().openclaw).not.toHaveProperty('communityAgentModel');
    });

    it('an admin\'s other nemotron pick is kept; only the retired default slug is mapped', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored({ openclaw: { communityAgentModel: { primary: 'openrouter/nvidia/nemotron-ultra-253b', fallbacks: [] } } });

      const result = await GlobalModelConfigService.getConfig();

      expect(result.openclaw.communityAgentModel.primary).toBe('openrouter/nvidia/nemotron-ultra-253b');
    });

    it('a stored nemotron community primary, retired in F103, reads as the default', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored({ openclaw: { communityAgentModel: { primary: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', fallbacks: [] } } });

      const result = await GlobalModelConfigService.getConfig();

      expect(result.openclaw.communityAgentModel.primary).toBe('openrouter/claude-haiku-5-5');
    });

    // F105: the OpenClaw model follows AGENT_DEFAULT_MODEL too, so a save must
    // not pin today's default into the row.
    it('an admin save that leaves the OpenClaw model at its default stores none, so it keeps following the env', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored(null);

      await GlobalModelConfigService.setConfig({ llmService: { provider: 'auto' } });

      expect(savedValue().openclaw).not.toHaveProperty('model');
      process.env.AGENT_DEFAULT_MODEL = 'deepseek-flash-1017';
      stored(savedValue());
      GlobalModelConfigService.resetCache();
      const later = await GlobalModelConfigService.getConfig();
      expect(later.openclaw.model).toBe('openrouter/deepseek-flash-1017');
    });

    it('an OpenClaw model the row already held stays stored', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored({ openclaw: { provider: 'google', model: 'google/gemini-2.5-flash' } });

      await GlobalModelConfigService.setConfig({ llmService: { provider: 'auto' } });

      expect(savedValue().openclaw.model).toBe('google/gemini-2.5-flash');
    });

    // CodeRabbit on #3972: the OpenClaw `google` provider calls Google directly,
    // so with no model it keeps a Gemini name rather than the OpenRouter route.
    it('a save that picks the google OpenClaw provider with no model gets a Gemini model', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored(null);

      const result = await GlobalModelConfigService.setConfig({ openclaw: { provider: 'google', model: '' } });

      expect(result.openclaw.model).toBe('google/gemini-2.5-flash');
      expect(savedValue().openclaw).not.toHaveProperty('model');
    });

    it('a saved google provider with no saved model reads as a Gemini model, also after a save that names no model', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      stored({ openclaw: { provider: 'google' } });
      expect((await GlobalModelConfigService.getConfig()).openclaw.model).toBe('google/gemini-2.5-flash');

      stored({ openclaw: { provider: 'google' } });
      const result = await GlobalModelConfigService.setConfig({ openclaw: { provider: 'openrouter' } });
      expect(result.openclaw.model).toBe('openrouter/claude-haiku-5-5');
    });

    it('the OpenRouter provider with no model takes OPENROUTER_MODEL', async () => {
      const saved = process.env.OPENROUTER_MODEL;
      process.env.OPENROUTER_MODEL = 'deepseek/deepseek-chat';
      try {
        stored({ llmService: { provider: 'openrouter' } });
        expect((await GlobalModelConfigService.getConfig()).llmService.model).toBe('deepseek/deepseek-chat');
      } finally {
        if (saved === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = saved;
      }
    });

    it('a save under the Gemini-direct provider with no model stores a Gemini name', async () => {
      stored(null);

      await GlobalModelConfigService.setConfig({ llmService: { provider: 'gemini', model: '' } });

      expect(savedValue().llmService.model).toBe('gemini-2.5-flash');
    });
  });
});
