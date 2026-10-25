const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const LiteLLMClient = require('../../../../external/commonly-agent-services/shared/litellm-client');

// D76: gateway model availability describes hosted routes. Local CLI model
// selections must survive both disappearance of Claude routes and gateway failure.
describe('LiteLLM availability preserves BYO installation models', () => {
  let mongo;
  let collection;
  const originalFetch = global.fetch;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri('d76-byo'));
    collection = mongoose.connection.collection('agentinstallations');
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    await mongoose.disconnect();
    await mongo.stop();
  });

  it.each([200, 401, 503])('does not rewrite local or unknown tiers when model listing returns %s', async (status) => {
    await collection.deleteMany({});
    await collection.insertMany(['claude-code', 'codex', 'webhook', 'wrapper', undefined].map((runtimeType) => ({
      config: {
        runtime: { ...(runtimeType ? { runtimeType } : {}), model: 'claude-haiku-4-5' },
        environment: { model: 'claude-sonnet-4-6' },
      },
    })));
    const before = await collection.find({}).toArray();
    global.fetch = jest.fn().mockResolvedValue({
      ok: status === 200,
      status,
      json: async () => ({ data: [{ id: 'deepseek-v4-flash' }] }),
    });
    const client = new LiteLLMClient({ baseUrl: 'http://fake-litellm', apiKey: 'test-key' });
    try {
      if (status === 200) await expect(client.listModels()).resolves.toEqual([{ id: 'deepseek-v4-flash' }]);
      else await expect(client.listModels()).rejects.toThrow(`Failed to list models: ${status}`);
      expect(global.fetch).toHaveBeenCalledWith('http://fake-litellm/v1/models', expect.any(Object));
      expect(await collection.find({}).toArray()).toEqual(before);
    } finally { global.fetch = originalFetch; }
  });
});
