// TASK-172 slice 3: what the callback leaves ON THE ROW, witnessed against the
// real `Integration` schema on a real mongod.
//
// The mocked sibling (`hostedMcpConnect.callback.test.js`) can only assert the
// `$set` payload it is handed, and a payload arm cannot see the class of bug
// this file exists for: `config` is a STRICT subdocument, and a `$set` whose
// value is `undefined` is a NO-OP — the field keeps whatever it held. Measured
// on a real mongod 2026-09-29 (`$set {'config.providerSubject': undefined}`
// leaves 'acct-old'; `null` clears it). So a payload arm reading
// `providerSubject: undefined` looks exactly as green whether the write clears
// the field or does nothing at all, which is how a stale subject survived here.
// TASK-253: production vendor requests go through the outbound guard
// (services/hostedVendorFetch). These arms stub the vendor at global.fetch, so
// the guarded transport is mapped back to it, read at call time; the guard's
// own rules are tested in outboundUrlGuard.vendorEndpoint.test.js.
jest.mock('../../../services/hostedVendorFetch', () => ({
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  hostedVendorFetch: (...args) => global.fetch(...args),
}));

const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const FIXTURE_ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  // Both keys on purpose: the callback copies the `page` and must NOT copy the
  // `endpoint`, and a fixture carrying only a page cannot tell those apart.
  revoke: {
    page: 'https://linear.app/settings/security',
    endpoint: 'https://mcp.linear.app/token/does-not-exist',
  },
  tools: [],
};

jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return {
    HOSTED_MCP_ENTRIES: [FIXTURE_ENTRY],
    findHostedMcpEntry: actual.findHostedMcpEntry,
    // Read by the callback when it copies the entry's page onto the row.
    hostedMcpRevokeTarget: actual.hostedMcpRevokeTarget,
  };
});

jest.mock('../../../services/hostedMcpIntakeService', () => {
  const actual = jest.requireActual('../../../services/hostedMcpIntakeService');
  return { ...actual, discoverAuthorizationServer: jest.fn() };
});

let mockAuthedUserId = 'user-1';
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: mockAuthedUserId };
  next();
});

jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

// Secret storage and grant revocation are not this file's claim; the ROW is.
jest.mock('../../../services/connectorSecrets', () => ({ put: jest.fn(), get: jest.fn(), revoke: jest.fn() }));
jest.mock('../../../services/roomGrantService', () => ({ revokeConnectionGrants: jest.fn() }));

const connectorSecrets = require('../../../services/connectorSecrets');
const { revokeConnectionGrants } = require('../../../services/roomGrantService');
const intake = require('../../../services/hostedMcpIntakeService');

const TOKEN_ENDPOINT = 'https://mcp.linear.app/token';
const idToken = (sub) => [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub })).toString('base64url'),
  'sig',
].join('.');

let mongod;
let Integration;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  Integration = require('../../../models/Integration').default;
  // The stale-write fence relies on this unique index rejecting a second
  // (integrationId, kind) row. Model loading starts index creation asynchronously;
  // await it before racing real secret upserts, or CI can observe duplicate rows
  // and reach the later state/lease fence instead of ConnectorSecretStaleWrite.
  await require('../../../models/ConnectorSecret').init();
  app = express();
  app.use('/connect/hosted-mcp', require('../../../routes/hostedMcpConnect'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

/** A pending row for `state`, as the start route would have left it. */
const seedPending = async ({ state, subject, credentialRef = 'ref-old' }) => {
  const createdBy = new mongoose.Types.ObjectId();
  mockAuthedUserId = String(createdBy);
  const row = await Integration.create({
    type: 'hosted-mcp',
    podId: new mongoose.Types.ObjectId(),
    createdBy,
    status: 'pending',
    config: {
      entryId: 'linear',
      credentialRef,
      providerSubject: subject,
      pendingAuth: {
        state,
        codeVerifier: 'verifier-1',
        expiresAt: new Date(Date.now() + 60 * 1000),
        browserNonce: BROWSER_NONCE,
      },
    },
  });
  return String(row._id);
};

const exchange = ({ idToken: token } = {}) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'read',
      ...(token ? { id_token: token } : {}),
    }),
  });
};

