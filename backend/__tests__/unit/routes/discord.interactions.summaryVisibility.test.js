// F143 / CodeRabbit on #3451: when several pods share one Discord channel, the
// route folds their /commonly-summary results into one reply. A pod refused by
// the shared-surface bind rule shows only its short refusal, and that is not a
// failure for visibility: the reply stays public when every other pod's result
// succeeded, so channel members still see the allowed summaries. A real error,
// or a reply where every pod was refused, stays ephemeral.
const request = require('supertest');
const express = require('express');

jest.mock('tweetnacl', () => ({ sign: { detached: { verify: jest.fn(() => true) } } }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/DiscordIntegration', () => ({}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../services/discordService', () => jest.fn());
// The real visibility rule; only the per-pod command runs are stubbed.
jest.mock('../../../services/discordMultiCommandService', () => ({
  ...jest.requireActual('../../../services/discordMultiCommandService'),
  runDiscordCommandForIntegrations: jest.fn(),
}));

process.env.DISCORD_PUBLIC_KEY = 'aa'.repeat(32);
const Integration = require('../../../models/Integration');
const { runDiscordCommandForIntegrations } = require('../../../services/discordMultiCommandService');
const discordRoutes = require('../../../routes/discord');

const app = express();
app.use('/api/discord/interactions', express.raw({ type: '*/*' }));
app.use('/api/discord', discordRoutes);

const integrations = [
  { _id: 'i-open', podId: { name: 'Open pod' } },
  { _id: 'i-member', podId: { name: 'Member-bound pod' } },
];
const ALLOWED = { success: true, content: 'Open pod summary text' };
const REFUSED = {
  success: false,
  refused: true,
  content: "Only the pod's creator can share this pod's summary with a channel. Ask them to reconnect it.",
};
const ERROR = { success: false, content: '❌ An error occurred while fetching the summary.' };

const summarize = (results) => {
  Integration.find.mockReturnValue({ populate: jest.fn().mockResolvedValue(integrations) });
  runDiscordCommandForIntegrations.mockResolvedValue(results.map((result, i) => ({ integration: integrations[i], result })));
  return request(app)
    .post('/api/discord/interactions')
    .set('Content-Type', 'application/json')
    .set('X-Signature-Ed25519', 'ab')
    .set('X-Signature-Timestamp', '1')
    .send(JSON.stringify({
      type: 2, guild_id: 'g1', channel_id: 'c1', data: { type: 1, name: 'commonly-summary' },
    }));
};

describe('POST /api/discord/interactions — combined /commonly-summary visibility', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stays public when one pod is refused and the other succeeds, without the refused summary', async () => {
    const res = await summarize([ALLOWED, REFUSED]);

    expect(res.status).toBe(200);
    expect(res.body.data.flags).toBe(0);
    expect(res.body.data.content).toContain('Open pod summary text');
    expect(res.body.data.content).toContain(REFUSED.content);
  });

  it('is ephemeral when every pod is refused', async () => {
    const res = await summarize([REFUSED, REFUSED]);
    expect(res.body.data.flags).toBe(64);
  });

  it('stays ephemeral on a real error beside a success', async () => {
    const res = await summarize([ALLOWED, ERROR]);
    expect(res.body.data.flags).toBe(64);
  });

  it('is public when every pod succeeds', async () => {
    const res = await summarize([ALLOWED, { ...ALLOWED, content: 'Second summary' }]);
    expect(res.body.data.flags).toBe(0);
  });
});
