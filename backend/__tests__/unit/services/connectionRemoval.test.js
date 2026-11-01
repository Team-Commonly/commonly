// TASK-172 §10 step 6 — the removal sequence for a hosted-MCP Connection.
//
// §9 fixes the order: grants, row, provider, mark, material, delete. The order
// is the control and not a presentation of it, so these arms assert the ORDER,
// not the outcome: a version that revoked the material first and then failed at
// the vendor would leave a live authorization nobody could reach while every
// "was it removed" assertion still read correctly.
//
// The material read is discriminated on the error's CODE, not its class: only
// `connector_secret_not_found` means "we hold nothing to revoke". The other two
// typed errors mean the ring is misconfigured or the key is gone, and both must
// keep the row — otherwise one bad key ring deletes every hosted row that day
// while recording the vendor revoke as done.
jest.mock('jsonwebtoken', () => ({}));
jest.mock('../../../models/Integration', () => ({
  updateOne: jest.fn(async () => ({ acknowledged: true })),
  findOneAndUpdate: jest.fn(() => {
    const query = { lean: async () => null };
    query.select = () => query;
    return query;
  }),
  findByIdAndDelete: jest.fn(async () => ({ _id: 'row' })),
}));

const {
  removeConnection,
  revokeTokenAtVendor,
  defaultDeps,
  PROVIDER_REVOKED_MARK,
  WRITER_LEASE_OVERRUN_MS,
} = require('../../../services/connectionRemovalService');

const Integration = require('../../../models/Integration');

const PAGE = 'https://linear.app/settings/security';
const ENDPOINT = 'https://mcp.linear.app/token';

const ENTRY = {
  id: 'linear',
  revoke: { page: PAGE, endpoint: ENDPOINT },
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  resource: 'https://mcp.linear.app/mcp',
};

const hostedRow = (over = {}) => ({
  _id: 'row-1',
  type: 'hosted-mcp',
  status: 'connected',
  ...over,
  config: over.config
    ? { clientId: 'commonly-client', ...over.config }
    : {
      entryId: 'linear',
      clientId: 'commonly-client',
      credentialRef: 'access-ref',
      refreshTokenRef: 'refresh-ref',
    },
});

/** An error carrying the code `connectorSecrets` throws, without importing it. */
const codedError = (code, message = code) => Object.assign(new Error(message), { code });

// The removal reads the row back from its own disconnect write (F34), so the
// recorder answers that write with the row the arm handed to `remove`, as it
// stands after the write.
let rowOnDisk = null;

/** A deps set that records the order every step was reached in. */
const recorder = (over = {}) => {
  const calls = [];
  const deps = {
    now: () => new Date('2026-09-29T23:00:00.000Z'),
    markDisconnected: jest.fn(async () => {
      calls.push('row');
      return rowOnDisk && { ...rowOnDisk, status: 'disconnected' };
    }),
    // Silent in `calls`: the order arms are about the removal's steps, and
    // the lease brackets all of them.
    takeRemovalLease: jest.fn(async () => true),
    releaseRemovalLease: jest.fn(async () => {}),
    markProviderRevoked: jest.fn(async () => { calls.push('mark'); }),
    entryFor: jest.fn(() => ENTRY),
    clientIdFor: jest.fn(() => 'commonly-client'),
    clientSecretFor: jest.fn(() => undefined),
    revokeAtVendor: jest.fn(async () => { calls.push('provider'); }),
    secrets: {
      get: jest.fn(async (ref) => { calls.push(`get:${ref}`); return 'refresh-token-value'; }),
      revoke: jest.fn(async (ref) => { calls.push(`material:${ref}`); }),
    },
    remove: jest.fn(async () => { calls.push('delete'); }),
    ...over,
  };
  const revokeGrants = jest.fn(async () => { calls.push('grants'); return 2; });
  return { calls, deps, revokeGrants };
};

const remove = (row, deps, revokeGrants) => {
  rowOnDisk = row;
  return removeConnection({
    connection: row,
    removedBy: 'owner-1',
    revokeGrants,
    deps,
  });
};

