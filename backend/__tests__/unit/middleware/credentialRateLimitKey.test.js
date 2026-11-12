// F455: a write limiter keys on the credential its route's verifier reads.
// POST /api/messages/:podId sits behind `auth` alone, which verifies the human
// token, so an agent-token header it never reads must not move the bucket.
// (The task-write limiters sit behind dualAuth, whose own choice they key on.)
const fs = require('fs');
const path = require('path');
const {
  humanCredentialRateLimitKey,
  messageWriteRateLimitKey,
} = require('../../../middleware/credentialRateLimitKey');
const { humanAuthCredential } = require('../../../middleware/auth');

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

test('the message limiter uses this key, and auth.ts reads its token through humanAuthCredential', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
  const messages = read('routes/messages.ts');
  expect(messages).toMatch(/keyGenerator: messageWriteRateLimitKey/);
  expect(messages).toMatch(/router.post\('\/:podId', sendMessageRateLimit, auth, createMessage\)/);
  expect(read('middleware/auth.ts')).toMatch(/let token = humanAuthCredential\(req\)/);
});
