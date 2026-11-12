// F457: a quick-try `agent run` that finds no harness exits before it ever
// checks in, so the connect page waited forever. The run reports what it
// looked for on its own token first; the page reads it back for the owner.
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

const post = (body) => request(app).post('/api/agents/runtime/harness-missing').send(body);

describe('POST /api/agents/runtime/harness-missing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ acknowledged: true });
  });

  test('records the harness the calling seat could not find, with the time', async () => {
    const response = await post({ harness: 'claude' });
    expect(response.status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'seat-1' },
      { $set: { 'botMetadata.harnessMissing': { harness: 'claude', at: expect.any(Date) } } },
    );
  });

  test('null means it looked for every harness it knows and found none', async () => {
    const response = await post({ harness: null });
    expect(response.status).toBe(200);
    expect(mockUpdateOne.mock.calls[0][1].$set['botMetadata.harnessMissing'].harness).toBeNull();
  });

  test.each([
    [{ harness: 'not-a-harness' }],
    [{ harness: 'claude', note: 'x' }],
    [{}],
    [{ harness: 7 }],
  ])('refuses %j and writes nothing', async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('a failed write answers 503', async () => {
    mockUpdateOne.mockRejectedValue(new Error('down'));
    const response = await post({ harness: 'codex' });
    expect(response.status).toBe(503);
  });
});
