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
    expect(result.llmService.model).toBe('gemini-2.5-flash');
    expect(result.llmService.openrouter).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: '',
    });
    expect(result.openclaw.provider).toBe('google');
    expect(result.openclaw.model).toBe('google/gemini-2.5-flash');
    expect(result.openclaw.fallbackModels).toEqual([
      'google/gemini-2.5-flash-lite',
      'google/gemini-2.0-flash',
    ]);
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
});