const BROWSER_NONCE = 'browser-1';
const BROWSER_COOKIE = `commonly_hosted_mcp_nonce=${BROWSER_NONCE}`;

const callback = (state, cookie = BROWSER_COOKIE) => {
  const sent = request(app).get(`/connect/hosted-mcp/linear/callback?state=${state}&code=code-1`);
  return cookie === null ? sent : sent.set('Cookie', cookie);
};
const stored = async (id) => (await Integration.findById(id).lean()).config;

const outcome = (res) => {
  const url = new URL(res.headers.location, 'https://commonly.me');
  return { hostedMcp: url.searchParams.get('hostedMcp'), code: url.searchParams.get('code') };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthedUserId = 'user-1';
  intake.discoverAuthorizationServer.mockResolvedValue({
    issuer: 'https://mcp.linear.app',
    authorization_endpoint: 'https://mcp.linear.app/authorize',
    token_endpoint: TOKEN_ENDPOINT,
  });
  connectorSecrets.put.mockResolvedValue('ref-new');
});

test('a browser that did not start the flow is refused, and the flow survives it', async () => {
  const id = await seedPending({ state: 'st-other', subject: 'acct-old' });
  exchange();

  const refused = await callback('st-other', 'commonly_hosted_mcp_nonce=browser-2');
  expect(refused.status).toBe(302);
  expect(outcome(refused).code).toBe('browser_mismatch');
  // The STORE is the witness, and it is the claim that matters: the wrong
  // browser consumed nothing, exchanged nothing, and the person whose flow it
  // is can still finish it.
  expect((await stored(id)).pendingAuth.state).toBe('st-other');
  expect(connectorSecrets.put).not.toHaveBeenCalled();

  // Positive control from the same seed: the browser that started it gets
  // through, and the consumption is real.
  expect((await callback('st-other')).status).toBe(302);
  expect((await stored(id)).pendingAuth).toBeUndefined();
  // Two puts — access and refresh — because the control reached the exchange
  // the refusal never touched. (Its subject is cleared by the exchange itself:
  // no ID token was issued, which is the neighbouring test's claim.)
  expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
});

test('a secret-store failure after exchange ends the real pending row and redirects', async () => {
  const id = await seedPending({ state: 'st-secret-fail' });
  exchange();
  connectorSecrets.put.mockRejectedValueOnce(new Error('secret store failed: access-1'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await callback('st-secret-fail');
    expect(res.status).toBe(302);
    expect(outcome(res)).toEqual({ hostedMcp: 'error', code: 'connector_unavailable' });
    const row = await Integration.findById(id).lean();
    expect(row.status).toBe('error');
    expect(row.config.pendingAuth).toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain('access-1');
  } finally {
    log.mockRestore();
  }
});

test('a failed older callback leaves a newer start flow available', async () => {
  const id = await seedPending({ state: 'st-older' });
  exchange();
  let rejectStore;
  connectorSecrets.put.mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectStore = reject;
  }));
  const olderCallback = callback('st-older').then((result) => result);
  for (let attempt = 0; attempt < 30 && !rejectStore; attempt += 1) {
    // Wait for the actual callback route to finish its exchange and reach put.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(rejectStore).toBeDefined();

  const newerStart = await request(app).post('/connect/hosted-mcp/linear/start');
  expect(newerStart.status).toBe(200);
  const newerState = new URL(newerStart.body.authorizeUrl).searchParams.get('state');
  expect(newerState).toBeTruthy();
  expect((await stored(id)).pendingAuth.state).toBe(newerState);

  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    rejectStore(new Error('store failed'));
    const olderResult = await olderCallback;
    expect(outcome(olderResult)).toEqual({ hostedMcp: 'error', code: 'connector_unavailable' });
    const row = await Integration.findById(id).lean();
    expect(row.status).toBe('error');
    expect(row.config.pendingAuth.state).toBe(newerState);
  } finally {
    log.mockRestore();
  }
});

