// Claim ids and ingest-token hashes are references to server-side state: they
// fence an install or an OAuth bind, or authenticate an ingest call. They must
// leave through neither the model's toJSON nor the lean catalog read.

const Integration = require('../../../models/Integration');
const { toPublicIntegration } = require('../../../models/integrationPublicConfig');

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
