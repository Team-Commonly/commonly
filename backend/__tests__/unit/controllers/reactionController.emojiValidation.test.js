// Guards SAFE_EMOJI_RE after the 2026-07-24 bug: `\p{Emoji}` alone rejected the
// combining marks real emoji carry — U+FE0F (variation selector, e.g. ❤️),
// U+200D (ZWJ sequences), skin-tone modifiers — so ❤️ (in the client palette)
// 400'd and the frontend swallowed it. Users couldn't add it → "reactions can't
// show more than one." These pin that the palette + common sequences are
// accepted, and that genuine non-emoji is still rejected.

jest.mock('../../../models/pg/MessageReaction', () => ({
  __esModule: true,
  default: {
    add: jest.fn().mockResolvedValue(false),
    remove: jest.fn().mockResolvedValue(undefined),
    listForMessage: jest.fn().mockResolvedValue([{ emoji: '👍', count: 1, mine: true, userIds: ['caller-1'] }]),
  },
}));
jest.mock('../../../services/reactionAttributionService', () => ({
  decorateReactionSummaries: jest.fn(async (s) => s),
}));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { findOne: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn() }));

const reactionController = require('../../../controllers/reactionController');
const MessageReaction = require('../../../models/pg/MessageReaction').default;
const { pool } = require('../../../config/db-pg');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const socketConfig = require('../../../config/socket');

const buildRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const reactAs = async (emoji) => {
  // loadMessageContext → a pod + author; agent path → active install → access granted.
  pool.query.mockResolvedValueOnce({ rows: [{ pod_id: 'pod-1', user_id: 'author-1' }], rowCount: 1 });
  AgentInstallation.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'inst-1' }) });
  const req = { params: { messageId: '9' }, body: { emoji }, agentUser: { _id: 'bot-1' } };
  const res = buildRes();
  await reactionController.addReaction(req, res);
  return res;
};

describe('reactionController.addReaction — emoji validation (❤️ bug 2026-07-24)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    socketConfig.getIO.mockReturnValue({ to: jest.fn().mockReturnValue({ emit: jest.fn() }) });
  });

  // ❤️ = U+2764 U+FE0F; 👍🏽 = thumb + skin-tone modifier; 👨‍👩‍👧 = ZWJ sequence;
  // 👍 = plain single code point (control that always worked).
  test.each(['👍', '❤️', '👍🏽', '👨‍👩‍👧'])('accepts %s', async (emoji) => {
    const res = await reactAs(emoji);
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(MessageReaction.add).toHaveBeenCalledWith('9', 'bot-1', emoji);
  });

  test.each(['abc', 'a👍', '<script>'])('rejects non-emoji %p with 400', async (emoji) => {
    const res = await reactAs(emoji);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(MessageReaction.add).not.toHaveBeenCalled();
  });
});
