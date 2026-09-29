/**
 * `credentialFor` — TASK-172 scope §10.3's refresh fence.
 *
 * Everything is injected, so these arms run without a database. The harness is a
 * SIMULATION of the two stores, and that is deliberately not what the write's
 * correctness is asserted against: a mock records what it was handed, not what
 * the schema kept. The paths the winner's commit names are checked against the
 * real `Integration` schema instead (see the schema-declaredness arm).
 *
 * The harness also models `connectorSecrets.put`'s real semantics — an upsert on
 * `(integrationId, kind)`, so the ref for a kind is STABLE across puts — because
 * that is what makes the loser's detection observable. `newRefPerPut` models the
 * other world so the difference shows up in an arm rather than in a comment.
 */

const {
  credentialFor,
  HostedMcpCredentialError,
  EXPIRY_SKEW_MS,
  WINNER_WAIT_MS,
} = require('../../../services/hostedMcpCredentialService');
const { undeclaredPaths } = require('../../utils/schemaPathGuard');

const DeployedIntegration = jest.requireActual('../../../models/Integration').default;

const T0 = new Date('2026-09-28T12:00:00.000Z').getTime();
const ROW_ID = '68e1f2a4b5c6d7e8f9a0b1c2';

const ENTRY = {
  id: 'linear',
  issuer: 'https://mcp.linear.app',
  clientId: 'https://commonly.me/connect/hosted-mcp/linear/client-metadata',
};

const ACCESS_REF = 'ref-access';
const REFRESH_REF = 'ref-refresh';
const ACCESS_KIND = 'hosted-mcp-access-token';
const REFRESH_KIND = 'hosted-mcp-refresh-token';
const REF_FOR_KIND = { [ACCESS_KIND]: ACCESS_REF, [REFRESH_KIND]: REFRESH_REF };

/** A connected hosted-MCP row, with the credential half overridable. */
const hostedRow = (config = {}, top = {}) => ({
  _id: ROW_ID,
  type: 'hosted-mcp',
  status: 'connected',
  revokedAt: null,
  ...top,
  config: {
    entryId: ENTRY.id,
    credentialRef: ACCESS_REF,
    refreshTokenRef: REFRESH_REF,
    refreshGeneration: 3,
    ...config,
  },
});

const stale = (config = {}, top = {}) => hostedRow({ expiresAt: new Date(T0 - 1000), ...config }, top);
const live = (config = {}, top = {}) => hostedRow({ expiresAt: new Date(T0 + 3600 * 1000), ...config }, top);