describe('removeConnection (a hosted-MCP row)', () => {
  it('revokes a retired DCR row with its recorded client rather than the current registration', async () => {
    const dcrEntry = { ...ENTRY, client: 'dcr' };
    const { deps, revokeGrants } = recorder({ entryFor: () => dcrEntry });
    deps.dcrClientForRow = jest.fn(async () => ({ clientId: 'retired-client' }));
    deps.clientIdFor = jest.fn(() => 'new-current-client');
    const row = hostedRow({ config: {
      entryId: 'linear', clientId: 'retired-client',
      credentialRef: 'access-ref', refreshTokenRef: 'refresh-ref',
    } });
    const result = await remove(row, deps, revokeGrants);
    expect(result.removed).toBe(true);
    expect(deps.dcrClientForRow).toHaveBeenCalledWith(dcrEntry, 'retired-client');
    expect(deps.revokeAtVendor).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'retired-client' }));
    expect(deps.clientIdFor).not.toHaveBeenCalled();
  });

  it('revokes a DCR confidential row with the method it registered (TASK-248)', async () => {
    const dcrEntry = { ...ENTRY, client: 'dcr' };
    const { deps, revokeGrants } = recorder({ entryFor: () => dcrEntry });
    deps.dcrClientForRow = jest.fn(async () => ({
      clientId: 'conf-1', clientSecret: 'registered-secret', tokenEndpointAuthMethod: 'client_secret_post',
    }));
    const row = hostedRow({ config: {
      entryId: 'linear', clientId: 'conf-1', credentialRef: 'access-ref', refreshTokenRef: 'refresh-ref',
    } });
    const result = await remove(row, deps, revokeGrants);
    expect(result.removed).toBe(true);
    expect(deps.revokeAtVendor).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'conf-1', clientSecret: 'registered-secret', tokenEndpointAuthMethod: 'client_secret_post',
    }));
  });

  it('removes a refused DCR row locally and returns the vendor page without sending its token', async () => {
    const dcrEntry = { ...ENTRY, client: 'dcr' };
    const { deps, revokeGrants } = recorder({ entryFor: () => dcrEntry });
    deps.dcrClientForRow = jest.fn(async () => null);
    const result = await remove(hostedRow(), deps, revokeGrants);
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: false });
    expect(deps.secrets.get).not.toHaveBeenCalled();
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.remove).toHaveBeenCalled();
  });

  it('finishes locally when the vendor rejects a DCR revocation as invalid_client', async () => {
    const dcrEntry = { ...ENTRY, client: 'dcr' };
    const { deps, revokeGrants } = recorder({ entryFor: () => dcrEntry });
    deps.dcrClientForRow = jest.fn(async () => ({ clientId: 'refused-client' }));
    deps.revokeAtVendor = jest.fn(async () => { throw codedError('invalid_client'); });
    const result = await remove(hostedRow({ config: {
      entryId: 'linear', clientId: 'refused-client',
      credentialRef: 'access-ref', refreshTokenRef: 'refresh-ref',
    } }), deps, revokeGrants);
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: false });
    expect(deps.markProviderRevoked).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).toHaveBeenCalledWith('refresh-ref');
    expect(deps.remove).toHaveBeenCalled();
  });
  it('runs grants, row, provider, mark, material, delete in that order', async () => {
    const { calls, deps, revokeGrants } = recorder();
    const result = await remove(hostedRow(), deps, revokeGrants);
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: true });
    // The mark is between the provider revoke and the material on purpose: it
    // is the only record that survives the request, so it has to be written
    // while the material it protects is still there.
    expect(calls).toEqual([
      'grants',
      'row',
      'get:refresh-ref',
      'provider',
      'mark',
      'material:refresh-ref',
      'material:access-ref',
      'delete',
    ]);
  });

  it('marks the row disconnected and revokedAt, and never touches isActive', async () => {
    const { deps, revokeGrants } = recorder();
    await remove(hostedRow(), deps, revokeGrants);
    expect(deps.markDisconnected).toHaveBeenCalledWith(
      'row-1',
      new Date('2026-09-29T23:00:00.000Z'),
    );
  });

  it('leaves the row and its references for a retry when the vendor refuses', async () => {
    const { deps, revokeGrants } = recorder({
      revokeAtVendor: jest.fn(async () => { throw new Error('provider revoke refused: HTTP 503'); }),
    });
    const result = await remove(hostedRow(), deps, revokeGrants);
    // A refusal carries the page too, so the person can act on the refusal
    // itself rather than only on a success (§10.5).
    expect(result).toEqual({
      removed: false,
      code: 'provider_revoke_failed',
      message: 'provider revoke refused: HTTP 503',
      grantsRevoked: 2,
      revokeAt: PAGE,
    });
    expect(deps.markDisconnected).toHaveBeenCalled();
    // No mark: the provider revoke did NOT take, so a retry has to call the
    // vendor again. A mark written here would make every retry skip it.
    expect(deps.markProviderRevoked).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('refuses, and keeps the material, when the row names no entry we hold', async () => {
    const { deps, revokeGrants } = recorder({ entryFor: jest.fn(() => null) });
    const result = await remove(hostedRow({ config: { entryId: 'gone' } }), deps, revokeGrants);
    expect(result.removed).toBe(false);
    expect(result.code).toBe('provider_revoke_failed');
    expect(result.message).toMatch(/names no known entry \(gone\)/);
    // No page can be carried: the entry that names one is exactly what is missing.
    expect(result.revokeAt).toBeUndefined();
    // Grants still went: a grant on a row we cannot finish removing must not
    // survive the attempt.
    expect(revokeGrants).toHaveBeenCalled();
    // The row is marked before the entry is even resolved, so an attempt that
    // cannot complete still leaves the broker refusing the row.
    expect(deps.markDisconnected).toHaveBeenCalled();
    expect(deps.secrets.revoke).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  // §10.5: "nothing we hold can revoke" is not a kept row — it is a finished
  // removal that hands the person the page. A kept row there only waits on a
  // retry that can never succeed. Exactly ONE of the three typed errors means
  // that, so the three arms below are the whole discriminator.
  it('finishes, and returns the page, when the secret is not found at all', async () => {
    const { deps, revokeGrants } = recorder();
    deps.secrets.get = jest.fn(async () => {
      throw codedError('connector_secret_not_found', 'no such secret');
    });
    const result = await remove(hostedRow(), deps, revokeGrants);
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: false });
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).toHaveBeenCalledWith('refresh-ref');
    // The token is the one the ROW NAMES. Falling back to the access token when
    // the named secret is not found would try to revoke a grant we may still
    // hold — RFC 7009 §2.1 makes an access-token revoke a MAY, so the refresh
    // token can survive it — and the second read is what would do it. A mock
    // that throws for every reference cannot see that, so the read is counted.
    expect(deps.secrets.get).toHaveBeenCalledTimes(1);
    expect(deps.secrets.get).toHaveBeenCalledWith('refresh-ref');
    expect(deps.secrets.get).not.toHaveBeenCalledWith('access-ref');
    expect(deps.remove).toHaveBeenCalled();
  });

  it('keeps the row when the secret ring is misconfigured', async () => {
    const { deps, revokeGrants } = recorder();
    deps.secrets.get = jest.fn(async () => {
      throw codedError('connector_secret_configuration_invalid', 'key ring misconfigured');
    });
    const result = await remove(hostedRow(), deps, revokeGrants);
    expect(result).toEqual({
      removed: false,
      code: 'provider_revoke_failed',
      message: 'key ring misconfigured',
      grantsRevoked: 2,
      revokeAt: PAGE,
    });
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.markProviderRevoked).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('keeps the row when the key is no longer in the ring', async () => {
    const { deps, revokeGrants } = recorder();
    deps.secrets.get = jest.fn(async () => {
      throw codedError('connector_secret_key_missing', 'key missing');
    });
    const result = await remove(hostedRow(), deps, revokeGrants);
    expect(result.removed).toBe(false);
    expect(result.code).toBe('provider_revoke_failed');
    expect(result.message).toBe('key missing');
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('sends the access token when the row has no refresh token', async () => {
    const { deps, revokeGrants } = recorder();
    const row = hostedRow({ config: { entryId: 'linear', credentialRef: 'access-ref' } });
    const result = await remove(row, deps, revokeGrants);
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: true });
    // The token we hold is the access token, so that is the one that goes — and
    // the hint has to follow it, or the AS may answer `unsupported_token_type`.
    expect(deps.secrets.get).toHaveBeenCalledWith('access-ref');
    expect(deps.revokeAtVendor).toHaveBeenCalledWith({
      entry: ENTRY,
      clientId: 'commonly-client',
      token: 'refresh-token-value',
      tokenTypeHint: 'access_token',
    });
  });

  it('a removal whose row was minted under another client sends nothing and returns the page as revokeAt', async () => {
    const { calls, deps, revokeGrants } = recorder({
      clientIdFor: jest.fn(() => 'rotated-client'),
    });
    const row = hostedRow({ config: {
      entryId: 'linear',
      clientId: 'commonly-client',
      credentialRef: 'access-ref',
      refreshTokenRef: 'refresh-ref',
    } });

    const result = await remove(row, deps, revokeGrants);

    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: false });
    expect(deps.secrets.get).not.toHaveBeenCalled();
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.markProviderRevoked).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).toHaveBeenCalledWith('refresh-ref');
    expect(deps.remove).toHaveBeenCalledWith('row-1');
    expect(calls).toEqual([
      'grants', 'row', 'material:refresh-ref', 'material:access-ref', 'delete',
    ]);
  });

  it('a legacy removal without a client snapshot uses Linear until the backfill completes', async () => {
    const { deps, revokeGrants } = recorder();
    const row = hostedRow({ config: {
      entryId: 'linear',
      clientId: undefined,
      credentialRef: 'access-ref',
      refreshTokenRef: 'refresh-ref',
    } });

    const result = await remove(row, deps, revokeGrants);

    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: true });
    expect(deps.revokeAtVendor).toHaveBeenCalledWith({
      entry: ENTRY,
      clientId: 'commonly-client',
      token: 'refresh-token-value',
      tokenTypeHint: 'refresh_token',
    });
  });

  it('sends nothing, and still finishes, when the row holds no reference at all', async () => {
    const { deps, revokeGrants } = recorder();
    const row = hostedRow({ config: { entryId: 'linear' } });
    const result = await remove(row, deps, revokeGrants);
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: false });
    // No reference means no `token: ""`: RFC 7009 answers the empty string 200
    // for a request that revoked nothing, which would read as a revoke.
    expect(deps.secrets.get).not.toHaveBeenCalled();
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.markProviderRevoked).not.toHaveBeenCalled();
    expect(deps.remove).toHaveBeenCalled();
  });

  it('sends nothing when the stored secret is blank', async () => {
    const { deps, revokeGrants } = recorder({ secrets: {
      get: jest.fn(async () => ''),
      revoke: jest.fn(async () => {}),
    } });
    const result = await remove(hostedRow(), deps, revokeGrants);
    expect(result.removed).toBe(true);
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.remove).toHaveBeenCalled();
  });

  it('skips the vendor on a retry that finds the mark', async () => {
    const { deps, revokeGrants } = recorder();
    const row = hostedRow({
      status: 'disconnected',
      config: {
        entryId: 'linear',
        credentialRef: 'access-ref',
        refreshTokenRef: 'refresh-ref',
        [PROVIDER_REVOKED_MARK]: '2026-09-29T22:59:00.000Z',
      },
    });
    const result = await remove(row, deps, revokeGrants);
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: true });
    // The token is already dead at the vendor and the material may be half
    // swept, so a retry neither reads nor re-sends it.
    expect(deps.secrets.get).not.toHaveBeenCalled();
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).toHaveBeenCalledWith('refresh-ref');
    expect(deps.remove).toHaveBeenCalled();
  });

  it('names its own code when the removal fails AFTER the provider revoke took', async () => {
    const { deps, revokeGrants } = recorder({
      secrets: {
        get: jest.fn(async () => 'refresh-token-value'),
        revoke: jest.fn(async () => { throw new Error('secret store unavailable'); }),
      },
    });
    const result = await remove(hostedRow(), deps, revokeGrants);
    // Saying `provider_revoke_failed` here would send the retry back to a
    // vendor call that already happened, on material that may be half gone.
    expect(result).toEqual({
      removed: false,
      code: 'provider_revoked_removal_incomplete',
      message: 'secret store unavailable',
      grantsRevoked: 2,
      revokeAt: PAGE,
      providerRevoked: true,
    });
    expect(deps.markProviderRevoked).toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('an incomplete removal on a page-only entry says the vendor was never told', async () => {
    // The code's name reads as "the provider revoked", and a page-only entry
    // never calls the vendor, so the result has to carry the answer itself.
    const { deps, revokeGrants } = recorder({
      entryFor: jest.fn(() => ({ ...ENTRY, revoke: { page: PAGE } })),
      secrets: {
        get: jest.fn(async () => 'refresh-token-value'),
        revoke: jest.fn(async () => { throw new Error('secret store unavailable'); }),
      },
    });
    const result = await remove(hostedRow(), deps, revokeGrants);
    expect(result).toMatchObject({
      removed: false, code: 'provider_revoked_removal_incomplete', providerRevoked: false,
    });
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
  });

  it('calls the endpoint and returns the page when the entry names both', async () => {
    const { deps, revokeGrants } = recorder();
    const result = await remove(hostedRow(), deps, revokeGrants);
    // Presence of `endpoint` is the whole decision, so naming a page as well
    // does not turn a real revoke into a hand-back.
    expect(deps.revokeAtVendor).toHaveBeenCalled();
    expect(result.revokeAt).toBe(PAGE);
  });

  it("a page-only entry's removal calls no provider and returns the page as revokeAt", async () => {
    const { calls, deps, revokeGrants } = recorder({
      entryFor: jest.fn(() => ({ ...ENTRY, revoke: { page: PAGE } })),
    });
    const result = await remove(hostedRow(), deps, revokeGrants);

    // §10.5: the page is for a person to visit, so removal does not call the
    // vendor at all — and a page that answered our POST with 200 would read as
    // a revoke that never happened.
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: PAGE, providerRevoked: false });
    // The page still does not skip the material and the delete: the token is
    // ours to destroy either way, and leaving it would keep a live credential
    // for an authorization a person may never get round to revoking.
    expect(calls).toEqual(['grants', 'row', 'material:refresh-ref', 'material:access-ref', 'delete']);
  });

  it('refuses without deleting when the entry does not say how to revoke', async () => {
    const { deps, revokeGrants } = recorder({
      entryFor: jest.fn(() => ({ ...ENTRY, revoke: undefined })),
    });
    const result = await remove(hostedRow(), deps, revokeGrants);

    expect(result.removed).toBe(false);
    expect(result.code).toBe('provider_revoke_failed');
    expect(result.message).toMatch(/does not say how to revoke/);
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  // The sweep reads `isActive` to decide whether a row's material is still
  // spoken for, so a removal that cleared it would hand the secret to the sweep
  // before step 4 had spent it. This is a structural arm on the SHIPPED writer:
  // asserting the key set is what makes a later `isActive: false` fail here.
  it('the default row step writes status and revokedAt only', async () => {
    const deps = defaultDeps();
    await deps.markDisconnected('row-1', new Date('2026-09-29T23:00:00.000Z'));
    const [filter, update, options] = Integration.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'row-1' });
    expect(Object.keys(update.$set).sort()).toEqual(['revokedAt', 'status']);
    expect(update.$set.status).toBe('disconnected');
    // F34: the same write fences the writers and answers with the row after it.
    expect(update.$inc).toEqual({ 'config.authGeneration': 1 });
    expect(update.$unset).toEqual({ 'config.pendingAuth': '' });
    expect(options).toEqual({ new: true });
    Integration.findOneAndUpdate.mockClear();
  });

  // F34: a callback or refresh holding the write lease is putting new material
  // behind the refs, and a removal that cannot take its own lease reads,
  // sends and sweeps nothing.
  it('refuses as busy, reading and sending nothing, when it cannot take the removal lease', async () => {
    const { calls, deps, revokeGrants } = recorder({ takeRemovalLease: jest.fn(async () => false) });
    const result = await remove(hostedRow({ config: {
      entryId: 'linear', credentialRef: 'access-ref', refreshTokenRef: 'refresh-ref', authGeneration: 7,
    } }), deps, revokeGrants);
    expect(result).toEqual(expect.objectContaining({ removed: false, code: 'removal_busy', revokeAt: PAGE }));
    expect(calls).toEqual(['grants', 'row']);
    expect(deps.takeRemovalLease).toHaveBeenCalledWith('row-1', 7, expect.any(Date), expect.any(Date));
    expect(deps.releaseRemovalLease).not.toHaveBeenCalled();
  });

  it('releases the lease it took on every exit, success and refusal alike', async () => {
    for (const over of [{}, { revokeAtVendor: jest.fn(async () => { throw new Error('vendor down'); }) }]) {
      const { deps, revokeGrants } = recorder(over);
      await remove(hostedRow(), deps, revokeGrants);
      const until = deps.takeRemovalLease.mock.calls[0][2];
      expect(deps.releaseRemovalLease).toHaveBeenCalledWith('row-1', until);
    }
  });

  it('the default lease is taken only at the fenced generation, past every writer lease plus the overrun', async () => {
    const deps = defaultDeps();
    const now = new Date('2026-09-29T23:00:00.000Z');
    const until = new Date('2026-09-29T23:01:00.000Z');
    await deps.takeRemovalLease('row-1', 4, until, now);
    const [filter, update] = Integration.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe('row-1');
    expect(filter['config.authGeneration']).toBe(4);
    expect(filter.$and).toEqual([
      { $or: [
        { 'config.refreshingUntil': { $exists: false } },
        { 'config.refreshingUntil': null },
        { 'config.refreshingUntil': { $lte: new Date(now.getTime() - WRITER_LEASE_OVERRUN_MS) } },
      ] },
      { $or: [
        { 'config.removingUntil': { $exists: false } },
        { 'config.removingUntil': null },
        { 'config.removingUntil': { $lte: now } },
      ] },
    ]);
    expect(update).toEqual({ $set: { 'config.removingUntil': until } });
    expect(WRITER_LEASE_OVERRUN_MS).toBeGreaterThan(0);
    Integration.findOneAndUpdate.mockClear();
  });

  // F34: the caller's row can predate a reconnect that cleared the mark and put
  // a new token. What the disconnect write answers is what is on the row now.
  it('reads the mark and the refs from its own write, not from the row it was handed', async () => {
    const { deps, revokeGrants } = recorder();
    deps.markDisconnected.mockImplementation(async () => ({
      ...hostedRow({ config: { entryId: 'linear', refreshTokenRef: 'refresh-now' } }),
      status: 'disconnected',
    }));
    const handed = hostedRow({ config: {
      entryId: 'linear', refreshTokenRef: 'refresh-then', [PROVIDER_REVOKED_MARK]: '2026-09-29T22:00:00.000Z',
    } });
    const result = await removeConnection({ connection: handed, removedBy: 'owner-1', revokeGrants, deps });
    expect(deps.secrets.get).toHaveBeenCalledWith('refresh-now');
    expect(deps.revokeAtVendor).toHaveBeenCalledTimes(1);
    expect(deps.secrets.revoke).toHaveBeenCalledWith('refresh-now');
    expect(result).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
  });

  it('a row already gone sends nothing and does not claim the vendor revoked', async () => {
    const { deps, revokeGrants } = recorder();
    deps.markDisconnected.mockImplementation(async () => null);
    const result = await removeConnection({ connection: hostedRow(), removedBy: 'owner-1', revokeGrants, deps });
    expect(deps.secrets.get).not.toHaveBeenCalled();
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ removed: true, providerRevoked: false, revokeAt: PAGE }));
  });

  it('the default mark step writes the mark and nothing else', async () => {
    const deps = defaultDeps();
    await deps.markProviderRevoked('row-1', new Date('2026-09-29T23:00:00.000Z'));
    const [, update] = Integration.updateOne.mock.calls[0];
    expect(Object.keys(update.$set)).toEqual([`config.${PROVIDER_REVOKED_MARK}`]);
    expect(update.$set[`config.${PROVIDER_REVOKED_MARK}`]).toBe('2026-09-29T23:00:00.000Z');
    Integration.updateOne.mockClear();
  });
});

