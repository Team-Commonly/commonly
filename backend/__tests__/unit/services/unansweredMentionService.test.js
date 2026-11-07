jest.mock('../../../services/systemActionLineService', () => ({ emitUnansweredMentionLine: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: (name) => name,
  resolveAgentDisplayLabel: () => 'Nova',
}));
jest.mock('../../../models/User', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const { noteUnansweredMention } = require('../../../services/unansweredMentionService');
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
