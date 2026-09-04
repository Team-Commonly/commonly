// Onboarding-silence detection (W4 item 2).
//
// The load-bearing behaviours, each of which is a decision someone made and
// could silently undo:
//   - fires only past the 15-minute threshold (10-min requeue must get a shot)
//   - only a BOT reply counts; a human answering is a different outcome
//   - the pod must hold an ACTIVE AgentInstallation, not just an agent member
//   - one episode per (user, pod), no matter how many times they typed
//   - re-scanning covered ground is a no-op, because passes overlap by design
//   - the AgentEvent snapshot is taken at fire time, before the 30-min GC

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const mockPgQuery = jest.fn();
jest.mock('../../../config/db-pg', () => ({ pool: { query: (...a) => mockPgQuery(...a) } }));

const mockUserFind = jest.fn();
jest.mock('../../../models/User', () => ({ find: (...a) => mockUserFind(...a) }));

const mockInstallFind = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: (...a) => mockInstallFind(...a) },
}));

const mockPodFind = jest.fn();
jest.mock('../../../models/Pod', () => ({ find: (...a) => mockPodFind(...a) }));

const mockEventFind = jest.fn();
jest.mock('../../../models/AgentEvent', () => ({ find: (...a) => mockEventFind(...a) }));

const mockRunCount = jest.fn();
jest.mock('../../../models/AgentRun', () => ({ countDocuments: (...a) => mockRunCount(...a) }));

const mockEpisodeFindOne = jest.fn();
const mockEpisodeFind = jest.fn();
const mockEpisodeCreate = jest.fn();
const mockEpisodeUpdateOne = jest.fn();
const mockEpisodeExists = jest.fn();
jest.mock('../../../models/OnboardingSilenceEpisode', () => ({
  findOne: (...a) => mockEpisodeFindOne(...a),
  find: (...a) => mockEpisodeFind(...a),
  create: (...a) => mockEpisodeCreate(...a),
  updateOne: (...a) => mockEpisodeUpdateOne(...a),
  exists: (...a) => mockEpisodeExists(...a),
}));

const { scan } = require('../../../services/onboardingSilenceService');

// A real ObjectId-shaped pod id — the service converts pod ids for the Mongo
// side and skips anything that is not a valid ObjectId.
const POD = '6a692a1be833c668acdb84cf';
const OTHER_POD = '6a692a1be833c668acdb84ce';
const NEWCOMER = '6a7f155f47c4fb09e8a9d4fa';
const SCOUT = '6a5fe696306155f677c26d6f';
const HUMAN_PEER = '6a5fe696306155f677c26d70';

const NOW = new Date('2026-08-15T12:00:00Z');
/** Typed 30 min ago: comfortably past the 15-minute judging threshold. */
const TYPED_AT = new Date(NOW.getTime() - 30 * MINUTE);

const lean = (rows) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });
const limitLean = (rows) => ({ limit: () => ({ lean: () => Promise.resolve(rows) }) });

const setup = ({
  messages = [{
    id: 900, pod_id: POD, user_id: NEWCOMER, created_at: TYPED_AT,
  }],
  podMessages = null,
  installs = [{ podId: POD }],
  bots = [{ _id: SCOUT }],
  openEpisodes = [],
  existingEpisode = null,
  coveredByResolved = null,
  events = [],
  runsStarted = 0,
} = {}) => {
  mockRunCount.mockResolvedValue(runsStarted);
  mockEpisodeFind.mockReturnValue(limitLean(openEpisodes));
  mockEpisodeFindOne.mockResolvedValue(existingEpisode);
  mockEpisodeExists.mockResolvedValue(coveredByResolved);
  mockEpisodeCreate.mockImplementation((doc) => Promise.resolve({ _id: 'ep1', ...doc }));
  mockEpisodeUpdateOne.mockResolvedValue({ modifiedCount: 1 });

  mockUserFind.mockImplementation((filter) => {
    // The newcomer lookup is keyed on createdAt; the bot lookup on _id $in.
    if (filter && filter.createdAt) {
      return lean([{ _id: NEWCOMER, username: 'newcomer', createdAt: new Date(NOW.getTime() - DAY) }]);
    }
    return lean(bots);
  });
  mockInstallFind.mockReturnValue(lean(installs));
  mockPodFind.mockReturnValue(lean([{ _id: POD, name: 'My Workspace' }]));
  mockEventFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(events) }) });

  // Call 1 = the newcomer's own messages; call 2 = everything in those pods.
  mockPgQuery.mockReset();
  mockPgQuery
    .mockResolvedValueOnce({ rows: messages })
    .mockResolvedValueOnce({ rows: podMessages === null ? messages : podMessages });
};

beforeEach(() => jest.clearAllMocks());

