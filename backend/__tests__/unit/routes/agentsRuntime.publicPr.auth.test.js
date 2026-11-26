// F646: the public-PR read sits behind the real agentRuntimeAuth. A human
// session, or no credential at all, is refused before any database lookup and
// before GitHub is called. The auth middleware here is the real one.
const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

describe('GET /api/agents/runtime/github/public-pr auth', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch'); });
  afterEach(() => fetchSpy.mockRestore());

  test.each([
    ['a human JWT', { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig' }],
    ['no credential', {}],
  ])('%s is refused with 401', async (_label, headers) => {
    const res = await request(app)
      .get('/api/agents/runtime/github/public-pr')
      .set(headers)
      .query({ owner: 'dev', repo: 'r', number: '3' });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
