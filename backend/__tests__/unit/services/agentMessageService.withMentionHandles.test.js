const AgentMessageService = require('../../../services/agentMessageService');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');

jest.mock('../../../models/User', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: { find: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));

// The author's display label, instanceId and username all differ, so a test
// that reads the wrong field cannot pass by accident. Mention routing is the
// real agentMentionService over the pod's rows.
const AUTHOR_ID = '6a47891ee025ce2e0ca1d305';
const BOT_ID = '6abeec74ffacf322751d7721';
const DEFAULT_BOT_ID = '6abeec74ffacf322751d7722';

const lean = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
const users = (rows) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(rows),
});

const rivet = {
  _id: BOT_ID,
  username: 'd214-lead-swe-dogfood',
  isBot: true,
  botMetadata: { agentName: 'd214-lead', instanceId: 'swe-dogfood', displayName: 'Rivet' },
};
const lily = { _id: AUTHOR_ID, username: 'lily-shen', isBot: false };

describe('AgentMessageService.withMentionHandles', () => {
  let podInstalls;

  beforeEach(() => {
    jest.clearAllMocks();
    podInstalls = [
      { agentName: 'd214-lead', instanceId: 'swe-dogfood', displayName: 'Rivet', status: 'active' },
    ];
    AgentInstallation.find.mockImplementation(() => lean(podInstalls));
    AgentProfile.find.mockReturnValue(lean([]));
    User.find.mockReturnValue(users([rivet, lily]));
  });

  it('returns the handle that routes, not the display label', async () => {
    const messages = [
      { id: 1, username: 'Rivet', userId: { _id: BOT_ID, username: 'Rivet' } },
      { id: 2, username: 'Lily Shen', userId: { _id: AUTHOR_ID, username: 'Lily Shen' } },
    ];

    const result = await AgentMessageService.withMentionHandles(messages, 'pod-1');

    expect(result.map((m) => m.mention)).toEqual(['d214-lead-swe-dogfood', 'lily-shen']);
    expect(result[0].username).toBe('Rivet');
    expect(AgentInstallation.find).toHaveBeenCalledWith({ podId: { $eq: 'pod-1' }, status: 'active' });
  });

  // A default install's username is the bare agent name, which routes only
  // while it is the pod's one install of that agent.
  it('gives a default install beside a sibling its agent-instance key', async () => {
    podInstalls.push({ agentName: 'd214-lead', instanceId: 'default', displayName: 'Lead', status: 'active' });
    User.find.mockReturnValue(users([{
      _id: DEFAULT_BOT_ID,
      username: 'd214-lead',
      isBot: true,
      botMetadata: { agentName: 'd214-lead', instanceId: 'default', displayName: 'Lead' },
    }]));

    const [message] = await AgentMessageService.withMentionHandles(
      [{ id: 4, userId: { _id: DEFAULT_BOT_ID } }],
      'pod-1',
    );

    expect(message.mention).toBe('d214-lead-default');
  });

  it('reads a map it is handed instead of loading the pod again', async () => {
    const { buildMentionMap } = jest.requireActual('../../../services/agentMentionService');
    const { map } = buildMentionMap(podInstalls, []);

    const [message] = await AgentMessageService.withMentionHandles(
      [{ id: 5, userId: { _id: BOT_ID } }],
      'pod-1',
      { mentionMap: map },
    );

    expect(message.mention).toBe('d214-lead-swe-dogfood');
    expect(AgentInstallation.find).not.toHaveBeenCalled();
  });

  // A pod id comes from route params and bodies; an operator object is not one.
  it('reads no pod rows for a pod id that is not a string', async () => {
    const { loadPodMentionMap } = jest.requireActual('../../../services/agentMentionService');

    const map = await loadPodMentionMap({ $ne: null });

    expect(map.size).toBe(0);
    expect(AgentInstallation.find).not.toHaveBeenCalled();
    expect(AgentProfile.find).not.toHaveBeenCalled();
  });

  it('queries each distinct author once, not once per message', async () => {
    const messages = [
      { id: 1, userId: { _id: BOT_ID } },
      { id: 2, userId: { _id: BOT_ID } },
    ];

    await AgentMessageService.withMentionHandles(messages, 'pod-1');

    expect(User.find).toHaveBeenCalledTimes(1);
    expect(User.find.mock.calls[0][0]).toEqual({ _id: { $in: [BOT_ID] } });
  });

  it('leaves mention empty for an author id that is not an ObjectId', async () => {
    const result = await AgentMessageService.withMentionHandles([
      { id: 3, userId: { _id: 'not-an-object-id', username: 'Ghost' } },
    ], 'pod-1');

    expect(User.find).not.toHaveBeenCalled();
    expect(result[0].mention).toBe('');
  });

  // Handles are an addition to a page of messages; a failed lookup must not
  // cost the caller the messages.
  it('returns every message with an empty mention when a lookup fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentInstallation.find.mockImplementation(() => ({ lean: jest.fn().mockRejectedValue(new Error('db down')) }));

    const result = await AgentMessageService.withMentionHandles([
      { id: 1, userId: { _id: BOT_ID } },
      { id: 2, userId: { _id: AUTHOR_ID } },
    ], 'pod-1');

    expect(result).toEqual([
      { id: 1, userId: { _id: BOT_ID }, mention: '' },
      { id: 2, userId: { _id: AUTHOR_ID }, mention: '' },
    ]);
    warn.mockRestore();
  });
});
