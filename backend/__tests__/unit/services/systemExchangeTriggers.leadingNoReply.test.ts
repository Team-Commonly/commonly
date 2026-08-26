// @ts-nocheck
// TASK-067: the conclusion-memory scan must use the same leading-bare
// NO_REPLY semantics as postMessage. This test keeps that cross-module
// contract executable without standing up Postgres.

const mockPool = { query: jest.fn() };

jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../../../services/agentMemoryService', () => ({
  appendSystemExchange: jest.fn().mockResolvedValue({ revision: 1 }),
  truncateTakeaway: (value) => String(value).slice(0, 280),
}));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { appendSystemExchange } = require('../../../services/agentMemoryService');
const { recordAgentDmConclusion } = require('../../../services/systemExchangeTriggers');

const POD_ID = '507f1f77bcf86cd799439011';
const NOVA_USER_ID = '507f191e810c19729de860ea';
const PIXEL_USER_ID = '507f191e810c19729de860eb';

function queryResult(value) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe('recordAgentDmConclusion — leading-bare NO_REPLY history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById
      .mockReturnValueOnce(queryResult({ type: 'agent-dm' }))
      .mockReturnValueOnce(queryResult({
        type: 'agent-dm',
        name: 'Nova and Pixel',
        members: [NOVA_USER_ID, PIXEL_USER_ID],
      }));
    User.find.mockReturnValue(queryResult([
      { username: 'nova', botMetadata: { agentName: 'openclaw', instanceId: 'nova' } },
      { username: 'pixel', botMetadata: { agentName: 'openclaw', instanceId: 'pixel' } },
    ]));
    User.findOne.mockReturnValue(queryResult({ _id: NOVA_USER_ID }));
  });

  it('skips a stored leading-bare reply before recording the sender’s prior substantive takeaway', async () => {
    mockPool.query.mockResolvedValue({
      rows: [
        { content: 'NO_REPLY\nThis suppressed body must not become the takeaway.' },
        { content: 'The auth patch is ready for the final gate.' },
      ],
    });

    await recordAgentDmConclusion({
      podId: POD_ID,
      senderAgentName: 'openclaw',
      senderInstanceId: 'nova',
      ts: new Date('2026-08-26T08:30:00Z'),
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE pod_id = $1 AND user_id = $2'),
      [POD_ID, NOVA_USER_ID],
    );
    expect(appendSystemExchange).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'nova',
      takeaway: 'The auth patch is ready for the final gate.',
    }));
    expect(appendSystemExchange).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'pixel',
      takeaway: '@nova: The auth patch is ready for the final gate.',
    }));
  });
});