describe('onboardingSilenceService.scan', () => {
  it('opens an episode when a newcomer typed and nothing answered', async () => {
    setup();
    const result = await scan({ now: NOW });

    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]).toMatchObject({
      userId: NEWCOMER, podId: POD, podName: 'My Workspace', messageCount: 1,
    });
    expect(mockEpisodeCreate).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a message younger than the threshold', async () => {
    // The judging window is [now-lookback, now-threshold]. A message typed 5
    // minutes ago is outside it, so PG never returns it — assert the bound we
    // send to PG rather than re-implementing the filter in the test.
    setup();
    await scan({ now: NOW, thresholdMinutes: 15 });

    const [, params] = mockPgQuery.mock.calls[0];
    const judgeBefore = params[2];
    expect(NOW.getTime() - judgeBefore.getTime()).toBe(15 * MINUTE);
  });

  it('counts a bot reply inside the window as answered', async () => {
    setup({
      podMessages: [
        {
          id: 900, pod_id: POD, user_id: NEWCOMER, created_at: TYPED_AT, 
        },
        {
          id: 901, pod_id: POD, user_id: SCOUT, created_at: new Date(TYPED_AT.getTime() + 5 * MINUTE),
        },
      ],
    });
    const result = await scan({ now: NOW });

    expect(result.opened).toHaveLength(0);
    expect(mockEpisodeCreate).not.toHaveBeenCalled();
  });

  it('does NOT count a human reply as answered — that is a different outcome', async () => {
    setup({
      podMessages: [
        {
          id: 900, pod_id: POD, user_id: NEWCOMER, created_at: TYPED_AT, 
        },
        {
          id: 901, pod_id: POD, user_id: HUMAN_PEER, created_at: new Date(TYPED_AT.getTime() + 2 * MINUTE),
        },
      ],
      bots: [{ _id: SCOUT }], // HUMAN_PEER is deliberately not in the bot set
    });
    const result = await scan({ now: NOW });

    expect(result.opened).toHaveLength(1);
  });

  it('does not count a bot reply that lands after the threshold', async () => {
    setup({
      podMessages: [
        {
          id: 900, pod_id: POD, user_id: NEWCOMER, created_at: TYPED_AT, 
        },
        {
          id: 901, pod_id: POD, user_id: SCOUT, created_at: new Date(TYPED_AT.getTime() + 20 * MINUTE),
        },
      ],
    });
    const result = await scan({ now: NOW, thresholdMinutes: 15 });

    expect(result.opened).toHaveLength(1);
  });

  it('skips pods with no active AgentInstallation — nothing there could answer', async () => {
    setup({ installs: [] });
    const result = await scan({ now: NOW });

    expect(result.opened).toHaveLength(0);
    expect(result.skippedNoAgent).toBe(1);
  });

  it('gates on an ACTIVE installation, not on pod membership', async () => {
    setup();
    await scan({ now: NOW });

    const [filter] = mockInstallFind.mock.calls[0];
    expect(filter.status).toBe('active');
  });

  it('never re-opens a message a RESOLVED episode already covers', async () => {
    // 2026-09-04: a message answered 46 minutes late fails the in-window
    // "answered" test on every pass of the 24h lookback. Without this guard the
    // pass after a resolution opened it again, and the alert recipient got one
    // email every five minutes for the same message.
    setup({ coveredByResolved: { _id: 'ep7' } });
    const result = await scan({ now: NOW });

    expect(result.opened).toHaveLength(0);
    expect(result.updated).toBe(0);
    expect(mockEpisodeCreate).not.toHaveBeenCalled();
    expect(mockEpisodeUpdateOne).not.toHaveBeenCalled();
    // Coverage is by time, not by message id: the resolved episode must have
    // started at or before this message and been resolved at or after it. A
    // message typed after the resolution is a genuinely new silence.
    expect(mockEpisodeExists).toHaveBeenCalledWith({
      userId: NEWCOMER,
      podId: POD,
      status: 'resolved',
      firstTypedAt: { $lte: TYPED_AT },
      resolvedAt: { $gte: TYPED_AT },
    });
  });

  it('still opens when no resolved episode covers the message', async () => {
    setup({ coveredByResolved: null });
    const result = await scan({ now: NOW });

    expect(result.opened).toHaveLength(1);
    expect(mockEpisodeCreate).toHaveBeenCalledTimes(1);
  });

  it('absorbs a second silent message into the open episode instead of opening another', async () => {
    setup({
      existingEpisode: {
        _id: 'ep1', firstTypedAt: TYPED_AT, firstMessageId: '900', status: 'open',
      },
      messages: [{
        id: 901, pod_id: POD, user_id: NEWCOMER, created_at: new Date(TYPED_AT.getTime() + MINUTE),
      }],
    });
    const result = await scan({ now: NOW });

    expect(result.opened).toHaveLength(0);
    expect(result.updated).toBe(1);
    expect(mockEpisodeCreate).not.toHaveBeenCalled();
  });

  it('guards the absorb with a monotone watermark so overlapping passes cannot double-count', async () => {
    setup({
      existingEpisode: {
        _id: 'ep1', firstTypedAt: TYPED_AT, firstMessageId: '900', status: 'open',
      },
      messages: [{
        id: 901, pod_id: POD, user_id: NEWCOMER, created_at: new Date(TYPED_AT.getTime() + MINUTE),
      }],
    });
    await scan({ now: NOW });

    const [filter, update] = mockEpisodeUpdateOne.mock.calls[0];
    // The replay-protection has to be IN the query, not in JS before it.
    expect(filter.$or).toEqual(expect.arrayContaining([
      { lastAbsorbedAt: { $lt: new Date(TYPED_AT.getTime() + MINUTE) } },
    ]));
    expect(filter.firstMessageId).toEqual({ $ne: '901' });
    expect(update.$inc).toEqual({ messageCount: 1 });
  });

  it('treats a duplicate-key race as "already open" rather than as a failure', async () => {
    setup();
    const dup = Object.assign(new Error('E11000'), { code: 11000 });
    mockEpisodeCreate.mockRejectedValue(dup);

    await expect(scan({ now: NOW })).resolves.toMatchObject({ opened: [] });
  });

  it('snapshots the agent-event queue at fire time', async () => {
    setup({
      events: [
        {
          agentName: 'scout', instanceId: 'u1', status: 'pending', type: 'chat.mention', 
        },
        {
          agentName: 'scout', instanceId: 'u1', status: 'delivered', type: 'chat.mention', 
        },
      ],
    });
    const result = await scan({ now: NOW });

    expect(result.opened[0].eventSnapshot).toMatchObject({
      total: 2,
      byStatus: { pending: 1, delivered: 1 },
      targets: ['scout/u1'],
      noneEnqueued: false,
    });
  });

  it('counts AgentRuns in the same window, so "acked" can be split by whether anything ran', async () => {
    setup({
      events: [{ agentName: 'scout', instanceId: 'u1', status: 'acked', type: 'chat.mention' }],
      runsStarted: 3,
    });
    const result = await scan({ now: NOW });

    expect(result.opened[0].eventSnapshot.runsStarted).toBe(3);
    // Bounded to the episode window — a lifetime count would call every pod
    // with any history "it ran".
    const [filter] = mockRunCount.mock.calls[0];
    expect(filter.startedAt.$gte).toEqual(TYPED_AT);
    expect(filter.startedAt.$lte).toEqual(NOW);
  });

  it('records noneEnqueued when the write path never reached the queue', async () => {
    setup({ events: [] });
    const result = await scan({ now: NOW });

    expect(result.opened[0].eventSnapshot.noneEnqueued).toBe(true);
  });

  it('only considers accounts inside the onboarding window', async () => {
    setup();
    await scan({ now: NOW, onboardingWindowDays: 7 });

    const [filter] = mockUserFind.mock.calls[0];
    expect(NOW.getTime() - filter.createdAt.$gte.getTime()).toBe(7 * DAY);
    // And it must exclude bots, or agents chatting to each other look like
    // stranded newcomers.
    expect(filter.isBot).toEqual({ $ne: true });
  });

  it('resolves an open episode a bot has since answered, recording the lag', async () => {
    setup({
      openEpisodes: [{
        _id: 'ep9', userId: NEWCOMER, podId: OTHER_POD, firstTypedAt: TYPED_AT, status: 'open',
      }],
      messages: [],
    });
    // resolveOpenEpisodes queries PG first, before the two scan queries.
    mockPgQuery.mockReset();
    mockPgQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 950, pod_id: OTHER_POD, user_id: SCOUT, created_at: new Date(TYPED_AT.getTime() + 90 * 1000),
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await scan({ now: NOW });

    expect(result.resolved).toEqual([
      { episodeId: 'ep9', outcome: 'answered', lagSeconds: 90 },
    ]);
  });

  it('stops polling episodes older than the resolution window instead of re-querying forever', async () => {
    // An episode nobody ever answered never closes on its own, and resolution
    // costs one PG query per open episode per pass. Unbounded, the cron gets
    // more expensive the more users we failed — exactly backwards.
    setup({ messages: [] });
    await scan({ now: NOW });

    const [filter] = mockEpisodeFind.mock.calls[0];
    expect(filter.status).toBe('open');
    expect(NOW.getTime() - filter.firstTypedAt.$gte.getTime()).toBe(7 * DAY);
  });

  it('classifies a human-only rescue separately from the platform answering', async () => {
    setup({
      openEpisodes: [{
        _id: 'ep9', userId: NEWCOMER, podId: OTHER_POD, firstTypedAt: TYPED_AT, status: 'open',
      }],
      bots: [], // nobody in the reply set is a bot
      messages: [],
    });
    mockPgQuery.mockReset();
    mockPgQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 950, pod_id: OTHER_POD, user_id: HUMAN_PEER, created_at: new Date(TYPED_AT.getTime() + 3600 * 1000),
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await scan({ now: NOW });

    expect(result.resolved[0].outcome).toBe('human-rescued');
  });
});
