// Claim ids and ingest-token hashes are references to server-side state: they
// fence an install or an OAuth bind, or authenticate an ingest call. They must
// leave through neither the model's toJSON nor the lean catalog read.

const Integration = require('../../../models/Integration');
const { toPublicIntegration, withoutConnectCode } = require('../../../models/integrationPublicConfig');

const TOKEN_HASH = 'hash_of_an_ingest_token';
const INSTALL_CLAIM = 'install_claim_fence';
const OAUTH_CLAIM = 'oauth_state_claim_fence';

const row = () => ({
  type: 'telegram',
  podId: '64b000000000000000000010',
  createdBy: '64b000000000000000000011',
  installationClaimId: INSTALL_CLAIM,
  ingestTokens: [{
    tokenHash: TOKEN_HASH, label: 'ci', createdBy: '64b000000000000000000011', createdAt: new Date('2026-09-01T00:00:00Z'),
  }],
  config: { connectCode: 'ENABLE123', oauthStateClaimId: OAUTH_CLAIM, botToken: 'bot_secret' },
});

const expectPublic = (out) => {
  const text = JSON.stringify(out);
  expect(text).not.toContain(TOKEN_HASH);
  expect(text).not.toContain(INSTALL_CLAIM);
  expect(text).not.toContain(OAUTH_CLAIM);
  expect(text).not.toContain('bot_secret');
  expect(out.ingestTokens).toHaveLength(1);
  expect(out.ingestTokens[0]).toMatchObject({ label: 'ci' });
  expect(out.ingestTokens[0]).not.toHaveProperty('tokenHash');
  expect(out.config.connectCode).toBe('ENABLE123');
};

describe('toPublicIntegration', () => {
  it('strips claim ids and ingest-token hashes through the model toJSON', () => {
    expectPublic(new Integration(row()).toJSON());
  });

  it('strips the same fields from a lean row', () => {
    expectPublic(toPublicIntegration(JSON.parse(JSON.stringify(row()))));
  });

  it('leaves toObject intact for server code that reads the hash', () => {
    const doc = new Integration(row()).toObject();
    expect(doc.installationClaimId).toBe(INSTALL_CLAIM);
    expect(doc.ingestTokens[0].tokenHash).toBe(TOKEN_HASH);
    expect(doc.config.oauthStateClaimId).toBe(OAUTH_CLAIM);
  });

  it('passes null and non-objects through', () => {
    expect(toPublicIntegration(null)).toBeNull();
    expect(toPublicIntegration(undefined)).toBeUndefined();
  });
});

describe('withoutConnectCode', () => {
  it('drops the connect code and its expiry and keeps the rest of config', () => {
    const out = withoutConnectCode(toPublicIntegration(JSON.parse(JSON.stringify({
      ...row(), config: { connectCode: 'ENABLE123', connectCodeExpiresAt: '2026-09-12T00:10:00Z', chatTitle: 'Ops' },
    }))));
    expect(out.config).toEqual({ chatTitle: 'Ops' });
  });

  it('passes a row without config through', () => {
    expect(withoutConnectCode({ type: 'slack' })).toEqual({ type: 'slack' });
    expect(withoutConnectCode(null)).toBeNull();
  });
});

// The viewer projection is applied on every surface that returns a connector
// row: the pod read and the write echoes (PATCH /:id, POST /:id/connect-code).
// Those write routes are gated by canDeleteIntegration, which also admits the
// POD's creator — so "not the connector's creator" is a shape that reaches
// them, and an echo that skips this projection is a leak (#1731 review).
describe('projectIntegrationForViewer', () => {
  const { projectIntegrationForViewer } = require('../../../models/integrationPublicConfig');
  const CREATOR = '64b000000000000000000011';

  const connector = (overrides = {}) => ({
    type: 'telegram',
    createdBy: CREATOR,
    config: {
      chatId: '-1004444',
      chatTitle: 'Ops',
      linkedUserId: CREATOR,
      relayMap: [{ tgMessageId: '900' }],
      messageBuffer: [{ messageId: 'm-1' }],
      accessToken: 'SENTINEL_ACCESS_TOKEN',
    },
    ...overrides,
  });

  it('gives a pod member who is not the connector creator linked + chatTitle, and no routing state', () => {
    const out = projectIntegrationForViewer(connector(), { requesterId: '64b000000000000000000099', isAdmin: false });
    expect(out.config.linked).toBe(true);
    expect(out.config.chatTitle).toBe('Ops');
    expect(out.config).not.toHaveProperty('chatId');
    expect(out.config).not.toHaveProperty('linkedUserId');
    expect(out.config).not.toHaveProperty('relayMap');
    expect(out.config).not.toHaveProperty('messageBuffer');
  });

  it('gives the connector creator and an admin the row whole, `linked` included', () => {
    for (const viewer of [{ requesterId: CREATOR, isAdmin: false }, { requesterId: 'someone-else', isAdmin: true }]) {
      const out = projectIntegrationForViewer(connector(), viewer);
      expect(out.config.chatId).toBe('-1004444');
      expect(out.config.relayMap).toHaveLength(1);
      expect(out.config.linked).toBe(true);
    }
  });

  it('accepts a document as well as a plain row, so toJSON still strips credentials', () => {
    const out = projectIntegrationForViewer(new Integration(connector()), { requesterId: CREATOR, isAdmin: false });
    expect(out.config.chatId).toBe('-1004444');
    expect(out.config).not.toHaveProperty('accessToken');
  });

  it('treats a populated createdBy and a missing viewer as their own cases', () => {
    const populated = projectIntegrationForViewer(connector({ createdBy: { _id: CREATOR } }), { requesterId: CREATOR, isAdmin: false });
    expect(populated.config.chatId).toBe('-1004444');
    const anonymous = projectIntegrationForViewer(connector(), null);
    expect(anonymous.config).not.toHaveProperty('chatId');
    expect(anonymous.config.linked).toBe(true);
  });
});
