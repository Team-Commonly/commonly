const createTelegramProvider = require('../../../integrations/providers/telegramProvider');
const Integration = require('../../../models/Integration');

jest.mock('../../../models/Integration');

describe('telegramProvider', () => {
  const integration = { _id: 'int1', config: { botToken: 'token', secretToken: 'secret', maxBufferSize: 2 } };
  const provider = createTelegramProvider(integration);

  test('validateConfig requires botToken', async () => {
    const bad = createTelegramProvider({ config: {} });
    await expect(bad.validateConfig()).rejects.toThrow(/Missing fields/);
  });

  test('buffers an update accepted by the webhook route', async () => {
    Integration.findByIdAndUpdate.mockResolvedValue({});
    const { events } = provider.getWebhookHandlers();
    const req = {
      headers: { 'x-telegram-bot-api-secret-token': 'secret' },
      body: { message: { message_id: 1, from: { id: 2, first_name: 'T' }, text: 'hi', date: 1700000000 } },
    };
    const res = { sendStatus: jest.fn() };
    await events(req, res);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('int1', {
      $push: {
        'config.messageBuffer': {
          $each: [expect.objectContaining({ content: 'hi' })],
          $slice: -2,
        },
      },
    });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('ingestEvent normalizes message', async () => {
    const payload = { message: { message_id: 9, from: { id: 3, first_name: 'Al' }, text: 'hey' } };
    const events = await provider.ingestEvent(payload);
    expect(events[0]).toMatchObject({ authorId: '3', content: 'hey' });
  });
});

