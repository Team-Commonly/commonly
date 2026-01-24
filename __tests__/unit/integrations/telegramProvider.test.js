const createTelegramProvider = require('../../backend/integrations/providers/telegramProvider');
const Integration = require('../../backend/models/Integration');

jest.mock('../../backend/models/Integration');

describe('telegramProvider', () => {
  const integration = { _id: 'int1', config: { botToken: 'token', secretToken: 'secret', maxBufferSize: 2 } };
  const provider = createTelegramProvider(integration);

  test('validateConfig requires botToken', async () => {
    const bad = createTelegramProvider({ config: {} });
    await expect(bad.validateConfig()).rejects.toThrow(/Missing fields/);
  });

  test('rejects invalid secret token', async () => {
    const { events } = provider.getWebhookHandlers();
    const req = { headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: {} };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await events(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('accepts valid secret token and buffers', async () => {
    Integration.findByIdAndUpdate.mockResolvedValue({});
    const { events } = provider.getWebhookHandlers();
    const req = {
      headers: { 'x-telegram-bot-api-secret-token': 'secret' },
      body: { message: { message_id: 1, from: { id: 2, first_name: 'T' }, text: 'hi', date: 1700000000 } },
    };
    const res = { sendStatus: jest.fn() };
    await events(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('ingestEvent normalizes message', async () => {
    const payload = { message: { message_id: 9, from: { id: 3, first_name: 'Al' }, text: 'hey' } };
    const events = await provider.ingestEvent(payload);
    expect(events[0]).toMatchObject({ authorId: '3', content: 'hey' });
  });
});

