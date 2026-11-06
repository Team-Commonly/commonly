// A foreground run on a host with no sandbox marks its own seat, because no
// daemon reports for it. An unconfined agent can read this run's token, so the
// route only ever sets the mark.
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

describe('POST /api/agents/runtime/host-unconfined', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ acknowledged: true });
  });

  test('marks the calling seat', async () => {
    const response = await request(app).post('/api/agents/runtime/host-unconfined').send({});
    expect(response.status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'seat-1' },
      { $set: { 'botMetadata.hostUnconfined': true } },
    );
  });

  test('the token that set it cannot clear it, whatever the body says', async () => {
    await request(app).post('/api/agents/runtime/host-unconfined').send({ hostUnconfined: false });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'seat-1' },
      { $set: { 'botMetadata.hostUnconfined': true } },
    );
  });

  test('a failed write is not a success, so the run does not start', async () => {
    mockUpdateOne.mockRejectedValue(new Error('down'));
    const response = await request(app).post('/api/agents/runtime/host-unconfined').send({});
    expect(response.status).toBe(503);
  });
});