const harness = (options = {}) => {
  const order = [];
  const sleeps = [];
  const reads = [];
  const secrets = new Map([[ACCESS_REF, 'old-access'], [REFRESH_REF, 'old-refresh']]);
  let state = options.row || stale();
  let nowMs = T0;

  const put = jest.fn(async (integrationId, spec, material) => {
    // `connectorSecrets.put` refuses empty material rather than storing it, so a
    // caller that puts a token it never received fails here instead of silently
    // keeping the old secret.
    if (!material) throw new Error('empty material');
    // Upsert on (integrationId, kind): the same kind keeps its ref. Under
    // `newRefPerPut` the ref moves, which is the world the loser's ref-diffing
    // detection assumed and the one production is not in.
    const ref = options.newRefPerPut ? `${spec.kind}-new-ref` : REF_FOR_KIND[spec.kind];
    secrets.set(ref, material);
    order.push(`put:${spec.kind}`);
    return ref;
  });

  const revoke = jest.fn(async (ref) => {
    if (!ref) return;
    secrets.delete(ref);
    order.push(`revoke:${ref}`);
  });

  const bumpGeneration = jest.fn(async (id, from) => {
    if (options.loseRace) return null;
    if ((state.config.refreshGeneration ?? 0) !== from) return null;
    const preImage = state;
    state = { ...state, config: { ...state.config, refreshGeneration: from + 1 } };
    order.push('bump');
    return preImage;
  });

  const commit = jest.fn(async (id, generation, fields) => {
    order.push('commit');
    if ((state.config.refreshGeneration ?? 0) !== generation) return;
    const next = { ...state, config: { ...state.config } };
    Object.entries(fields).forEach(([path, value]) => {
      if (path.startsWith('config.')) next.config[path.slice('config.'.length)] = value;
      else next[path] = value;
    });
    state = next;
  });

  const markError = jest.fn(async (id, generation, message) => {
    order.push('markError');
    if ((state.config.refreshGeneration ?? 0) !== generation) return;
    state = { ...state, status: 'error', errorMessage: message };
  });

  const findById = jest.fn(async () => {
    reads.push(state);
    if (options.onRead) return options.onRead(reads.length, secrets, state);
    return state;
  });

  const refreshAtVendor = jest.fn(async () => {
    order.push('refresh');
    if (options.refreshError) throw options.refreshError;
    return options.refreshResult || { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 };
  });

  return {
    order,
    sleeps,
    reads,
    secrets,
    put,
    revoke,
    bumpGeneration,
    commit,
    markError,
    findById,
    refreshAtVendor,
    state: () => state,
    deps: {
      now: () => new Date(nowMs),
      entryFor: options.entryFor || (() => ENTRY),
      clientIdFor: () => ENTRY.clientId,
      refreshAtVendor,
      secrets: {
        get: async (ref) => {
          if (!secrets.has(ref)) throw new Error(`no such secret: ${ref}`);
          return secrets.get(ref);
        },
        put,
        revoke,
      },
      row: {
        findById,
        bumpGeneration,
        commit,
        markError,
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    },
  };
};

/** The refusal, or a failure that says the call succeeded when an arm expected otherwise. */
const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HostedMcpCredentialError)) throw error;
    return error;
  }
  throw new Error('expected a refusal, got a credential');
};

describe('the fast path', () => {
  test('a live credential is served from the store without entering the fence', async () => {
    const h = harness({ row: live() });
    const got = await credentialFor(live(), h.deps);

    expect(got).toEqual({
      token: 'old-access',
      expiresAt: new Date(T0 + 3600 * 1000).toISOString(),
    });
    expect(h.bumpGeneration).not.toHaveBeenCalled();
    expect(h.refreshAtVendor).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
  });

  test('freshness is exclusive at the skew boundary, and a token inside the window is fenced', async () => {
    // Literal times, not EXPIRY_SKEW_MS: a fixture built from the constant under
    // test moves its own boundary with the mutant, so a margin of zero would pass
    // an arm written to witness it. The literals are the contract (one minute),
    // asserted as a value rather than referenced.
    expect(EXPIRY_SKEW_MS).toBe(60 * 1000);

    const exactly = harness({ row: stale({ expiresAt: new Date(T0 + 60 * 1000) }) });
    await credentialFor(stale({ expiresAt: new Date(T0 + 60 * 1000) }), exactly.deps);
    expect(exactly.bumpGeneration).toHaveBeenCalledTimes(1);

    // Half a window in is still inside it: a token with 30s left is not usable
    // for a call that may take longer, which is the whole reason the margin
    // exists rather than a `> now` comparison.
    const withinWindow = harness({ row: stale({ expiresAt: new Date(T0 + 30 * 1000) }) });
    await credentialFor(stale({ expiresAt: new Date(T0 + 30 * 1000) }), withinWindow.deps);
    expect(withinWindow.bumpGeneration).toHaveBeenCalledTimes(1);

    const inside = harness({ row: stale({ expiresAt: new Date(T0 + 60 * 1000 + 1) }) });
    const got = await credentialFor(stale({ expiresAt: new Date(T0 + 60 * 1000 + 1) }), inside.deps);
    expect(got.token).toBe('old-access');
    expect(inside.bumpGeneration).not.toHaveBeenCalled();
  });

  test('a row holding no credential ref never takes the fast path', async () => {
    const row = stale({ credentialRef: undefined });
    const h = harness({ row });
    await credentialFor(row, h.deps);
    expect(h.bumpGeneration).toHaveBeenCalledTimes(1);
    expect(h.refreshAtVendor).toHaveBeenCalledTimes(1);
  });
});

