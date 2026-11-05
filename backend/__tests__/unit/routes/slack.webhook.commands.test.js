// Pins every `/commonly` reply byte for byte and the config write behind it.
// Written when the command semantics moved into the shared chat-relay core
// (chatRelay/chatRelayCore.applyRelayCommand): Telegram's replies were already
// pinned by telegram.webhook.test.js, Slack's were not, so this suite was run
// against the pre-refactor route first and passed unchanged after it.
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/WebhookDelivery', () => ({ create: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../../../services/slackBridgeService', () => ({ relaySlackMessageToPod: jest.fn() }));

const Integration = require('../../../models/Integration');
const slackRoutes = require('../../../routes/webhooks/slack');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/slack', slackRoutes);

const signingSecret = 'slack-signing-secret';
const signatureHeaders = (body) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(body);
  const signature = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return { 'X-Slack-Request-Timestamp': String(timestamp), 'X-Slack-Signature': signature };
};

const HELP = 'Use /commonly status, mode mirror|attention, mute [minutes], or unmute.';
const MODE_USAGE = 'Usage: /commonly mode mirror|attention';

const bound = (config = {}) => {
  Integration.find.mockReturnValue({ limit: () => ({ lean: async () => [{ _id: 'int-1', config }] }) });
};

const command = async (text) => {
  const body = {
    team_id: 'T1', channel_id: 'D1', user_id: 'U1', ...(text === undefined ? {} : { text }),
  };
  return request(app).post('/api/webhooks/slack/commands').set(signatureHeaders(body)).send(body);
};

describe('Slack /commonly command replies', () => {
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    jest.clearAllMocks();
    Integration.updateOne.mockResolvedValue({});
  });
  afterAll(() => delete process.env.SLACK_SIGNING_SECRET);

  test.each([
    ['mode mirror', 'Relay mode: mirror.', { $set: { 'config.relayAllAgentMessages': true } }],
    ['MODE attention', 'Relay mode: attention.', { $set: { 'config.relayAllAgentMessages': false } }],
  ])('%s writes the mode flag and confirms it', async (text, reply, update) => {
    bound();
    const res = await command(text);
    expect(res.body).toEqual({ response_type: 'ephemeral', text: reply });
    expect(Integration.updateOne).toHaveBeenCalledWith({ _id: 'int-1' }, update);
  });

  // Slack takes the argument as typed and has no bare "show the mode" form.
  test.each(['mode', 'mode Mirror', 'mode loud'])('%s answers with usage and writes nothing', async (text) => {
    bound({ relayAllAgentMessages: true });
    const res = await command(text);
    expect(res.body).toEqual({ response_type: 'ephemeral', text: MODE_USAGE });
    expect(Integration.updateOne).not.toHaveBeenCalled();
  });

  test.each([
    ['mute', 60],
    ['mute 15', 15],
    ['mute 0', 60],
    ['mute 99999', 24 * 60],
    ['mute 2h', 120],
    // F161: the whole argument reaches the parse, not just its first word.
    ['mute 2 hours', 120],
    ['mute   30 min', 30],
  ])('%s mutes for %i minutes', async (text, minutes) => {
    bound();
    const before = Date.now();
    const res = await command(text);
    expect(res.body).toEqual({ response_type: 'ephemeral', text: `Muted for ${minutes} minutes.` });
    const [filter, update] = Integration.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'int-1' });
    const until = new Date(update.$set['config.relayMutedUntil']).getTime();
    expect(until).toBeGreaterThanOrEqual(before + minutes * 60000);
    expect(until).toBeLessThanOrEqual(Date.now() + minutes * 60000);
  });

  // F161: a duration the shared core cannot read is usage, not a guess.
  test.each(['mute -5', 'mute soon', 'mute 90s'])('%s answers with usage and writes nothing', async (text) => {
    bound();
    const res = await command(text);
    expect(res.body).toEqual({ response_type: 'ephemeral', text: 'Usage: /commonly mute 30m|2h' });
    expect(Integration.updateOne).not.toHaveBeenCalled();
  });

  test('mode still reads only its first word', async () => {
    bound();
    const res = await command('mode attention please');
    expect(res.body).toEqual({ response_type: 'ephemeral', text: 'Relay mode: attention.' });
  });

  test('unmute clears only the owner mute', async () => {
    bound();
    const res = await command('unmute');
    expect(res.body).toEqual({ response_type: 'ephemeral', text: 'Relay unmuted.' });
    const [, update] = Integration.updateOne.mock.calls[0];
    expect(Object.keys(update)).toEqual(['$unset']);
    expect(Object.keys(update.$unset)).toEqual(['config.relayMutedUntil']);
  });

  test.each([
    [{ relayAllAgentMessages: true }, 'Relay is mirror.'],
    [{ relayAllAgentMessages: false }, 'Relay is attention.'],
    [{}, 'Relay is attention.'],
  ])('status with %j reports the mode without writing', async (config, reply) => {
    bound(config);
    const res = await command('status');
    expect(res.body).toEqual({ response_type: 'ephemeral', text: reply });
    expect(Integration.updateOne).not.toHaveBeenCalled();
  });

  test.each([undefined, '', 'help', 'what'])('text %j answers with help', async (text) => {
    bound();
    const res = await command(text);
    expect(res.body).toEqual({ response_type: 'ephemeral', text: HELP });
    expect(Integration.updateOne).not.toHaveBeenCalled();
  });
});