test('a failed refresh write retires a connected row with a partially replaced secret pair', async () => {
  const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
  const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `test:${Buffer.alloc(32, 7).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'test';
  const actualSecrets = jest.requireActual('../../../services/connectorSecrets');
  const { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } = require('../../../services/connectorSecretKinds');
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const id = await seedPending({ state: 'st-pair', subject: 'acct-same' });
    const accessRef = await actualSecrets.put(id, HOSTED_MCP_ACCESS_TOKEN, 'old-access');
    const refreshRef = await actualSecrets.put(id, HOSTED_MCP_REFRESH_TOKEN, 'old-refresh');
    await Integration.updateOne({ _id: id }, {
      $set: { status: 'connected', 'config.credentialRef': accessRef, 'config.refreshTokenRef': refreshRef },
    });
    exchange({ idToken: idToken('acct-same') });
    connectorSecrets.put.mockImplementation(async (integrationId, kind, material) => {
      if (kind.kind === 'hosted-mcp-refresh-token') return Promise.reject(new Error('refresh store failed'));
      expect((await Integration.findById(id).lean()).status).toBe('error');
      return actualSecrets.put(integrationId, kind, material);
    });

    const res = await callback('st-pair');
    expect(outcome(res)).toEqual({ hostedMcp: 'error', code: 'connector_unavailable' });
    const row = await Integration.findById(id).lean();
    expect(await actualSecrets.get(accessRef)).toBe('access-1');
    expect(await actualSecrets.get(refreshRef)).toBe('old-refresh');
    expect(row.status).toBe('error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('refresh store failed');
  } finally {
    log.mockRestore();
    if (originalKeys === undefined) delete process.env.CONNECTOR_SECRET_KEYS;
    else process.env.CONNECTOR_SECRET_KEYS = originalKeys;
    if (originalActiveKey === undefined) delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    else process.env.CONNECTOR_SECRET_ACTIVE_KEY = originalActiveKey;
  }
});

test('an older callback cannot replace a newer completed connection secret pair', async () => {
  const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
  const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `test:${Buffer.alloc(32, 7).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'test';
  const actualSecrets = jest.requireActual('../../../services/connectorSecrets');
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  let releaseOlder;
  try {
    const id = await seedPending({ state: 'st-race-older', credentialRef: undefined });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'access-A', refresh_token: 'refresh-A', scope: 'read' }),
    });
    let enteredOlderWrite;
    const olderAtWrite = new Promise((resolve) => { enteredOlderWrite = resolve; });
    connectorSecrets.put.mockImplementation(async (integrationId, kind, material, generation) => {
      if (material === 'access-A') {
        enteredOlderWrite();
        await new Promise((resolve) => { releaseOlder = resolve; });
      }
      return actualSecrets.put(integrationId, kind, material, generation);
    });

    const olderCallback = callback('st-race-older');
    let waitTimeout;
    let first;
    try {
      first = await Promise.race([
        olderAtWrite,
        olderCallback.then((result) => ({ earlyOutcome: outcome(result) })),
        new Promise((_, reject) => {
          waitTimeout = setTimeout(() => reject(new Error('older callback did not reach secret storage')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(waitTimeout);
    }
    expect(first).toBeUndefined();
    const newerStart = await request(app).post('/connect/hosted-mcp/linear/start');
    expect(newerStart.status).toBe(200);
    const newerState = new URL(newerStart.body.authorizeUrl).searchParams.get('state');
    const newerCookie = newerStart.headers['set-cookie'][0].split(';')[0];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'access-B', refresh_token: 'refresh-B', scope: 'read' }),
    });
    expect(outcome(await callback(newerState, newerCookie))).toEqual({ hostedMcp: 'connected', code: null });
    const before = await Integration.findById(id).lean();
    expect(await actualSecrets.get(before.config.credentialRef)).toBe('access-B');
    expect(await actualSecrets.get(before.config.refreshTokenRef)).toBe('refresh-B');

    releaseOlder();
    expect(outcome(await olderCallback)).toEqual({ hostedMcp: 'error', code: 'connector_unavailable' });
    const after = await Integration.findById(id).lean();
    expect(after.status).toBe('connected');
    expect(await actualSecrets.get(after.config.credentialRef)).toBe('access-B');
    expect(await actualSecrets.get(after.config.refreshTokenRef)).toBe('refresh-B');
  } finally {
    releaseOlder?.();
    log.mockRestore();
    if (originalKeys === undefined) delete process.env.CONNECTOR_SECRET_KEYS;
    else process.env.CONNECTOR_SECRET_KEYS = originalKeys;
    if (originalActiveKey === undefined) delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    else process.env.CONNECTOR_SECRET_ACTIVE_KEY = originalActiveKey;
  }
});