// Ruling 75780: an entry is code, so it can be deleted while rows naming it
// live on. The connect step copies the entry's `page` onto the row for exactly
// that state, and a removal that finds no entry finishes through the copy —
// which is the authority that outlives the entry. A row connected before the
// copy existed has neither, and keeps the refusal.
describe('an Atlassian removal (TASK-339)', () => {
  // Atlassian answers our CIMD client's RFC 7009 revoke with 401. The 10-09 and
  // 10-19 tool captures saw 200 only because they registered a DCR client of
  // their own, and both of those authorizations were still listed on the
  // person's Atlassian apps page on 11-01, so even a 200 here removes nothing a
  // person can see. A removal that waits on this endpoint can never finish.
  const ATLASSIAN_PAGE = 'https://id.atlassian.com/manage-profile/apps';
  const ISSUER = 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3';
  const atlassianVendor = () => jest.fn(async (url) => (
    String(url).includes('/.well-known/')
      ? {
        ok: true,
        status: 200,
        json: async () => ({
          issuer: ISSUER,
          authorization_endpoint: 'https://auth.atlassian.com/authorize',
          token_endpoint: 'https://auth.atlassian.com/oauth/token',
          revocation_endpoint: 'https://auth.atlassian.com/oauth/revoke',
        }),
      }
      : { ok: false, status: 401, json: async () => ({}) }
  ));

  it('finishes here, sends Atlassian nothing, and says the app is still listed there', async () => {
    const fetchImpl = atlassianVendor();
    const { calls, deps, revokeGrants } = recorder({
      // The shipped catalog, not a fixture: the entry is what decides.
      entryFor: defaultDeps().entryFor,
      clientIdFor: () => 'https://api.commonly.me/api/integrations/hosted-mcp/client/atlassian',
      revokeAtVendor: jest.fn((input) => revokeTokenAtVendor(input, fetchImpl)),
    });
    const row = hostedRow({ config: {
      entryId: 'atlassian',
      clientId: 'https://api.commonly.me/api/integrations/hosted-mcp/client/atlassian',
      credentialRef: 'access-ref',
      refreshTokenRef: 'refresh-ref',
    } });

    const result = await remove(row, deps, revokeGrants);

    expect(result).toEqual({
      removed: true, grantsRevoked: 2, revokeAt: ATLASSIAN_PAGE, providerRevoked: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deps.markProviderRevoked).not.toHaveBeenCalled();
    expect(calls).toEqual(['grants', 'row', 'material:refresh-ref', 'material:access-ref', 'delete']);
  });
});

describe('an operator-key removal (TASK-330)', () => {
  // A pasted key has no refresh token and no RFC 7009 client, so removal never
  // sends it anywhere: it ends our grants, deletes the stored key, and points
  // the person at the vendor's key page. The entry here even names an endpoint,
  // so it is the credential mode, not a missing URL, that keeps the vendor out.
  const KEY_PAGE = 'https://latchkey.example/settings/api-keys';
  const KEY_ENTRY = {
    id: 'keyvendor',
    credentialMode: 'operator_key',
    revoke: { page: KEY_PAGE, endpoint: 'https://latchkey.example/oauth/revoke' },
    resource: 'https://latchkey.example/mcp',
  };

  it('never calls the vendor, deletes the stored key, and hands over the key page', async () => {
    const { calls, deps, revokeGrants } = recorder({ entryFor: () => KEY_ENTRY });
    const row = hostedRow({ config: { entryId: 'keyvendor', agentId: 'agent-1', intake: 'operator_key', credentialRef: 'key-ref' } });

    const result = await remove(row, deps, revokeGrants);

    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: KEY_PAGE, providerRevoked: false });
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(deps.secrets.get).not.toHaveBeenCalled();
    expect(deps.secrets.revoke).toHaveBeenCalledWith('key-ref');
    // The refresh slot is swept too and is empty (`connectorSecrets.revoke`
    // returns on a missing ref), as on any row without a refresh token.
    expect(calls).toEqual(['grants', 'row', 'material:undefined', 'material:key-ref', 'delete']);
  });
});

