const createGroupMeProvider = require('../../backend/integrations/providers/groupmeProvider');
const Integration = require('../../backend/models/Integration');

jest.mock('../../backend/models/Integration');

describe('groupmeProvider', () => {
  const integration = { _id: 'int1', config: { botId: 'bot', groupId: '123', maxBufferSize: 2 } };
  const provider = createGroupMeProvider(integration);

  test('validateConfig throws on missing fields', async () => {
    const bad = createGroupMeProvider({ config: {} });
    await expect(bad.validateConfig()).rejects.toThrow(/Missing fields/);
  });

  test('events rejects wrong group', async () => {
    const { events } = provider.getWebhookHandlers();
    const req = { body: { group_id: '999' } };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await events(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('events ignores bot messages and succeeds', async () => {
    Integration.findByIdAndUpdate.mockResolvedValue({});
    const { events } = provider.getWebhookHandlers();
    const req = { body: { group_id: '123', sender_type: 'bot' } };
    const res = { sendStatus: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
    await events(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('ingestEvent normalizes user message', async () => {
    const payload = {
      id: 'm1',
      user_id: 'u1',
      name: 'User',
      text: 'hello',
      created_at: 1700000000,
    };
    const events = await provider.ingestEvent(payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ authorId: 'u1', content: 'hello' });
  });
});