describe('the gates before any refresh', () => {
  test('a removed connection is refused as a mismatch, and the same row without removedAt is served', async () => {
    const removed = hostedRow({ expiresAt: new Date(T0 - 1000) }, { revokedAt: new Date(T0) });
    const h = harness({ row: removed });
    const error = await refusal(credentialFor(removed, h.deps));
    expect(error.code).toBe('connection_mismatch');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('connection was removed');
    expect(h.bumpGeneration).not.toHaveBeenCalled();

    const control = harness({ row: stale() });
    await expect(credentialFor(stale(), control.deps)).resolves.toMatchObject({ token: 'new-access' });
  });

  test('a row the vendor ended is refused, and the same row while connected is refreshed', async () => {
    const errored = stale({}, { status: 'error' });
    const h = harness({ row: errored });
    const error = await refusal(credentialFor(errored, h.deps));
    expect(error.code).toBe('connection_mismatch');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('connection is not connected (error)');
    expect(h.bumpGeneration).not.toHaveBeenCalled();

    const control = harness({ row: stale() });
    await expect(credentialFor(stale(), control.deps)).resolves.toMatchObject({ token: 'new-access' });
  });

  test('a row with no status is refused, and the message names the unknown rather than a verdict', async () => {
    const unknown = stale({}, { status: undefined });
    const error = await refusal(credentialFor(unknown, harness({ row: unknown }).deps));
    expect(error.message).toBe('connection is not connected (unknown)');
  });

  test('a row with no _id cannot be fenced and is refused before anything is bumped', async () => {
    const noId = stale({}, { _id: undefined });
    const h = harness({ row: noId });
    const error = await refusal(credentialFor(noId, h.deps));
    expect(error.code).toBe('connection_mismatch');
    expect(error.message).toBe('connection row has no _id');
    expect(h.bumpGeneration).not.toHaveBeenCalled();
  });

  test('an entry id the catalogue does not carry is refused, and a resolvable entry is not', async () => {
    // The real lookup, against the shipped catalogue: no vendor is listed in v1,
    // so an id copied from a row resolves to nothing and must refuse rather than
    // refresh against a guessed authorization server.
    const row = stale();
    const withRealLookup = harness({ row, entryFor: undefined });
    delete withRealLookup.deps.entryFor;
    const error = await refusal(credentialFor(row, withRealLookup.deps));
    expect(error.code).toBe('connection_mismatch');
    expect(error.message).toBe(`hosted-mcp row names no known entry (${ENTRY.id})`);

    const control = harness({ row });
    await expect(credentialFor(row, control.deps)).resolves.toMatchObject({ token: 'new-access' });
  });
});

