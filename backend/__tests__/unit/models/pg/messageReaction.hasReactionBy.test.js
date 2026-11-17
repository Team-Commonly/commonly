// F550: the claim release asks whether the releasing seat reacted to the
// message. Any of its reactions counts; a message id PG can't hold reads false
// without a query.
const mockQuery = jest.fn();
jest.mock('../../../../config/db-pg', () => ({ pool: { query: (...a) => mockQuery(...a) } }));

const MessageReaction = require('../../../../models/pg/MessageReaction');

beforeEach(() => mockQuery.mockReset());

test('true when the user holds a reaction on the message', async () => {
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [{}] });
  await expect(MessageReaction.hasReactionBy('52907', 'bot-1')).resolves.toBe(true);
  expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM message_reactions WHERE message_id = $1 AND user_id = $2'), [52907, 'bot-1']);
});

test('false when it holds none', async () => {
  mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
  await expect(MessageReaction.hasReactionBy(52907, 'bot-1')).resolves.toBe(false);
});

test('a non-numeric message id reads false and asks nothing', async () => {
  await expect(MessageReaction.hasReactionBy('6a1b2c3d4e5f6a7b8c9d0e1f', 'bot-1')).resolves.toBe(false);
  expect(mockQuery).not.toHaveBeenCalled();
});
