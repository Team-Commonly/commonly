const LiteLLMClient = require('../../../../external/commonly-agent-services/shared/litellm-client');

// The client reads hosted gateway availability. It accepts no installations;
// there is currently no backend caller that rewrites local model selections.
describe('LiteLLM model listing', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it.each([200, 401, 503])('returns models or rejects gateway status %s', async (status) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: status === 200,
      status,
      json: async () => ({ data: [{ id: 'deepseek-v4-flash' }] }),
    });
    const client = new LiteLLMClient({ baseUrl: 'http://fake-litellm', apiKey: 'test-key' });
    if (status === 200) await expect(client.listModels()).resolves.toEqual([{ id: 'deepseek-v4-flash' }]);
    else await expect(client.listModels()).rejects.toThrow(`Failed to list models: ${status}`);
    expect(global.fetch).toHaveBeenCalledWith('http://fake-litellm/v1/models', expect.any(Object));
  });
});