test('an in-flight refresh cannot overwrite a newer completed authorization', async () => {
  const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
  const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `test:${Buffer.alloc(32, 7).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'test';
  const actualSecrets = jest.requireActual('../../../services/connectorSecrets');
  const { credentialFor } = require('../../../services/hostedMcpCredentialService');
  const { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } = require('../../../services/connectorSecretKinds');
  let releaseRefresh;
  try {
    const id = await seedPending({ state: 'st-refresh-race', subject: 'acct-same', credentialRef: undefined });
    const accessRef = await actualSecrets.put(id, HOSTED_MCP_ACCESS_TOKEN, 'old-access', 1);
    const refreshRef = await actualSecrets.put(id, HOSTED_MCP_REFRESH_TOKEN, 'old-refresh', 1);
    await Integration.updateOne({ _id: id }, {
      $set: {
        status: 'connected',
        'config.authGeneration': 1,
        'config.refreshGeneration': 3,
        'config.credentialRef': accessRef,
        'config.refreshTokenRef': refreshRef,
        'config.clientId': 'client-id',
        'config.expiresAt': new Date(Date.now() - 3600 * 1000),
      },
      $unset: { 'config.pendingAuth': 1 },
    });
    const row = await Integration.findById(id).lean();
    let atRefreshWrite;
    const refreshAtWrite = new Promise((resolve) => { atRefreshWrite = resolve; });
    const refreshing = credentialFor(row, {
      entryFor: () => FIXTURE_ENTRY,
      clientIdFor: () => 'client-id',
      refreshAtVendor: async () => ({
        accessToken: 'access-refresh-A', refreshToken: 'refresh-refresh-A', expiresIn: 3600,
      }),
      secrets: {
        ...actualSecrets,
        put: async (integrationId, kind, material, generation) => {
          if (material === 'access-refresh-A') {
            atRefreshWrite();
            await new Promise((resolve) => { releaseRefresh = resolve; });
          }
          return actualSecrets.put(integrationId, kind, material, generation);
        },
      },
    });
    let waitTimeout;
    try {
      await Promise.race([
        refreshAtWrite,
        refreshing.then(() => { throw new Error('refresh finished before secret write gate'); }),
        new Promise((_, reject) => {
          waitTimeout = setTimeout(() => reject(new Error('refresh did not reach secret storage')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(waitTimeout);
    }

    const newerStart = await request(app).post('/connect/hosted-mcp/linear/start');
    expect(newerStart.status).toBe(200);
    const newerState = new URL(newerStart.body.authorizeUrl).searchParams.get('state');
    const newerCookie = newerStart.headers['set-cookie'][0].split(';')[0];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-B', refresh_token: 'refresh-B', scope: 'read', id_token: idToken('acct-same'),
      }),
    });
    connectorSecrets.put.mockImplementation((integrationId, kind, material, generation) => (
      actualSecrets.put(integrationId, kind, material, generation)
    ));
    expect(outcome(await callback(newerState, newerCookie))).toEqual({ hostedMcp: 'connected', code: null });
    releaseRefresh();
    await expect(refreshing).rejects.toMatchObject({ name: 'ConnectorSecretStaleWrite' });

    const after = await Integration.findById(id).lean();
    expect(after.status).toBe('connected');
    expect(await actualSecrets.get(after.config.credentialRef)).toBe('access-B');
    expect(await actualSecrets.get(after.config.refreshTokenRef)).toBe('refresh-B');
  } finally {
    releaseRefresh?.();
    if (originalKeys === undefined) delete process.env.CONNECTOR_SECRET_KEYS;
    else process.env.CONNECTOR_SECRET_KEYS = originalKeys;
    if (originalActiveKey === undefined) delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    else process.env.CONNECTOR_SECRET_ACTIVE_KEY = originalActiveKey;
  }
});

test('a post-start refresh cannot borrow the pending authorization after callback state is consumed', async () => {
  const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
  const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  process.env.CONNECTOR_SECRET_KEYS = `test:${Buffer.alloc(32, 7).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'test';
  const actualSecrets = jest.requireActual('../../../services/connectorSecrets');
  const { credentialFor } = require('../../../services/hostedMcpCredentialService');
  const { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } = require('../../../services/connectorSecretKinds');
  let releaseWait;
  let releaseCallback;
  try {
    const id = await seedPending({ state: 'st-refresh-after-start', subject: 'acct-same', credentialRef: undefined });
    const accessRef = await actualSecrets.put(id, HOSTED_MCP_ACCESS_TOKEN, 'old-access', 1000000);
    const refreshRef = await actualSecrets.put(id, HOSTED_MCP_REFRESH_TOKEN, 'old-refresh', 1000000);
    await Integration.updateOne({ _id: id }, {
      $set: {
        status: 'connected', 'config.authGeneration': 1, 'config.refreshGeneration': 3,
        'config.credentialRef': accessRef, 'config.refreshTokenRef': refreshRef,
        'config.clientId': 'client-id', 'config.expiresAt': new Date(Date.now() - 3600 * 1000),
      },
      $unset: { 'config.pendingAuth': 1 },
    });

    const started = await request(app).post('/connect/hosted-mcp/linear/start');
    expect(started.status).toBe(200);
    const pending = await Integration.findById(id).lean();
    expect(pending.config.authGeneration).toBe(2);
    expect(pending.config.credentialAuthGeneration).toBe(1);
    const state = new URL(started.body.authorizeUrl).searchParams.get('state');
    const cookie = started.headers['set-cookie'][0].split(';')[0];

    let callbackAtVendor;
    const callbackReached = new Promise((resolve) => { callbackAtVendor = resolve; });
    global.fetch = jest.fn(() => new Promise((resolve) => {
      releaseCallback = () => resolve({
        ok: true,
        json: async () => ({
          access_token: 'access-B', refresh_token: 'refresh-B', expires_in: 3600,
          scope: 'read', id_token: idToken('acct-same'),
        }),
      });
      callbackAtVendor();
    }));
    const pendingCallback = callback(state, cookie).then((result) => result);
    let callbackTimeout;
    try {
      await Promise.race([
        callbackReached,
        new Promise((_, reject) => {
          callbackTimeout = setTimeout(() => reject(new Error('callback did not reach vendor')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(callbackTimeout);
    }
    const consumed = await Integration.findById(id).lean();
    expect(consumed.status).toBe('connected');
    expect(consumed.config.pendingAuth).toBeUndefined();
    expect(consumed.config.authGeneration).toBe(2);
    expect(consumed.config.credentialAuthGeneration).toBe(1);

    let vendorCalls = 0;
    let clock = Date.now();
    let heldFirstPoll = false;
    let reachedWait;
    const waitReached = new Promise((resolve) => { reachedWait = resolve; });
    const refreshing = credentialFor(consumed, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        if (!heldFirstPoll) {
          heldFirstPoll = true;
          reachedWait();
          await new Promise((resolve) => { releaseWait = resolve; });
        }
        clock += ms;
      },
      entryFor: () => FIXTURE_ENTRY,
      clientIdFor: () => 'client-id',
      refreshAtVendor: async () => {
        vendorCalls += 1;
        return { accessToken: 'stale-access-A', refreshToken: 'stale-refresh-A', expiresIn: 3600 };
      },
      secrets: actualSecrets,
    });
    refreshing.catch(() => {});
    let waitTimeout;
    try {
      await Promise.race([
        waitReached,
        refreshing.then(() => { throw new Error('old grant refreshed before the callback'); }),
        new Promise((_, reject) => {
          waitTimeout = setTimeout(() => reject(new Error('refresh did not reach its fence')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(waitTimeout);
    }
    expect(vendorCalls).toBe(0);

    connectorSecrets.put.mockImplementation((integrationId, kind, material, generation) => (
      actualSecrets.put(integrationId, kind, material, generation)
    ));
    releaseCallback();
    expect(outcome(await pendingCallback)).toEqual({ hostedMcp: 'connected', code: null });
    releaseWait();
    const served = await refreshing;
    const after = await Integration.findById(id).lean();
    expect(served.token).toBe('access-B');
    expect(vendorCalls).toBe(0);
    expect(after.config.credentialAuthGeneration).toBe(2);
    expect(await actualSecrets.get(after.config.credentialRef)).toBe('access-B');
    expect(await actualSecrets.get(after.config.refreshTokenRef)).toBe('refresh-B');
  } finally {
    releaseWait?.();
    releaseCallback?.();
    if (originalKeys === undefined) delete process.env.CONNECTOR_SECRET_KEYS;
    else process.env.CONNECTOR_SECRET_KEYS = originalKeys;
    if (originalActiveKey === undefined) delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    else process.env.CONNECTOR_SECRET_ACTIVE_KEY = originalActiveKey;
  }
});

test('a vendor that issues no ID token CLEARS the stored subject rather than keeping a stale one', async () => {
  const id = await seedPending({ state: 'st-clear', subject: 'acct-old' });
  exchange();

  expect((await callback('st-clear')).status).toBe(302);
  // The claim is about the STORE, not the payload: `undefined` would leave
  // 'acct-old' here, and a comparison against that stale value is how a later
  // reconnect to the old account would read as "same account".
  expect((await stored(id)).providerSubject == null).toBe(true);
});

test('so a later reconnect to the old subject revokes, instead of matching the stale one', async () => {
  const id = await seedPending({ state: 'st-then', subject: 'acct-old' });
  exchange();
  await callback('st-then');
  revokeConnectionGrants.mockClear();

  // Same person re-consents and the vendor now names the account it always was.
  // The pre-image subject is GONE, so this is two unknowns, not a match — and a
  // match would keep grants minted under whatever account held the row between.
  const row = await Integration.findById(id);
  row.config.pendingAuth = {
    state: 'st-again',
    codeVerifier: 'verifier-1',
    expiresAt: new Date(Date.now() + 60 * 1000),
    browserNonce: BROWSER_NONCE,
  };
  row.config.credentialRef = 'ref-new';
  await row.save();
  exchange({ idToken: idToken('acct-old') });

  expect((await callback('st-again')).status).toBe(302);
  expect(revokeConnectionGrants).toHaveBeenCalled();
  expect((await stored(id)).providerSubject).toBe('acct-old');
});

test('the page the entry names is copied onto the row, so a removal can finish without the entry', async () => {
  const id = await seedPending({ state: 'st-page' });
  exchange();

  expect((await callback('st-page')).status).toBe(302);
  // Ruling 75780: the entry is code and can be deleted while this row lives, so
  // the page it named has to survive on the row that outlives it.
  const page = 'https://linear.app/settings/security';
  // Both reads, on purpose. The model read is the one a caller sees; the RAW
  // read is the one that cannot be satisfied by a default, a cast or a
  // re-declaration — this is the shape the mark needed, and a write by the TEST
  // (the generic RECORD_KEYS arm) cannot say the CALLBACK wrote anything.
  expect((await stored(id)).revokePage).toBe(page);
  const raw = await Integration.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  expect(raw.config.revokePage).toBe(page);
});

test('the endpoint the entry names is NOT copied — the entry keeps that decision', async () => {
  const id = await seedPending({ state: 'st-endpoint' });
  exchange();

  expect((await callback('st-endpoint')).status).toBe(302);
  const config = await stored(id);
  // A stored endpoint is a URL a row carries into a POST. Only the entry decides
  // where a token goes (§3), and it is read at removal time, so no row may hold
  // one — the fixture's endpoint value must appear nowhere on this document.
  expect(Object.keys(config).filter((key) => /endpoint/i.test(key))).toEqual([]);
  expect(JSON.stringify(config)).not.toContain('mcp.linear.app/token/does-not-exist');
});

test('a vendor that DOES issue a subject stores it — the clear is not unconditional', async () => {
  const id = await seedPending({ state: 'st-keep', subject: 'acct-old' });
  exchange({ idToken: idToken('acct-new') });

  expect((await callback('st-keep')).status).toBe(302);
  expect((await stored(id)).providerSubject).toBe('acct-new');
});
