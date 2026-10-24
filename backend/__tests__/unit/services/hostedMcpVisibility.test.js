const { isHostedMcpEntryHidden } = require('../../../integrations/hostedMcp/visibility');
const walkUser = '64b64c48c4f37a6b2f34c111';
const otherUser = '64b64c48c4f37a6b2f34c222';
const envFor = (map) => ({
  HOSTED_MCP_HIDDEN_ENTRIES: '["sentry","airtable"]',
  HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST: JSON.stringify(map),
});

test('exceptions are exact user and entry pairs; public entries keep their normal policy', () => {
  const env = envFor({ sentry: [walkUser] });
  expect(isHostedMcpEntryHidden('sentry', env, walkUser)).toBe(false);
  expect(isHostedMcpEntryHidden('sentry', env, otherUser)).toBe(true);
  expect(isHostedMcpEntryHidden('airtable', env, walkUser)).toBe(true);
  expect(isHostedMcpEntryHidden('linear', env, otherUser)).toBe(false);
  expect(isHostedMcpEntryHidden('sentry', { HOSTED_MCP_HIDDEN_ENTRIES: '["sentry"]' }, walkUser)).toBe(true);
  expect(isHostedMcpEntryHidden('sentry', envFor({}), walkUser)).toBe(true);
});

test.each([undefined, null, '', 'walk-user', '64B64C48C4F37A6B2F34C111', {}, [walkUser]])(
  'missing or noncanonical authenticated identity grants no exception: %p', (id) => {
    expect(isHostedMcpEntryHidden('sentry', envFor({ sentry: [walkUser] }), id)).toBe(true);
  },
);

test.each([
  null, [], 'sentry', 42,
  { sentry: [walkUser], typo: [walkUser] },
  { sentry: [walkUser], 'bad key': [] },
  { sentry: [walkUser], airtable: 'bad' },
  { sentry: [walkUser], airtable: [otherUser, null] },
  { sentry: [walkUser], airtable: ['walk-user'] },
  { sentry: [walkUser], airtable: ['64B64C48C4F37A6B2F34C111'] },
])('one invalid member invalidates all exceptions: %p', (map) => {
  expect(isHostedMcpEntryHidden('sentry', envFor(map), walkUser)).toBe(true);
});

test('invalid JSON and empty arrays fail closed for hidden entries', () => {
  const env = envFor({ sentry: [] });
  expect(isHostedMcpEntryHidden('sentry', env, walkUser)).toBe(true);
  env.HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST = '{';
  expect(isHostedMcpEntryHidden('sentry', env, walkUser)).toBe(true);
});
