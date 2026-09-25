/* eslint-disable global-require, import/no-unresolved, import/extensions --
   the requires must follow jest.mock, and this corpus resolves TS through the TS parser */
// Row D: a permanent delivery failure must name itself on the connector, and
// only the connector that owns the chat may be flipped.
//
// The cases that matter are the ones where flipping would be WRONG: an inbound
// chat's failure (vera 73761), a content 400 (wren 73778), a 401 from the shared
// bot token, and a connector re-bound between the send and the classification.
// Each is asserted against the STORED document as well as the return value,
// because a service that returns false and writes anyway would satisfy the
// return value alone.
//
// The flip also writes no Activity row: 73779 asked for one, 73792 withdrew it
// because V2 renders none. The retirement is pinned by its own test below, with
// a positive control so the zero cannot be an unplugged instrument.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let Integration;
let Activity;
let deliveryFailures;

const POD = new mongoose.Types.ObjectId();

const makeIntegration = (overrides = {}) => Integration.create({
  name: 'Telegram',
  type: 'telegram',
  podId: POD,
  createdBy: new mongoose.Types.ObjectId(),
  status: 'connected',
  config: { chatId: '55501' },
  ...overrides,
});

const permanent403 = {
  success: false,
  errorCode: 403,
  description: 'Forbidden: bot was blocked by the user',
};

const storedIntegration = async (id) => Integration.findById(id).lean();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Integration = require('../../../models/Integration');
  Activity = require('../../../models/Activity');
  deliveryFailures = require('../../../services/connectorDeliveryFailureService');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Integration.deleteMany({});
  await Activity.deleteMany({});
});

describe('classification', () => {
  it('sorts Telegram-shaped and Slack-shaped results to their own classifier', () => {
    expect(deliveryFailures.classifyDeliveryFailure({ success: false, errorCode: 403 }))
      .toBe(deliveryFailures.TELEGRAM_BLOCKED_REASON);
    expect(deliveryFailures.classifyDeliveryFailure({ ok: false, error: 'not_in_channel' }))
      .toBe(deliveryFailures.SLACK_BOT_REMOVED_REASON);
    expect(deliveryFailures.classifyDeliveryFailure(null)).toBeNull();
  });
  it('is permanent for a 403 and for a 400 whose description says the chat is gone', () => {
    expect(deliveryFailures.classifyTelegramDeliveryFailure({ success: false, errorCode: 403 }))
      .toBe(deliveryFailures.TELEGRAM_BLOCKED_REASON);
    expect(deliveryFailures.classifyTelegramDeliveryFailure({
      success: false,
      errorCode: 400,
      description: 'Bad Request: chat not found',
    })).toBe(deliveryFailures.TELEGRAM_CHAT_GONE_REASON);
    expect(deliveryFailures.classifyTelegramDeliveryFailure({
      success: false,
      errorCode: 400,
      description: 'Chat Not Found',
    })).toBe(deliveryFailures.TELEGRAM_CHAT_GONE_REASON);
  });

  it('is not permanent for content 400s, our own token, rate limits, or a success', () => {
    [
      // The regression that made the escape load-bearing: a pod named `A <b>`
      // produces exactly this 400, and it must not undo a working connector.
      { success: false, errorCode: 400, description: "Bad Request: can't parse entities: unsupported start tag" },
      { success: false, errorCode: 400, description: 'Bad Request: message to reply not found' },
      { success: false, errorCode: 401, description: 'Unauthorized' },
      { success: false, errorCode: 429, description: 'Too Many Requests: retry after 3' },
      { success: false, errorCode: 500, description: 'Internal Server Error' },
      { success: true },
      null,
      undefined,
    ].forEach((result) => {
      expect(deliveryFailures.classifyTelegramDeliveryFailure(result)).toBeNull();
    });
  });
});

