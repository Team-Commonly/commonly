jest.mock('../../../services/systemActionLineService', () => ({ emitUnansweredMentionLine: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: (name) => name,
  resolveAgentDisplayLabel: () => 'Nova',
}));
jest.mock('../../../models/User', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const { noteUnansweredMention } = require('../../../services/unansweredMentionService');
const { coalescedEntry } = require('../../../services/mentionCoalesce');
const { emitUnansweredMentionLine } = require('../../../services/systemActionLineService');
const User = require('../../../models/User');
const { pool } = require('../../../config/db-pg');

const lean = (value) => ({ select: () => ({ lean: async () => value }) });
const event = (payload) => ({
  agentName: 'nova',
  instanceId: 'default',
  podId: 'pod-1',
  createdAt: new Date(0),
  payload: { userId: 'a'.repeat(24), ...payload },
});

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockReturnValue(lean({ isBot: false }));
  User.findOne.mockReturnValue(lean({ _id: 'bot-1', username: 'nova' }));
  pool.query.mockResolvedValue({ rows: [] });
});

describe('a comment that closes unanswered', () => {
  it('stays quiet when its post has no pod, since podId is just some pod of theirs', async () => {
    expect(await noteUnansweredMention(event({ thread: { postId: 'p1', commentId: 'c1' } }))).toBe(false);
    expect(emitUnansweredMentionLine).not.toHaveBeenCalled();
  });

  it('tells them when the post is in a pod', async () => {
    expect(await noteUnansweredMention(event({ thread: { postId: 'p1', postPodId: 'pod-1' } }))).toBe(true);
    expect(emitUnansweredMentionLine).toHaveBeenCalledTimes(1);
  });
});

it('still tells a person in chat, who has no thread on the row', async () => {
  expect(await noteUnansweredMention(event({ messageId: '900' }))).toBe(true);
  expect(emitUnansweredMentionLine.mock.calls[0][0]).toMatchObject({ podId: 'pod-1', messageId: '900' });
});

describe('a message that asked someone else (F299)', () => {
  const askedOther = { implicitReply: true, mentions: ['pixel'] };

  it('stays quiet on a reply under the agent that @d someone else', async () => {
    expect(await noteUnansweredMention(event({ messageId: '900', ...askedOther }))).toBe(false);
    expect(emitUnansweredMentionLine).not.toHaveBeenCalled();
  });

  it('still answers a plain reply under the agent', async () => {
    expect(await noteUnansweredMention(event({ messageId: '900', implicitReply: true, mentions: [] }))).toBe(true);
  });

  it('still tells a person carrying on with the agent that just spoke', async () => {
    expect(await noteUnansweredMention(event({ messageId: '900', adjacentReply: true }))).toBe(true);
  });

  it('still tells a newcomer whose welcome went unanswered', async () => {
    expect(await noteUnansweredMention(event({ messageId: '900', welcomeWake: true }))).toBe(true);
  });

  it('skips a joined message that asked someone else, and tells the rest', async () => {
    const joined = (messageId, extra) => ({ messageId, userId: 'b'.repeat(24), createdAt: new Date(5), ...extra });
    await noteUnansweredMention(event({
      messageId: '900',
      coalesced: [
        { ...coalescedEntry({ messageId: '901', userId: 'b'.repeat(24), ...askedOther }), createdAt: new Date(5) },
        // Carried on from the agent: the server took it as addressed to it.
        { ...coalescedEntry({ messageId: '902', userId: 'b'.repeat(24), implicitReply: true, adjacentReply: true }), createdAt: new Date(5) },
        joined('903'),
      ],
    }));
    expect(emitUnansweredMentionLine.mock.calls.map(([line]) => line.messageId)).toEqual(['900', '902', '903']);
  });

  it('tells a joined ask when the lead asked someone else', async () => {
    await noteUnansweredMention(event({
      messageId: '900', ...askedOther, coalesced: [{ messageId: '901', userId: 'b'.repeat(24) }],
    }));
    expect(emitUnansweredMentionLine.mock.calls.map(([line]) => line.messageId)).toEqual(['901']);
  });
});
