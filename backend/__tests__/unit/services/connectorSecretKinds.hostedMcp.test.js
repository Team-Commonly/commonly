const {
  CONNECTOR_SECRET_KINDS,
  HOSTED_MCP_ACCESS_TOKEN,
  HOSTED_MCP_REFRESH_TOKEN,
  kindSpec,
  rowReferencesSecret,
} = require('../../../services/connectorSecretKinds');
const { isServerOwnedConfigKey, SERVER_OWNED_CONFIG_KEYS } = require('../../../utils/serverOwnedConfigKeys');

// TASK-172 adds the first connector secret kinds outside Slack and Discord: the
// member's own OAuth pair for a vendor-hosted MCP server (scope §2, §4). The
// module doc names the four sites that read it and the three that fail
// silently. The one this test instruments is the orphan sweep's keep-condition:
// a ref path the kind does not name is a secret the sweep DELETES about ten
// minutes after it is written, and that failure is silent — the row still reads
// as connected.
describe('the hosted-mcp connector secret kinds', () => {
  it('are registered, under the type that owns them, at the paths the row writes', () => {
    expect(kindSpec('hosted-mcp-access-token')).toMatchObject({ provider: 'hosted-mcp', refPaths: ['config.credentialRef'] });
    expect(kindSpec('hosted-mcp-refresh-token')).toMatchObject({ provider: 'hosted-mcp', refPaths: ['config.refreshTokenRef'] });
    expect(CONNECTOR_SECRET_KINDS).toContain(HOSTED_MCP_ACCESS_TOKEN);
    expect(CONNECTOR_SECRET_KINDS).toContain(HOSTED_MCP_REFRESH_TOKEN);
  });

  it('makes the orphan sweep keep a row that still holds either ref', () => {
    const row = { type: 'hosted-mcp', config: { credentialRef: 'ref-access-1', refreshTokenRef: 'ref-refresh-1' } };

    expect(rowReferencesSecret(row, HOSTED_MCP_ACCESS_TOKEN, 'ref-access-1')).toBe(true);
    expect(rowReferencesSecret(row, HOSTED_MCP_REFRESH_TOKEN, 'ref-refresh-1')).toBe(true);
  });

  it('does not let one kind answer for the other\'s ref', () => {
    // Control for the arm above: if both kinds shared a ref path, each would
    // report the other's secret as still referenced and the sweep would keep a
    // rotated token alive. The answer must differ by KIND, not by "the row has
    // some ref".
    const row = { type: 'hosted-mcp', config: { credentialRef: 'ref-access-1' } };

    expect(rowReferencesSecret(row, HOSTED_MCP_ACCESS_TOKEN, 'ref-access-1')).toBe(true);
    expect(rowReferencesSecret(row, HOSTED_MCP_REFRESH_TOKEN, 'ref-access-1')).toBe(false);
  });
});

// The OAuth callback is the only writer of these keys, so every one of them
// must be refused from a request body. Two lists have to agree for that, and
// they live in different files.
describe('every hosted-mcp config key is server-owned', () => {
  const RECORD_KEYS = [
    'entryId', 'intake', 'providerSubject', 'grantedScope', 'expiresAt',
    'credentialRef', 'refreshTokenRef', 'refreshGeneration', 'credentialHint', 'pendingAuth',
  ];

  it('lists each of them in SERVER_OWNED_CONFIG_KEYS', () => {
    expect(RECORD_KEYS.filter((key) => !isServerOwnedConfigKey(key))).toEqual([]);
  });

  it('positive control: membership is selective, not a predicate that says yes', () => {
    // Real connector fields a member configures from the UI, so a strip that
    // said yes to everything would eat a legitimate config write. (`chatTitle`
    // is NOT one of these — it is server-owned, which the first draft of this
    // control assumed and the assertion refused.)
    expect(SERVER_OWNED_CONFIG_KEYS).not.toContain('channelId');
    expect(isServerOwnedConfigKey('channelId')).toBe(false);
    expect(isServerOwnedConfigKey('maxResults')).toBe(false);
  });
});