describe('Slack classification', () => {
  it('is permanent for the three errors that mean the channel is unreachable', () => {
    expect(deliveryFailures.classifySlackDeliveryFailure({ ok: false, error: 'channel_not_found' }))
      .toBe(deliveryFailures.SLACK_CHANNEL_GONE_REASON);
    expect(deliveryFailures.classifySlackDeliveryFailure({ ok: false, error: 'not_in_channel' }))
      .toBe(deliveryFailures.SLACK_BOT_REMOVED_REASON);
    expect(deliveryFailures.classifySlackDeliveryFailure({ ok: false, error: 'is_archived' }))
      .toBe(deliveryFailures.SLACK_CHANNEL_ARCHIVED_REASON);
  });

  it('never flips for app-level auth, transient, or content errors', () => {
    [
      // The shared bot app, the analogue of Telegram's 401: one connector must
      // not be marked broken because the app itself was revoked.
      { ok: false, error: 'invalid_auth' },
      { ok: false, error: 'token_revoked' },
      { ok: false, error: 'account_inactive' },
      { ok: false, error: 'ratelimited' },
      { ok: false, error: 'msg_too_long' },
      { ok: false, error: 'invalid_blocks' },
      { ok: false, error: 'internal_error' },
      { ok: false },
      { ok: true, ts: '1.1' },
      null,
    ].forEach((result) => {
      expect(deliveryFailures.classifySlackDeliveryFailure(result)).toBeNull();
    });
  });

  it('flips through the shared entry point, which sorts the two providers by shape', async () => {
    const integration = await makeIntegration({ type: 'slack', config: { chatId: 'C123' } });

    const flipped = await deliveryFailures.noteBoundChatDeliveryFailure(integration, 'C123', { ok: false, error: 'is_archived' });

    expect(flipped).toBe(true);
    const stored = await storedIntegration(integration._id);
    expect(stored.status).toBe('error');
    expect(stored.errorMessage).toBe(deliveryFailures.SLACK_CHANNEL_ARCHIVED_REASON);
    expect(stored.config.chatId).toBeUndefined();
  });

  it('refuses an inbound channel for Slack too — the guard is not per provider', async () => {
    const integration = await makeIntegration({ type: 'slack', config: { chatId: 'C123' } });

    const flipped = await deliveryFailures.noteBoundChatDeliveryFailure(integration, 'C999', { ok: false, error: 'channel_not_found' });

    expect(flipped).toBe(false);
    expect((await storedIntegration(integration._id)).config.chatId).toBe('C123');
    expect(await Activity.countDocuments({})).toBe(0);
  });
});

describe('which chat may flip', () => {
  it('flips the connector when its own bound chat refuses delivery, and names the reason', async () => {
    const integration = await makeIntegration();

    const flipped = await deliveryFailures.noteBoundChatDeliveryFailure(integration, '55501', permanent403);
    expect(flipped).toBe(true);

    const stored = await storedIntegration(integration._id);
    expect(stored.status).toBe('error');
    expect(stored.errorMessage).toBe(deliveryFailures.TELEGRAM_BLOCKED_REASON);
    // Unset, which is what stops the relay and re-allows a connect code.
    expect(stored.config.chatId).toBeUndefined();
  });

  it('writes no Activity row on a permanent failure (wren 73792 withdrew it: V2 renders none)', async () => {
    const integration = await makeIntegration();

    expect(await deliveryFailures.noteBoundChatDeliveryFailure(integration, '55501', permanent403)).toBe(true);
    expect(await Activity.countDocuments({})).toBe(0);

    // Positive control for the zero above: a row written directly is visible in
    // this harness, so the absence is the service's choice, not the instrument's.
    await Activity.create({
      type: 'pod_event',
      actor: {
        id: null, name: 'Commonly', type: 'system', verified: true, 
      },
      action: 'control_row',
      content: 'control',
      podId: POD,
      sourceType: 'event',
    });
    expect(await Activity.countDocuments({})).toBe(1);
  });

  it('refuses a chat the connector does not own — the inbound case — and writes nothing', async () => {
    const integration = await makeIntegration();

    const flipped = await deliveryFailures.noteBoundChatDeliveryFailure(integration, '99999', permanent403);
    expect(flipped).toBe(false);

    const stored = await storedIntegration(integration._id);
    expect(stored.status).toBe('connected');
    expect(stored.config.chatId).toBe('55501');
    expect(await Activity.countDocuments({})).toBe(0);
  });

  it('leaves a transient failure alone, end to end', async () => {
    const integration = await makeIntegration();

    const flipped = await deliveryFailures.noteBoundChatDeliveryFailure(integration, '55501', {
      success: false,
      errorCode: 429,
      description: 'Too Many Requests: retry after 3',
    });
    expect(flipped).toBe(false);

    const stored = await storedIntegration(integration._id);
    expect(stored.status).toBe('connected');
    expect(stored.config.chatId).toBe('55501');
    expect(stored.errorMessage == null).toBe(true);
    expect(await Activity.countDocuments({})).toBe(0);
  });

  it('writes nothing when the connector was re-bound between the send and the classification', async () => {
    const integration = await makeIntegration();
    await Integration.updateOne({ _id: integration._id }, { $set: { 'config.chatId': '77777' } });

    const flipped = await deliveryFailures.flipConnectorOnPermanentDeliveryFailure({
      integrationId: integration._id,
      failedChatId: '55501',
      reason: deliveryFailures.TELEGRAM_BLOCKED_REASON,
    });
    expect(flipped).toBe(false);

    const stored = await storedIntegration(integration._id);
    expect(stored.status).toBe('connected');
    expect(stored.config.chatId).toBe('77777');
    expect(await Activity.countDocuments({})).toBe(0);
  });
});
