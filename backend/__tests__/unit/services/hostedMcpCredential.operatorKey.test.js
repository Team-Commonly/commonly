/**
 * `credentialFor` on an operator-key entry (TASK-330, Vera's read §3): the
 * stored key is served as it stands, with no fence, no lease and no vendor
 * refresh, and the freshness rule does not decide it.
 */
const { credentialFor, HostedMcpCredentialError } = require('../../../services/hostedMcpCredentialService');

const KEY_ENTRY = { id: 'latchkey', credentialMode: 'operator_key' };
const ROW = {
  _id: '68e1f2a4b5c6d7e8f9a0b1c2',
  status: 'connected',
  revokedAt: null,
  config: { entryId: 'latchkey', agentId: 'a1', credentialRef: 'ref-key-1' },
};

const deps = (overrides = {}) => {
  const bumpGeneration = jest.fn();
  const secretsGet = jest.fn(async (ref) => `token-for-${ref}`);
  return {
    bumpGeneration,
    secretsGet,
    overrides: {
      entryFor: () => KEY_ENTRY,
      secrets: { get: secretsGet, put: jest.fn(), revoke: jest.fn() },
      row: { bumpGeneration, markClientMismatch: jest.fn() },
      now: () => new Date('2026-10-31T06:00:00.000Z'),
      ...overrides,
    },
  };
};

describe('credentialFor on an operator-key entry', () => {
  it('serves the stored key without touching the fence or the vendor', async () => {
    const d = deps();
    const out = await credentialFor(ROW, d.overrides);
    expect(out).toEqual({ token: 'token-for-ref-key-1', expiresAt: '' });
    expect(d.secretsGet).toHaveBeenCalledWith('ref-key-1');
    expect(d.bumpGeneration).not.toHaveBeenCalled();
  });

  it('serves the key whatever its lifetime says, because lifetime is not its rule', async () => {
    const d = deps();
    const expired = { ...ROW, config: { ...ROW.config, expiresAt: new Date('2000-01-01T00:00:00.000Z') } };
    await expect(credentialFor(expired, d.overrides)).resolves.toMatchObject({ token: 'token-for-ref-key-1' });
  });

  it('refuses with reconnect_required when no key is stored', async () => {
    const d = deps();
    const noKey = { ...ROW, config: { entryId: 'latchkey', agentId: 'a1' } };
    await expect(credentialFor(noKey, d.overrides)).rejects.toMatchObject({
      code: 'reconnect_required',
    });
    await expect(credentialFor(noKey, d.overrides)).rejects.toBeInstanceOf(HostedMcpCredentialError);
    expect(d.secretsGet).not.toHaveBeenCalled();
  });

  it('refuses a removed connection before it reads the key', async () => {
    const d = deps();
    await expect(credentialFor({ ...ROW, revokedAt: new Date() }, d.overrides)).rejects.toMatchObject({
      code: 'connection_mismatch',
    });
    expect(d.secretsGet).not.toHaveBeenCalled();
  });
});
