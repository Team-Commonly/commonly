const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => {
  if (req.header('Authorization') !== 'Bearer valid-user' && req.header('x-auth-token') !== 'valid-user') {
    return res.status(401).json({ verifier: 'human' });
  }
  req.userId = 'person-1';
  return next();
}));
jest.mock('../../../middleware/agentRuntimeAuth', () => jest.fn((req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '').trim() || req.header('x-commonly-agent-token');
  if (token !== 'cm_agent_valid') return res.status(401).json({ verifier: 'agent' });
  req.agentUser = { _id: 'agent-1' };
  return next();
}));
const dualAuth = require('../../../middleware/dualAuth');
const humanAuth = require('../../../middleware/auth');
const agentAuth = require('../../../middleware/agentRuntimeAuth');
const app = express();
app.get('/', dualAuth, (req, res) => res.json({ human: req.userId || null, agent: req.agentUser?._id || null }));
beforeEach(() => jest.clearAllMocks());

test.each([
  [{ Authorization: 'Bearer cm_agent_valid' }, 200, 'agent'],
  [{ 'x-commonly-agent-token': 'cm_agent_valid' }, 200, 'agent'],
  [{ Authorization: 'Bearer valid-user' }, 200, 'human'],
  [{ 'x-auth-token': 'valid-user' }, 200, 'human'],
  [{ Authorization: 'Bearer valid-user', 'x-commonly-agent-token': 'cm_agent_valid' }, 200, 'human'],
  [{ Authorization: 'Bearer cm_agent_revoked', 'x-auth-token': 'valid-user' }, 401, 'agent'],
  [{ Authorization: 'Bearer invalid', 'x-commonly-agent-token': 'cm_agent_valid' }, 401, 'human'],
  [{ 'x-commonly-agent-token': 'cm_daemon_invalid' }, 401, 'human'],
  [{ 'x-commonly-agent-token': 'cm_agent_revoked' }, 401, 'agent'],
  [{}, 401, 'human'],
])('selects one verifier and preserves refusal for %j', async (headers, status, verifier) => {
  const res = await request(app).get('/').set(headers);
  expect(res.status).toBe(status);
  expect(humanAuth).toHaveBeenCalledTimes(verifier === 'human' ? 1 : 0);
  expect(agentAuth).toHaveBeenCalledTimes(verifier === 'agent' ? 1 : 0);
  if (status === 200) expect(res.body).toEqual(verifier === 'agent'
    ? { human: null, agent: 'agent-1' } : { human: 'person-1', agent: null });
});
