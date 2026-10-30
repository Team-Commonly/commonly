/**
 * Who posted in a pod since a time: the assigned-task wake reads this to decide
 * whether a person acted. One store answers, by the PG_HOST gate the message
 * writes use (TASK-503). A failed read throws, and the wake fails closed.
 */
const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const PGMessage = require('../../../models/pg/Message');

jest.mock('../../../models/Message');
jest.mock('../../../models/pg/Message', () => ({ findAuthorIdsSince: jest.fn() }));

const SINCE = new Date('2026-10-24T11:00:00Z');

describe('authorIdsSince', () => {
  const origPgHost = process.env.PG_HOST;
  beforeEach(() => {
    Message.distinct.mockReset();
    PGMessage.findAuthorIdsSince.mockReset();
  });
  afterAll(() => {
    if (origPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = origPgHost;
  });

  test('on PostgreSQL, reads PostgreSQL only', async () => {
    process.env.PG_HOST = 'localhost';
    PGMessage.findAuthorIdsSince.mockResolvedValue(['agent-1', 'person-1', 'person-1']);
    Message.distinct.mockResolvedValue(['person-2']);
    expect(await AgentMessageService.authorIdsSince('pod-1', SINCE)).toEqual(['agent-1', 'person-1']);
    expect(Message.distinct).not.toHaveBeenCalled();
  });

  // With PostgreSQL configured nothing writes MongoDB messages (TASK-503), so
  // MongoDB cannot stand in for a failed read. The wake fails closed instead.
  test('a failed PostgreSQL read throws and does not read MongoDB', async () => {
    process.env.PG_HOST = 'localhost';
    PGMessage.findAuthorIdsSince.mockRejectedValue(new Error('pg down'));
    Message.distinct.mockResolvedValue(['person-2']);
    await expect(AgentMessageService.authorIdsSince('pod-1', SINCE))
      .rejects.toMatchObject({ code: 'MESSAGE_STORE_UNAVAILABLE', statusCode: 503 });
    expect(Message.distinct).not.toHaveBeenCalled();
  });

  test('without PostgreSQL, reads MongoDB only', async () => {
    delete process.env.PG_HOST;
    Message.distinct.mockResolvedValue(['person-2']);
    expect(await AgentMessageService.authorIdsSince('pod-1', SINCE)).toEqual(['person-2']);
    expect(PGMessage.findAuthorIdsSince).not.toHaveBeenCalled();
  });
});
