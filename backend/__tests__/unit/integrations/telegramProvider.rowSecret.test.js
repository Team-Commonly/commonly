/**
 * TASK-141 — the Telegram provider is not a second verification gate.
 *
 * `routes/webhooks/telegram.ts` verifies the `x-telegram-bot-api-secret-token`
 * header against `TELEGRAM_SECRET_TOKEN` and fails closed when it is unset
 * (`:66-87`, `:415`). The provider's `events` handler is reached only from that
 * route (`:513`, on a row without `liveRelay`) — and it re-verified against
 * `config.secretToken`, so an update the route had just accepted was 401'd here
 * whenever the row carried a different copy. That is `slackProvider.ts`'s
 * disagreement one connector over (Vera 74294): there the reader was made
 * env-only, here the duplicate gate is deleted, because the route's check is
 * env-only and fail-closed and this one can only ever reject.
 *
 * The witness is that the handler buffers regardless of the row's copy: restore
 * the block and this test 401s instead of writing. (The route's own fail-closed
 * behaviour is covered in `__tests__/unit/routes/telegram.webhook.test.js`.)
 */
jest.mock('../../../models/Integration', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/integrationSummaryService', () => ({ createSummary: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));

const Integration = require('../../../models/Integration');
const createTelegramProvider = require('../../../integrations/providers/telegramProvider');

const buildRes = () => ({
  status: jest.fn().mockReturnThis(),
  send: jest.fn(),
  sendStatus: jest.fn(),
  json: jest.fn(),
});

const messageUpdate = () => ({
  update_id: 100,
  message: {
    message_id: 7,
    date: 1700000000,
    chat: { id: 42, type: 'private' },
    from: { id: 9, first_name: 'Sam', is_bot: false },
    text: 'hello',
  },
});

describe('Telegram provider — the row carries no verification key (TASK-141)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Integration.findByIdAndUpdate.mockResolvedValue({});
  });

  it('buffers an update the route accepted, whatever copy the row carries', async () => {
    const provider = createTelegramProvider({
      _id: 'tg-1',
      config: { chatId: '42', secretToken: 'row-planted-secret' },
    });
    const res = buildRes();

    await provider.getWebhookHandlers().events({
      headers: { 'x-telegram-bot-api-secret-token': 'instance-secret' },
      body: messageUpdate(),
    }, res);

    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      'tg-1',
      expect.objectContaining({ $push: expect.any(Object) }),
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('does not refuse a request for a missing header — that decision is the route\'s', async () => {
    const provider = createTelegramProvider({
      _id: 'tg-2',
      config: { chatId: '42', secretToken: 'row-planted-secret' },
    });
    const res = buildRes();

    await provider.getWebhookHandlers().events({ headers: {}, body: messageUpdate() }, res);

    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});