describe('the winner of the fence', () => {
  test('a rotating vendor commits both halves under the generation it bumped', async () => {
    const h = harness({ row: stale() });
    const got = await credentialFor(stale(), h.deps);

    expect(got).toEqual({
      token: 'new-access',
      expiresAt: new Date(T0 + 3600 * 1000).toISOString(),
    });
    expect(h.bumpGeneration).toHaveBeenCalledWith(ROW_ID, 3);
    expect(h.refreshAtVendor).toHaveBeenCalledWith({
      entry: ENTRY,
      clientId: ENTRY.clientId,
      refreshToken: 'old-refresh',
    });
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledWith(ROW_ID, 4, {
      'config.credentialRef': ACCESS_REF,
      'config.refreshTokenRef': REFRESH_REF,
      'config.expiresAt': new Date(T0 + 3600 * 1000),
      errorMessage: null,
    });
    expect(h.state().config.expiresAt).toEqual(new Date(T0 + 3600 * 1000));
    expect(h.state().errorMessage).toBeNull();
  });

  test('every path the commit names is declared on the schema, and the error text is top-level', async () => {
    const h = harness({ row: stale() });
    await credentialFor(stale(), h.deps);

    const fields = h.commit.mock.calls[0][2];
    expect(undeclaredPaths(DeployedIntegration.schema, Object.keys(fields))).toEqual([]);
    expect(Object.keys(fields)).toContain('errorMessage');
    // The strict subdocument has no `errorMessage` leaf, so `config.errorMessage`
    // would be a write that reports success and keeps nothing.
    expect(Object.keys(fields)).not.toContain('config.errorMessage');
  });

  test('a vendor that does not rotate keeps the refresh ref and revokes nothing', async () => {
    const h = harness({
      row: stale(),
      refreshResult: { accessToken: 'new-access', expiresIn: 3600 },
    });
    const got = await credentialFor(stale(), h.deps);

    expect(got.token).toBe('new-access');
    expect(h.put).toHaveBeenCalledTimes(1);
    expect(h.put.mock.calls[0][1].kind).toBe(ACCESS_KIND);
    expect(h.commit.mock.calls[0][2]['config.refreshTokenRef']).toBe(REFRESH_REF);
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.secrets.get(REFRESH_REF)).toBe('old-refresh');
  });

  test('a retired credential is revoked only after the row points at the new one', async () => {
    const h = harness({ row: stale(), newRefPerPut: true });
    await credentialFor(stale(), h.deps);

    expect(h.commit.mock.calls[0][2]['config.credentialRef']).not.toBe(ACCESS_REF);
    expect(h.order.indexOf('commit')).toBeLessThan(h.order.indexOf(`revoke:${ACCESS_REF}`));
    expect(h.order.indexOf('commit')).toBeLessThan(h.order.indexOf(`revoke:${REFRESH_REF}`));
  });

  test('with the refs the store actually hands back, the old pair is not revoked at all', async () => {
    // `connectorSecrets.put` upserts on (integrationId, kind), so both refs come
    // back unchanged: revoking them would delete the secrets just written.
    const h = harness({ row: stale() });
    await credentialFor(stale(), h.deps);

    expect(h.commit.mock.calls[0][2]['config.credentialRef']).toBe(ACCESS_REF);
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.secrets.get(ACCESS_REF)).toBe('new-access');
    expect(h.secrets.get(REFRESH_REF)).toBe('new-refresh');
  });

  test('a vendor that omits expires_in commits no lifetime rather than a guessed one', async () => {
    const h = harness({ row: stale(), refreshResult: { accessToken: 'new-access' } });
    const got = await credentialFor(stale(), h.deps);

    expect(h.commit.mock.calls[0][2]['config.expiresAt']).toBeNull();
    expect(h.state().config.expiresAt).toBeNull();
    expect(got.expiresAt).toBe('');
  });

  test('a definitive refusal marks the row error and commits nothing', async () => {
    const h = harness({
      row: stale(),
      refreshError: new HostedMcpCredentialError('connection_error', 'refresh refused (400 invalid_grant)'),
    });
    const error = await refusal(credentialFor(stale(), h.deps));

    expect(error.code).toBe('connection_error');
    expect(error.retryable).toBe(false);
    expect(h.markError).toHaveBeenCalledWith(ROW_ID, 4, 'refresh refused (400 invalid_grant)');
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.state().status).toBe('error');
  });

  test('a vendor having a bad moment is retryable and does not mark the connection', async () => {
    const h = harness({
      row: stale(),
      refreshError: new HostedMcpCredentialError('refresh_unreachable', 'refresh refused (500)', true),
    });
    const error = await refusal(credentialFor(stale(), h.deps));

    expect(error.code).toBe('refresh_unreachable');
    expect(error.retryable).toBe(true);
    expect(h.markError).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.state().status).toBe('connected');
  });

  test('a transport failure is wrapped as retryable and does not mark the connection', async () => {
    const h = harness({ row: stale(), refreshError: new Error('fetch failed') });
    const error = await refusal(credentialFor(stale(), h.deps));

    expect(error.code).toBe('refresh_unreachable');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('fetch failed');
    expect(h.markError).not.toHaveBeenCalled();
  });

  test('a connection holding no refresh token goes to error, because only a reconsent can restore it', async () => {
    const row = stale({ refreshTokenRef: undefined });
    const h = harness({ row });
    const error = await refusal(credentialFor(row, h.deps));

    expect(error.code).toBe('credential_missing');
    expect(error.retryable).toBe(false);
    // Scope §4: the row goes to `error` with "reconnect". Without the mark it
    // reads `connected` on the page while every call fails, and the member is
    // never told what would fix it. The mark is guarded on the generation the
    // winner bumped, so a concurrent loser cannot overwrite a newer verdict.
    expect(h.markError).toHaveBeenCalledTimes(1);
    expect(h.markError).toHaveBeenCalledWith(row._id, 4, expect.stringContaining('reconnect'));
    expect(h.bumpGeneration).toHaveBeenCalledTimes(1);
    expect(h.refreshAtVendor).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });
});

