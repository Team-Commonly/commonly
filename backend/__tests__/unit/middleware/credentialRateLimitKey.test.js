// F455: a write limiter keys on the credential its route's verifier reads.
// POST /api/messages/:podId sits behind `auth` alone, which verifies the human
// token, so an agent-token header it never reads must not move the bucket.
// (The task-write limiters sit behind dualAuth, whose own choice they key on.)
const fs = require('fs');
const path = require('path');
jest.mock('jsonwebtoken', () => ({ verify: jest.fn(() => { throw new Error('stop after the token is read'); }) }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/apiTokenService', () => ({ findApiTokenUser: jest.fn() }));
jest.mock('../../../services/sessionAccountService', () => ({
  isAccountInstanceRestricted: jest.fn(), loadSessionAccount: jest.fn(), sessionRefusal: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const {
  humanAuthCredential,
  humanCredentialRateLimitKey,
  messageWriteRateLimitKey,
} = require('../../../middleware/credentialRateLimitKey');
const auth = require('../../../middleware/auth');

const reqOf = (headers, method = 'POST') => ({
  method,
  headers: {},
  ip: '203.0.113.9',
  header: (name) => headers[name],
  get: (name) => headers[name],
});

const HUMAN_SHAPES = [
  { 'x-auth-token': 'person-jwt' },
  { Authorization: 'person-jwt' },
  { Authorization: 'Bearer person-jwt' },
];

describe.each(HUMAN_SHAPES)('a human request carrying %j', (human) => {
  test('rotating x-commonly-agent-token keeps one message-post bucket', () => {
    const keys = ['a', 'b', 'c'].map((n) => messageWriteRateLimitKey(
      reqOf({ ...human, 'x-commonly-agent-token': `cm_agent_${n}` }),
    ));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(messageWriteRateLimitKey(reqOf(human)));
  });
});

test('the human key names the token auth.ts verifies', () => {
  expect(humanAuthCredential(reqOf({ Authorization: 'Bearer person-jwt', 'x-auth-token': 'other' }))).toBe('person-jwt');
  expect(humanAuthCredential(reqOf({ 'x-auth-token': 'person-jwt' }))).toBe('person-jwt');
  expect(humanAuthCredential(reqOf({ 'x-commonly-agent-token': 'cm_agent_a' }))).toBe('');
  expect(humanCredentialRateLimitKey(reqOf({ 'x-auth-token': 'p1' })))
    .not.toBe(humanCredentialRateLimitKey(reqOf({ 'x-auth-token': 'p2' })));
});

test('a message delete still keys on the dual-auth credential, so an agent token is its own bucket', () => {
  const a = messageWriteRateLimitKey(reqOf({ 'x-commonly-agent-token': 'cm_agent_a' }, 'DELETE'));
  const b = messageWriteRateLimitKey(reqOf({ 'x-commonly-agent-token': 'cm_agent_b' }, 'DELETE'));
  expect(a).toMatch(/^tok:/);
  expect(a).not.toBe(b);
});

// auth.ts is left untouched (an edit re-flags every route's CodeQL rate-limit
// alert), so the limiter keeps its own copy of auth's token read. This runs
// auth() itself and fails the moment the two read different tokens.
test.each([
  [{ Authorization: 'Bearer person-jwt' }],
  [{ Authorization: 'person-jwt' }],
  [{ 'x-auth-token': 'person-jwt' }],
  [{ Authorization: 'Bearer person-jwt', 'x-auth-token': 'other' }],
  [{ Authorization: 'Bearer ', 'x-auth-token': 'person-jwt' }],
  [{ Authorization: 'Bearer  spaced ' }],
  [{ 'x-commonly-agent-token': 'cm_agent_a', 'x-auth-token': 'person-jwt' }],
  [{}],
])('auth() verifies exactly the token humanAuthCredential reads, for %j', async (headers) => {
  jwt.verify.mockClear();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await auth(reqOf(headers), res, jest.fn());
  const expected = humanAuthCredential(reqOf(headers));
  if (expected) expect(jwt.verify.mock.calls[0][0]).toBe(expected);
  else expect(jwt.verify).not.toHaveBeenCalled();
});

test('the message limiter uses this key, and auth.ts stays untouched', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
  const messages = read('routes/messages.ts');
  expect(messages).toMatch(/keyGenerator: messageWriteRateLimitKey/);
  expect(messages).toMatch(/router.post\('\/:podId', sendMessageRateLimit, auth, createMessage\)/);
  expect(read('middleware/auth.ts')).not.toMatch(/credentialRateLimitKey|humanAuthCredential/);
});

// F456: the read limiter (behind auth) and the reaction / thread-state
// limiter (behind dualAuth) keyed on the raw Authorization header alone, so a
// caller using only an alt header fell to the shared address bucket.
const { dualCredentialRateLimitKey, reactionRateLimitKey } = require('../../../middleware/credentialRateLimitKey');

const IP_KEY = humanCredentialRateLimitKey(reqOf({}));

test('a person who signs in with x-auth-token gets their own read bucket, not the address one', () => {
  const a = humanCredentialRateLimitKey(reqOf({ 'x-auth-token': 'p1' }, 'GET'));
  const b = humanCredentialRateLimitKey(reqOf({ 'x-auth-token': 'p2' }, 'GET'));
  expect(a).not.toBe(IP_KEY);
  expect(a).not.toBe(b);
  expect(a).toBe(humanCredentialRateLimitKey(reqOf({ Authorization: 'Bearer p1' }, 'GET')));
});

test('an agent using only x-commonly-agent-token gets its own reaction bucket', () => {
  const a = dualCredentialRateLimitKey(reqOf({ 'x-commonly-agent-token': 'cm_agent_a' }), 'rxn');
  const b = dualCredentialRateLimitKey(reqOf({ 'x-commonly-agent-token': 'cm_agent_b' }), 'rxn');
  expect(a).toMatch(/^rxn:/);
  expect(a).not.toBe(b);
  expect(a).toBe(dualCredentialRateLimitKey(reqOf({ Authorization: 'Bearer cm_agent_a' }), 'rxn'));
});

test('a person on x-auth-token gets their own reaction bucket too', () => {
  const a = dualCredentialRateLimitKey(reqOf({ 'x-auth-token': 'p1' }), 'rxn');
  expect(a).toMatch(/^rxn:/);
  expect(a).not.toBe(dualCredentialRateLimitKey(reqOf({ 'x-auth-token': 'p2' }), 'rxn'));
});

test('the read and reaction limiters use these keys', () => {
  const messages = fs.readFileSync(path.join(__dirname, '../../../routes/messages.ts'), 'utf8');
  expect(messages).toMatch(/readMessageRateLimit = rateLimit\(\{[\s\S]*?keyGenerator: humanCredentialRateLimitKey,/);
  expect(messages).toMatch(/reactionRateLimit = rateLimit\(\{[\s\S]*?keyGenerator: reactionRateLimitKey,/);
  expect(reactionRateLimitKey(reqOf({ 'x-commonly-agent-token': 'cm_agent_a' })))
    .toBe(dualCredentialRateLimitKey(reqOf({ 'x-commonly-agent-token': 'cm_agent_a' }), 'rxn'));
  expect(messages).not.toMatch(/req\.get\?\.\('authorization'\)/);
});
