/**
 * Who posted in a pod since a time: the assigned-task wake reads this to decide
 * whether a person acted. On PostgreSQL a post that fell back to MongoDB is only
 * in MongoDB until it is reconciled, so both stores are read.
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

  test('on PostgreSQL, includes an author whose post is still in the MongoDB fallback', async () => {
    process.env.PG_HOST = 'localhost';
    PGMessage.findAuthorIdsSince.mockResolvedValue(['agent-1', 'person-1']);
    Message.distinct.mockResolvedValue(['person-2', 'person-1']);
    const ids = await AgentMessageService.authorIdsSince('pod-1', SINCE);
    expect(ids.sort()).toEqual(['agent-1', 'person-1', 'person-2']);
    expect(Message.distinct).toHaveBeenCalledWith('userId', expect.objectContaining({ createdAt: { $gt: SINCE } }));
  });

  test('a failed PostgreSQL read is not hidden by the fallback read', async () => {
    process.env.PG_HOST = 'localhost';
    PGMessage.findAuthorIdsSince.mockRejectedValue(new Error('pg down'));
    Message.distinct.mockResolvedValue(['person-2']);
    await expect(AgentMessageService.authorIdsSince('pod-1', SINCE)).rejects.toThrow('pg down');
  });

  test('without PostgreSQL, reads MongoDB only', async () => {
    delete process.env.PG_HOST;
    Message.distinct.mockResolvedValue(['person-2']);
    expect(await AgentMessageService.authorIdsSince('pod-1', SINCE)).toEqual(['person-2']);
    expect(PGMessage.findAuthorIdsSince).not.toHaveBeenCalled();
  });
});