describe('the loser of the fence', () => {
  test('serves the winner credential when the store kept the ref and only the secret moved', async () => {
    // The production shape: `put` overwrites the same secret document, so the
    // ref does not change. The only thing that distinguishes the winner's write
    // from the state the loser is holding is that the row's credential is fresh.
    const winner = live();
    const h = harness({
      loseRace: true,
      onRead: (readCount, secrets) => {
        if (readCount < 2) return stale();
        secrets.set(ACCESS_REF, 'winner-access');
        return winner;
      },
    });

    const got = await credentialFor(stale(), h.deps);

    expect(got).toEqual({
      token: 'winner-access',
      expiresAt: new Date(T0 + 3600 * 1000).toISOString(),
    });
    expect(h.refreshAtVendor).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  test('serves the winner credential when the winner moved the ref', async () => {
    const h = harness({
      loseRace: true,
      onRead: (readCount, secrets) => {
        if (readCount < 2) return stale();
        secrets.set('ref-access-winner', 'winner-access');
        return stale({ credentialRef: 'ref-access-winner', expiresAt: new Date(T0 + 3600 * 1000) });
      },
    });

    await expect(credentialFor(stale(), h.deps)).resolves.toMatchObject({ token: 'winner-access' });
  });

  test('reports credential_refreshing when the winner never commits, and harms nothing', async () => {
    const h = harness({ loseRace: true });
    const error = await refusal(credentialFor(stale(), h.deps));

    expect(error.code).toBe('credential_refreshing');
    expect(error.retryable).toBe(true);
    // Literal bound, for the same reason as the skew margin: an expectation
    // written as WINNER_WAIT_MS / WINNER_POLL_MS moves with any mutant of either,
    // so the wait is asserted as 15 polls of 100ms totalling 1500ms.
    expect(h.sleeps.reduce((total, ms) => total + ms, 0)).toBe(1500);
    expect(h.sleeps).toHaveLength(15);
    expect(h.sleeps.every((ms) => ms === 100)).toBe(true);
    expect(h.reads.length).toBe(h.sleeps.length + 1);
    expect(h.bumpGeneration).toHaveBeenCalledTimes(1);
    expect(h.refreshAtVendor).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.markError).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.secrets.get(ACCESS_REF)).toBe('old-access');
    expect(h.state().status).toBe('connected');
  });

  test('does not serve a credential the winner has not committed yet', async () => {
    // `put` lands before the commit, so the store may already hold a new secret
    // under the old ref while the row still carries the old expiry. Serving that
    // pair would hand the caller a credential it would immediately discard.
    const h = harness({
      loseRace: true,
      onRead: (readCount, secrets) => {
        secrets.set(ACCESS_REF, 'winner-access');
        return stale();
      },
    });
    const error = await refusal(credentialFor(stale(), h.deps));

    expect(error.code).toBe('credential_refreshing');
    expect(h.reads.length).toBeGreaterThan(1);
  });

  test('refuses as a mismatch when the connection is removed while waiting', async () => {
    const h = harness({
      loseRace: true,
      onRead: (readCount) => (readCount < 2 ? stale() : null),
    });
    const error = await refusal(credentialFor(stale(), h.deps));

    expect(error.code).toBe('connection_mismatch');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('connection was removed');
  });

  test('refuses as a mismatch when the winner marked the connection error', async () => {
    const h = harness({
      loseRace: true,
      onRead: (readCount) => (readCount < 2 ? stale() : stale({}, { status: 'error' })),
    });
    const error = await refusal(credentialFor(stale(), h.deps));

    expect(error.code).toBe('connection_mismatch');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('connection is not connected (error)');
  });
});
