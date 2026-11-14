// F515: a first `agent run` that finds Node too old, or its harness signed
// out, stops before it starts waiting. It reports why on its own token first,
// by reason code only, so the connect page and the pod can say it.
const express = require('express');
const request = require('supertest');

const mockUpdateOne = jest.fn();

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'seat-1' };
  next();
});
jest.mock('../../../models/User', () => ({ updateOne: (...args) => mockUpdateOne(...args) }));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

const post = (body) => request(app).post('/api/agents/runtime/listen-blocked').send(body);

describe('POST /api/agents/runtime/listen-blocked', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ acknowledged: true });
  });

  test('records the reason and the harness for the calling seat, with the time', async () => {
    const response = await post({ reason: 'harness-signed-out', harness: 'claude' });
    expect(response.status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'seat-1' },
      { $set: { 'botMetadata.listenBlocked': { reason: 'harness-signed-out', harness: 'claude', at: expect.any(Date) } } },
    );
  });

  test('Node too old names no harness', async () => {
    const response = await post({ reason: 'node-too-old', harness: null });
    expect(response.status).toBe(200);
    expect(mockUpdateOne.mock.calls[0][1].$set['botMetadata.listenBlocked']).toMatchObject({ reason: 'node-too-old', harness: null });
  });

  test('an alias is stored as its catalog id', async () => {
    await post({ reason: 'harness-signed-out', harness: 'claude-code' });
    expect(mockUpdateOne.mock.calls[0][1].$set['botMetadata.listenBlocked'].harness).toBe('claude');
  });

  // Only codes: free text from a computer could carry a path or a secret.
  test.each([
    [{ reason: 'signed out, see /Users/x/.claude', harness: 'claude' }],
    [{ reason: 'harness-signed-out', harness: 'claude', detail: 'x' }],
    [{ reason: 'harness-signed-out' }],
    [{ reason: 'harness-signed-out', harness: 'not-a-harness' }],
    [{ reason: 'harness-signed-out', harness: null }],
    [{ reason: 'harness-missing', harness: 'claude' }],
    [{}],
  ])('refuses %j and writes nothing', async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('a failed write answers 503', async () => {
    mockUpdateOne.mockRejectedValue(new Error('down'));
    const response = await post({ reason: 'node-too-old', harness: null });
    expect(response.status).toBe(503);
  });
});
