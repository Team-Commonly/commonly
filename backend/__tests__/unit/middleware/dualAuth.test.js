const rateLimit = require('express-rate-limit');
const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '') || req.header('x-auth-token');
  if (token !== 'valid-user') {
    return res.status(401).json({ verifier: 'human' });
  }
  req.userId = 'person-1';
  return next();
}));
jest.mock('../../../middleware/agentRuntimeAuth', () => jest.fn((req, res, next) => {
  // The real middleware reads its token through the shared parser (F169).
  const token = jest.requireActual('../../../middleware/agentRuntimeCredential').agentRuntimeCredential(req);
  if (token !== 'cm_agent_valid') return res.status(401).json({ verifier: 'agent' });
  req.agentUser = { _id: 'agent-1' };
  return next();
}));
const dualAuth = require('../../../middleware/dualAuth');
const { resolveDualAuthCredential } = dualAuth;
const humanAuth = require('../../../middleware/auth');
const agentAuth = require('../../../middleware/agentRuntimeAuth');
const app = express();
// Keep even this unserved HTTP fixture behind the normal limiter-before-auth order.
const limiter = rateLimit({ windowMs: 60000, max: 100 });
app.get('/', limiter, dualAuth, (req, res) => res.json({ human: req.userId || null, agent: req.agentUser?._id || null }));
beforeEach(() => jest.clearAllMocks());

test.each([
  [{ Authorization: 'Bearer cm_agent_valid' }, 200, 'agent'],
  [{ 'x-commonly-agent-token': 'cm_agent_valid' }, 200, 'agent'],
  [{ Authorization: 'Bearer valid-user' }, 200, 'human'],
  [{ 'x-auth-token': 'valid-user' }, 200, 'human'],
  [{ 'x-auth-token': 'cm_agent_valid' }, 401, 'human'],
  [{ 'x-commonly-agent-token': 'invalid', 'x-auth-token': 'valid-user' }, 200, 'human'],
  [{ Authorization: 'Bearer invalid', 'x-auth-token': 'valid-user' }, 401, 'human'],
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

test.each([
  [{ Authorization: 'Bearer valid-user', 'x-commonly-agent-token': 'cm_agent_valid' }, 'human', 'valid-user'],
  [{ 'x-commonly-agent-token': 'cm_agent_valid', 'x-auth-token': 'spoof-a' }, 'agent', 'cm_agent_valid'],
  [{ 'x-commonly-agent-token': 'cm_agent_valid', 'x-auth-token': 'spoof-b' }, 'agent', 'cm_agent_valid'],
  [{ 'x-commonly-agent-token': 'not-a-runtime-token', 'x-auth-token': 'valid-user' }, 'human', 'valid-user'],
  [{ 'x-auth-token': 'cm_agent_valid' }, 'human', 'cm_agent_valid'],
])('the limiter keys the selected verifier credential for %j', (headers, verifier, token) => {
  expect(resolveDualAuthCredential({ header: (name) => headers[name] })).toEqual({ verifier, token });
});

// F169: the limiter's key and the agent verifier read the runtime token with
// one parser. A non-Bearer Authorization once picked the agent path and keyed
// the bucket on its own text, while agentRuntimeAuth ignored it and
// authenticated with x-commonly-agent-token: a fresh bucket per request.
const { agentRuntimeCredential } = require('../../../middleware/agentRuntimeCredential');
const HEADER_SETS = [
  { Authorization: 'cm_agent_junk-1', 'x-commonly-agent-token': 'cm_agent_valid' },
  { Authorization: 'cm_agent_junk-2', 'x-commonly-agent-token': 'cm_agent_valid' },
  { Authorization: 'Basic cm_agent_junk', 'x-commonly-agent-token': 'cm_agent_valid' },
  { Authorization: 'Token Bearer cm_agent_junk', 'x-commonly-agent-token': 'cm_agent_valid' },
  { Authorization: 'Bearer ', 'x-commonly-agent-token': 'cm_agent_valid' },
  { Authorization: 'Bearer cm_agent_valid' },
  { Authorization: 'Bearer  cm_agent_valid ' },
  { 'x-commonly-agent-token': ' cm_agent_valid ' },
  { Authorization: 'cm_agent_alone' },
];
test.each(HEADER_SETS)('the agent bucket is keyed on the token the agent verifier reads, for %j', (headers) => {
  const req = { header: (name) => headers[name] };
  const chosen = resolveDualAuthCredential(req);
  const read = agentRuntimeCredential(req);
  if (chosen.verifier === 'agent') expect(chosen.token).toBe(read);
  else expect(read.startsWith('cm_agent_')).toBe(false);
});

test('rotating a non-Bearer Authorization keeps one bucket and still authenticates as the real token', async () => {
  const keys = HEADER_SETS.slice(0, 4).map((headers) => resolveDualAuthCredential({ header: (name) => headers[name] }));
  expect(new Set(keys.map((key) => key.token))).toEqual(new Set(['cm_agent_valid']));
  keys.forEach((key) => expect(key.verifier).toBe('agent'));
  const res = await request(app).get('/').set({ Authorization: 'cm_agent_junk-3', 'x-commonly-agent-token': 'cm_agent_valid' });
  expect(res.status).toBe(200);
  expect(agentAuth).toHaveBeenCalledTimes(1);
});

test('agentRuntimeAuth and the agent-only grant limiter read the token through the shared parser', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
  const auth = read('middleware/agentRuntimeAuth.ts');
  expect(auth).toMatch(/agentRuntimeCredential\(req\)/);
  expect(auth).not.toMatch(/startsWith\('Bearer '\)/);
  expect(read('routes/grants.ts')).toMatch(/agentGrantCredential = bindGrantLimiterCredential\(\(req\) => agentRuntimeCredential\(/);
});