describe('a row whose entry is gone', () => {
  const COPIED_PAGE = 'https://linear.app/settings/security/legacy';

  it('sends nothing, finishes, and hands over the page copied at connect', async () => {
    const { calls, deps, revokeGrants } = recorder({
      entryFor: jest.fn(() => null),
    });
    const row = hostedRow({ config: { ...hostedRow().config, revokePage: COPIED_PAGE } });
    const result = await remove(row, deps, revokeGrants);

    // Nothing is known about where to revoke — the entry named the endpoint —
    // so no vendor call is attempted, and the material still goes: the row and
    // the secret are ours regardless of what the catalogue holds.
    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: COPIED_PAGE, providerRevoked: false });
    expect(calls).toEqual(['grants', 'row', 'material:refresh-ref', 'material:access-ref', 'delete']);
  });

  it("the copy is returned even when the material step fails, so the person still has it", async () => {
    const { deps, revokeGrants } = recorder({
      entryFor: jest.fn(() => null),
    });
    deps.remove = jest.fn(async () => { throw new Error('row delete unavailable'); });
    const row = hostedRow({ config: { ...hostedRow().config, revokePage: COPIED_PAGE } });
    const result = await remove(row, deps, revokeGrants);

    expect(result).toEqual({
      removed: false,
      code: 'provider_revoked_removal_incomplete',
      message: 'row delete unavailable',
      grantsRevoked: 2,
      revokeAt: COPIED_PAGE,
      providerRevoked: false,
    });
  });

  it('with no copy it keeps the refusal, and the row keeps everything', async () => {
    const { deps, revokeGrants } = recorder({ entryFor: jest.fn(() => null) });
    const result = await remove(hostedRow(), deps, revokeGrants);

    expect(result).toMatchObject({ removed: false, code: 'provider_revoke_failed' });
    expect(result.message).toMatch(/names no known entry \(linear\)/);
    expect(deps.secrets.revoke).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('a page the entry still names wins over the copy', async () => {
    const { deps, revokeGrants } = recorder({
      entryFor: jest.fn(() => ({ ...ENTRY, revoke: { page: PAGE } })),
    });
    const row = hostedRow({ config: { ...hostedRow().config, revokePage: COPIED_PAGE } });
    const result = await remove(row, deps, revokeGrants);

    // The entry is the live authority for as long as it exists; the copy is a
    // fallback, not a second opinion. A stale copy that won here would send a
    // person to a page the catalogue has since corrected.
    expect(result.revokeAt).toBe(PAGE);
  });

  it('an endpoint planted on the row is never read', async () => {
    // The entry is the only thing that decides where a token goes, and the copy
    // carries a page — so a row-carried endpoint must not turn a hand-back into
    // a POST at a URL nothing server-owned named. `revokeEndpoint` is not in
    // `SERVER_OWNED_CONFIG_KEYS`, which is the point: a body *could* write it.
    const { deps, revokeGrants } = recorder({ entryFor: jest.fn(() => null) });
    const row = hostedRow({
      config: {
        ...hostedRow().config,
        revokePage: COPIED_PAGE,
        revokeEndpoint: 'https://attacker.example/token',
      },
    });
    const result = await remove(row, deps, revokeGrants);

    expect(deps.revokeAtVendor).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: true, grantsRevoked: 2, revokeAt: COPIED_PAGE, providerRevoked: false });
  });
});

