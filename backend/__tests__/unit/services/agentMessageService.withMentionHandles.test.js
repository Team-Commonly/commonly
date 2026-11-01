const AgentMessageService = require('../../../services/agentMessageService');
const User = require('../../../models/User');

jest.mock('../../../models/User', () => ({
  find: jest.fn(),
}));

// The author's display label, instanceId and username all differ, so a test
// that reads the wrong field cannot pass by accident.
const AUTHOR_ID = '6a47891ee025ce2e0ca1d305';
const BOT_ID = '6abeec74ffacf322751d7721';

describe('AgentMessageService.withMentionHandles', () => {
  beforeEach(() => {
    User.find.mockReset();
    User.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: BOT_ID, username: 'd214-lead-d214-lead-swe-dogfood' },
        { _id: AUTHOR_ID, username: 'lily-shen' },
      ]),
    });
  });

  it('returns the User.username as mention, not the display label', async () => {
    const messages = [
      { id: 1, username: 'Rivet', userId: { _id: BOT_ID, username: 'Rivet' } },
      { id: 2, username: 'Lily Shen', userId: { _id: AUTHOR_ID, username: 'Lily Shen' } },
    ];

    const result = await AgentMessageService.withMentionHandles(messages);

    expect(result.map((m) => m.mention)).toEqual([
      'd214-lead-d214-lead-swe-dogfood',
      'lily-shen',
    ]);
    expect(result[0].username).toBe('Rivet');
  });

  it('queries each distinct author once, not once per message', async () => {
    const messages = [
      { id: 1, userId: { _id: BOT_ID } },
      { id: 2, userId: { _id: BOT_ID } },
    ];

    await AgentMessageService.withMentionHandles(messages);

    expect(User.find).toHaveBeenCalledTimes(1);
    expect(User.find.mock.calls[0][0]).toEqual({ _id: { $in: [BOT_ID] } });
  });

  it('leaves mention empty for an author id that is not an ObjectId', async () => {
    const result = await AgentMessageService.withMentionHandles([
      { id: 3, userId: { _id: 'not-an-object-id', username: 'Ghost' } },
    ]);

    expect(User.find).not.toHaveBeenCalled();
    expect(result[0].mention).toBe('');
  });
});
