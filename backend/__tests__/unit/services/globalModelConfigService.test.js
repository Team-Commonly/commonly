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
    expect(result).not.toHaveProperty('openclaw');
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

    // F105: with no chat model set, the llmService default follows the
    // configured agent default, never a Gemini name.
    it('follows AGENT_DEFAULT_MODEL when no chat model is set', async () => {
      const savedAgent = process.env.AGENT_DEFAULT_MODEL;
      delete process.env.LITELLM_CHAT_MODEL;
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      try {
        stored(null);
        const result = await GlobalModelConfigService.getConfig();
        expect(result.llmService.model).toBe('claude-haiku-5-5');
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
      } finally {
        if (savedAgent === undefined) delete process.env.AGENT_DEFAULT_MODEL;
        else process.env.AGENT_DEFAULT_MODEL = savedAgent;
      }
    });

  });

  // ADR-021: the OpenClaw gateway and its model section are retired. A stored
  // section is neither read nor deleted.
  describe('the stored openclaw section', () => {
    const original = process.env.AGENT_DEFAULT_MODEL;
    afterEach(() => {
      if (original === undefined) delete process.env.AGENT_DEFAULT_MODEL;
      else process.env.AGENT_DEFAULT_MODEL = original;
    });
    const stored = (value) => SystemSetting.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValueOnce(value ? { key: 'llm.globalModelConfig', value } : null),
    });
    const savedValue = () => SystemSetting.findOneAndUpdate.mock.calls[0][1].$set.value;

    it('is not read into the resolved config', async () => {
      stored({ openclaw: { provider: 'google', model: 'google/gemini-2.5-flash' } });
      const result = await GlobalModelConfigService.getConfig();
      expect(result).not.toHaveProperty('openclaw');
      expect(GlobalModelConfigService.defaults()).not.toHaveProperty('openclaw');
    });

    it('a save over a row with no openclaw section writes none', async () => {
      stored(null);
      await GlobalModelConfigService.setConfig({ llmService: { provider: 'auto' } });
      expect(savedValue()).not.toHaveProperty('openclaw');
    });

    it('a save that sends an openclaw section does not store it', async () => {
      stored(null);
      await GlobalModelConfigService.setConfig({ llmService: { provider: 'auto' }, openclaw: { provider: 'google' } });
      expect(savedValue()).not.toHaveProperty('openclaw');
    });

    // ADR-021 Part B: the admin screen no longer sends an openclaw section, so
    // a save that names only llmService must keep the stored one as it was.
    it('a save with no openclaw section keeps the stored openclaw settings', async () => {
      process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
      const openclaw = {
        provider: 'google',
        model: 'google/gemini-2.5-flash',
        fallbackModels: ['google/gemini-2.0-flash'],
        devAgentIds: ['theo', 'nova'],
        communityAgentModel: { primary: 'openrouter/some-pick', fallbacks: ['openrouter/other'] },
      };
      stored({ openclaw });

      await GlobalModelConfigService.setConfig({ llmService: { provider: 'auto', model: 'claude-haiku-5-5' } });

      expect(savedValue().openclaw).toEqual(expect.objectContaining(openclaw));
    });

  });

  describe('llmService provider defaults', () => {
    const stored = (value) => SystemSetting.findOne.mockReturnValueOnce({
      lean: jest.fn().mockResolvedValueOnce(value ? { key: 'llm.globalModelConfig', value } : null),
    });
    const savedValue = () => SystemSetting.findOneAndUpdate.mock.calls[0][1].$set.value;

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