describe('revokeTokenAtVendor (RFC 7009)', () => {
  // TASK-252: every revoke first reads the issuer's RFC 8414 metadata, and the
  // request goes out only when the entry's pinned endpoint is the one the issuer
  // advertises. `vendor` answers that GET and hands every other request to `answer`.
  const metadataFor = (entry, over = {}) => ({
    issuer: entry.issuer,
    authorization_endpoint: `${entry.issuer}/authorize`,
    token_endpoint: `${entry.issuer}/token`,
    revocation_endpoint: entry.revoke.endpoint,
    ...over,
  });
  const vendor = (entry, answer, metadata = metadataFor(entry)) => jest.fn(async (url, init) => (
    String(url).includes('/.well-known/oauth-authorization-server')
      ? { ok: true, status: 200, json: async () => metadata }
      : answer(url, init)
  ));
  const revokeCalls = (fetchImpl) => fetchImpl.mock.calls
    .filter(([url]) => !String(url).includes('/.well-known/'));

  it('marks only the refused DCR client when the vendor returns invalid_client', async () => {
    const registry = require('../../../services/hostedMcpDcrRegistry');
    const refuse = jest.spyOn(registry, 'refuseDcrClient').mockResolvedValue();
    const dcrEntry = { ...ENTRY, client: 'dcr' };
    const fetchImpl = vendor(dcrEntry, async () => ({
      ok: false, status: 401, json: async () => ({ error: 'invalid_client' }),
    }));
    try {
      await expect(revokeTokenAtVendor({
        entry: dcrEntry, clientId: 'retired-client', token: 'held-token',
        tokenTypeHint: 'refresh_token',
      }, fetchImpl)).rejects.toMatchObject({ code: 'invalid_client' });
      expect(refuse).toHaveBeenCalledWith(dcrEntry, 'retired-client');
      expect(new URLSearchParams(revokeCalls(fetchImpl)[0][1].body).get('client_id'))
        .toBe('retired-client');
    } finally {
      refuse.mockRestore();
    }
  });
  it('a post-registered DCR client revokes with post', async () => {
    const dcrEntry = { ...ENTRY, client: 'dcr' };
    const fetchImpl = vendor(dcrEntry, async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await revokeTokenAtVendor({
      entry: dcrEntry,
      clientId: 'conf-1',
      clientSecret: 'registered-secret',
      tokenEndpointAuthMethod: 'client_secret_post',
      token: 'held-token',
      tokenTypeHint: 'refresh_token',
    }, fetchImpl);
    expect(revokeCalls(fetchImpl)).toHaveLength(1);
    const [, init] = revokeCalls(fetchImpl)[0];
    expect(init.headers.Authorization).toBeUndefined();
    const body = new URLSearchParams(init.body);
    expect(body.get('client_id')).toBe('conf-1');
    expect(body.get('client_secret')).toBe('registered-secret');
  });

  const call = (response, metadata = metadataFor(ENTRY)) => {
    const fetchImpl = vendor(ENTRY, async () => response, metadata);
    return {
      fetchImpl,
      run: () => revokeTokenAtVendor({
        entry: ENTRY,
        clientId: 'commonly-client',
        token: 'refresh-token-value',
        tokenTypeHint: 'refresh_token',
      }, fetchImpl),
    };
  };

  it("the provider revoke sends the token to the entry's revocation endpoint", async () => {
    const { fetchImpl, run } = call({ ok: true, status: 200, json: async () => ({}) });
    await run();
    const [url, init] = revokeCalls(fetchImpl)[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body);
    expect(body.get('token')).toBe('refresh-token-value');
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('commonly-client');
  });

  it('a pre-registered client authenticates at token and revocation endpoints, and still sends PKCE', async () => {
    const { buildTokenExchangeRequest } = require('../../../services/hostedMcpIntakeService');
    const staticEntry = {
      ...ENTRY,
      id: 'google-calendar',
      issuer: 'https://accounts.google.test',
      client: 'pre-registered',
      resource: 'https://calendar.google.test/mcp',
      revoke: { page: 'https://accounts.google.test/security', endpoint: 'https://accounts.google.test/revoke' },
    };
    const metadata = {
      issuer: staticEntry.issuer,
      authorization_endpoint: 'https://accounts.google.test/authorize',
      token_endpoint: 'https://accounts.google.test/token',
      revocation_endpoint: 'https://accounts.google.test/revoke',
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
    };
    const client = { clientId: 'registered-client', clientSecret: 'registered-secret' };
    const exchange = buildTokenExchangeRequest(staticEntry, metadata, client, {
      redirectUri: 'https://api.commonly.me/callback',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
    });
    const exchangeBody = exchange.body;
    expect(exchange.headers.Authorization).toBe(`Basic ${Buffer.from('registered-client:registered-secret').toString('base64')}`);
    expect(exchangeBody.get('code_verifier')).toBe('pkce-verifier');
    expect(exchangeBody.get('client_id')).toBeNull();

    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => metadata })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await revokeTokenAtVendor({
      entry: staticEntry,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      token: 'held-refresh-token',
      tokenTypeHint: 'refresh_token',
    }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://accounts.google.test/revoke');
    expect(init.headers.Authorization).toBe(exchange.headers.Authorization);
    const revokeBody = new URLSearchParams(init.body);
    expect(revokeBody.get('token')).toBe('held-refresh-token');
    expect(revokeBody.get('client_id')).toBeNull();
    expect(revokeBody.get('client_secret')).toBeNull();
  });

  // Only a 2xx on a token we HOLD counts as revoked. `invalid_grant` used to be
  // counted, and it is the one answer that must not be: RFC 6749 §5.2 also
  // gives it for a token "issued to another client", and a `cimd` client id is
  // rebuilt from the API host at call time — so after a host move a LIVE token
  // answers `invalid_grant`, and counting it deletes the material and records a
  // revoke that never happened.
  it('does NOT count invalid_grant as revoked', async () => {
    const { run } = call({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
    await expect(run()).rejects.toThrow(/HTTP 400/);
  });

  it('does NOT count an unsupported token type as revoked', async () => {
    const { run } = call({
      ok: false,
      status: 400,
      json: async () => ({ error: 'unsupported_token_type' }),
    });
    await expect(run()).rejects.toThrow(/HTTP 400/);
  });

  it('does not count a malformed request of ours as revoked', async () => {
    const { run } = call({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_request' }),
    });
    await expect(run()).rejects.toThrow(/HTTP 400/);
  });

  it('refuses a server error rather than reporting a revoke', async () => {
    const { run } = call({ ok: false, status: 502, json: async () => ({}) });
    await expect(run()).rejects.toThrow(/HTTP 502/);
  });

  it('sends nothing when the issuer advertises a different revocation endpoint than the entry pins', async () => {
    const { fetchImpl, run } = call(
      { ok: true, status: 200, json: async () => ({}) },
      metadataFor(ENTRY, { revocation_endpoint: 'https://mcp.linear.app/oauth/revoke' }),
    );
    await expect(run()).rejects.toThrow(/not the revocation_endpoint .* advertises/);
    expect(revokeCalls(fetchImpl)).toHaveLength(0);
  });

  it('sends nothing when the issuer advertises no revocation endpoint at all', async () => {
    const metadata = metadataFor(ENTRY);
    delete metadata.revocation_endpoint;
    const { fetchImpl, run } = call({ ok: true, status: 200, json: async () => ({}) }, metadata);
    await expect(run()).rejects.toThrow(/not the revocation_endpoint/);
    expect(revokeCalls(fetchImpl)).toHaveLength(0);
  });

  it('sends nothing when the metadata is written for another issuer', async () => {
    const { fetchImpl, run } = call(
      { ok: true, status: 200, json: async () => ({}) },
      metadataFor(ENTRY, { issuer: 'https://elsewhere.example' }),
    );
    await expect(run()).rejects.toMatchObject({ code: 'issuer_mismatch' });
    expect(revokeCalls(fetchImpl)).toHaveLength(0);
  });

  it('refuses an entry that names no endpoint rather than guessing from the page', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(revokeTokenAtVendor({
      entry: { ...ENTRY, revoke: { page: PAGE } },
      clientId: 'commonly-client',
      token: 'refresh-token-value',
      tokenTypeHint: 'refresh_token',
    }, fetchImpl)).rejects.toThrow(/names no RFC 7009 endpoint/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an empty token rather than sending one', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(revokeTokenAtVendor({
      entry: ENTRY,
      clientId: 'commonly-client',
      token: '',
      tokenTypeHint: 'refresh_token',
    }, fetchImpl)).rejects.toThrow(/no token to revoke/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
