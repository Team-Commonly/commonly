/**
 * F290: a card's stored text says "[approval needed]" for good; only its
 * payload moves on. The native turn's context already named the outcome; the
 * runtime messages/context reads (BYO and MCP agents) read the stored text, so
 * a declined card read as still waiting there.
 */

const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const PGMessage = require('../../../models/pg/Message');

jest.mock('../../../models/Message');
jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn() }));

const POD = 'pod-1';
const card = (payload) => ({
  id: '7', pod_id: POD, user_id: 'scout', username: 'Scout', is_bot: true,
  content: '[approval needed] Connect your agent', message_type: 'system',
  created_at: new Date('2026-11-12T00:00:00Z'), payload: { kind: 'approval-card', ...payload },
});

const mockMongoChain = (rows) => {
  const query = {};
  query.where = jest.fn().mockReturnValue(query);
  query.lt = jest.fn().mockReturnValue(query);
  query.sort = jest.fn().mockReturnValue(query);
  query.limit = jest.fn().mockReturnValue(query);
  query.populate = jest.fn().mockReturnValue(query);
  query.lean = jest.fn().mockResolvedValue(rows);
  Message.find.mockReturnValue(query);
};

describe('getRecentMessages names a decided card', () => {
  const origPgHost = process.env.PG_HOST;
  afterAll(() => {
    if (origPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = origPgHost;
  });

  test.each([
    [{ status: 'resolved', decision: 'declined' }, '[approval declined] Connect your agent'],
    [{ status: 'expired' }, '[approval expired] Connect your agent'],
    [{ status: 'resolved', decision: 'approved', actionType: 'tool_call', toolCallEnding: 'failed' }, '[approval failed] Connect your agent'],
    [{ status: 'pending' }, '[approval needed] Connect your agent'],
  ])('PG read: %j', async (payload, expected) => {
    process.env.PG_HOST = 'localhost';
    PGMessage.findByPodId.mockResolvedValue([card(payload)]);
    const [message] = await AgentMessageService.getRecentMessages(POD, 20, 'agent');
    expect(message.content).toBe(expected);
  });

  test('PG read: a non-card message keeps its text, even one opening with the marker', async () => {
    process.env.PG_HOST = 'localhost';
    PGMessage.findByPodId.mockResolvedValue([{ ...card({}), payload: null }]);
    const [message] = await AgentMessageService.getRecentMessages(POD, 20, 'agent');
    expect(message.content).toBe('[approval needed] Connect your agent');
  });

  test('Mongo read: a declined card reads as declined', async () => {
    delete process.env.PG_HOST;
    mockMongoChain([{
      _id: 'm1', content: '[approval needed] Connect your agent', messageType: 'system',
      userId: { _id: 'scout', username: 'Scout', isBot: true }, createdAt: new Date(),
      payload: { kind: 'approval-card', status: 'resolved', decision: 'declined' },
    }]);
    const [message] = await AgentMessageService.getRecentMessages(POD, 20, 'agent');
    expect(message.content).toBe('[approval declined] Connect your agent');
  });
});
