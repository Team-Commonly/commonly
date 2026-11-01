// F34: a removal and the two writers that put a hosted-MCP token behind the
// row's refs (the OAuth callback and the token refresh) did not fence each
// other. Puts go to the secret store, which no row write fences, so a removal
// that read the old token could revoke it, sweep the slot, and leave behind a
// new token a writer put a moment later: live at the vendor, held by nobody,
// and reported `providerRevoked: true`.
//
// Each arm pauses one writer at the step that matters, runs a removal into
// that gap, then lets the writer finish. The claim is always the same: every
// token a writer obtained is revoked at the vendor, or the removal refuses,
// and `providerRevoked` is never true while a token we obtained is unrevoked.
//
// Real mongod, because the fence is what the row CARRIES between writers. The
// secret store is the in-memory seam the F28 test uses: a put after a revoke
// re-inserts, exactly as the real upsert does.
process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

jest.mock('../../services/hostedVendorFetch', () => ({
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  hostedVendorFetch: (...args) => global.fetch(...args),
}));

const ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  revoke: { page: 'https://linear.app/settings/security', endpoint: 'https://mcp.linear.app/revoke' },
  tools: [],
};

jest.mock('../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../integrations/hostedMcp/entries');
  return {
    HOSTED_MCP_ENTRIES: [ENTRY],
    findHostedMcpEntry: actual.findHostedMcpEntry,
    hostedMcpRevokeTarget: actual.hostedMcpRevokeTarget,
  };
});

jest.mock('../../services/hostedMcpIntakeService', () => {
  const actual = jest.requireActual('../../services/hostedMcpIntakeService');
  return { ...actual, discoverAuthorizationServer: jest.fn() };
});

jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '6a8f6de2a1dccf2e02f31028' };
  next();
});

jest.mock('../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

jest.mock('../../services/connectorSecrets', () => {
  const store = new Map();
  const failRevoke = { next: false };
  // A put can be held at the door: the writer has passed its row fence and
  // is about to replace the material.
  const holdPut = { gate: null };
  return {
    store,
    failRevoke,
    holdPut,
    put: jest.fn(async (rowId, kind, value) => {
      if (holdPut.gate) {
        const { gate } = holdPut;
        holdPut.gate = null;
        gate.arrive();
        await gate.opened;
      }
      // Keyed on the kind's name, as the real store's (integrationId, kind)
      // index is: the spec object itself stringifies the same for both halves.
      const ref = `${rowId}:${kind.kind}`;
      store.set(ref, value);
      return ref;
    }),
    get: jest.fn(async (ref) => {
      if (!store.has(ref)) throw Object.assign(new Error('not found'), { code: 'connector_secret_not_found' });
      return store.get(ref);
    }),
    // This store records no write generation, so every pair reads as whole.
    // Mixed pairs are the real-store suite's (hostedMcpRemovalMixedPair).
    writeGenerationOf: jest.fn(async (ref) => {
      if (!store.has(ref)) throw Object.assign(new Error('not found'), { code: 'connector_secret_not_found' });
      return null;
    }),
    revoke: jest.fn(async (ref) => {
      if (failRevoke.next) {
        failRevoke.next = false;
        throw new Error('secret store unavailable');
      }
      store.delete(ref);
    }),
  };
});

jest.mock('../../services/roomGrantService', () => ({
  revokeConnectionGrants: jest.fn(async () => 0),
}));

jest.mock('../../services/hostedMcpToolDefinitions', () => ({
  forgetHostedMcpDrift: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const Integration = require('../../models/Integration');
const connectorSecrets = require('../../services/connectorSecrets');
const intake = require('../../services/hostedMcpIntakeService');
const { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } = require('../../services/connectorSecretKinds');
const {
  removeConnection, PROVIDER_REVOKED_MARK, WRITER_LEASE_OVERRUN_MS, REMOVAL_LEASE_MS,
} = require('../../services/connectionRemovalService');
const { credentialFor, REFRESH_LEASE_MS } = require('../../services/hostedMcpCredentialService');
const connectRoutes = require('../../routes/hostedMcpConnect');

const OWNER_ID = new mongoose.Types.ObjectId('6a8f6de2a1dccf2e02f31028');
const CLIENT_ID = intake.hostedMcpClientMetadataUrl('linear');
const TOKEN_ENDPOINT = 'https://mcp.linear.app/token';
const REVOKE_ENDPOINT = 'https://mcp.linear.app/revoke';

const app = express();
app.use('/connect/hosted-mcp', connectRoutes);

const idToken = (sub) => [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub })).toString('base64url'),
  'sig',
].join('.');

/** A writer held mid-step: `arrived` resolves when it reaches the gate, `open()` lets it on. */
const makeGate = () => {
  let arrive;
  let open;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  const opened = new Promise((resolve) => { open = resolve; });
  return { arrive, arrived, open, opened };
};

// Every token the vendor was asked to revoke, by any path: the removal's own
// call, and a callback revoking a grant it could not store.
let revokedAtVendor;
let exchangeGate;

const removalVendor = async ({ token }) => { revokedAtVendor.push(token); };

// Only the vendor call is stubbed. Every other removal step is the production
// one, reading and writing the real row. `connection` defaults to the row as
// it is now; an arm that needs the stale read a racing caller would hold
// passes its own.
const remove = async ({ connection, now, vendor = removalVendor } = {}) => removeConnection({
  connection: connection || await Integration.findOne({ type: 'hosted-mcp', createdBy: OWNER_ID }).lean(),
  removedBy: String(OWNER_ID),
  revokeGrants: async () => 0,
  deps: {
    revokeAtVendor: vendor,
    clientIdFor: () => CLIENT_ID,
    clientSecretFor: () => undefined,
    ...(now ? { now } : {}),
  },
});

// Past the lease a writer took and its overrun, as a later retry would be.
const afterTheLease = () => new Date(Date.now() + REFRESH_LEASE_MS + WRITER_LEASE_OVERRUN_MS + 1000);

const seedConnectedRow = async (config = {}) => {
  const row = await Integration.create({
    type: 'hosted-mcp',
    scope: 'user',
    status: 'connected',
    createdBy: OWNER_ID,
    config: {
      entryId: 'linear',
      intake: 'oauth',
      clientId: CLIENT_ID,
      providerSubject: 'acct-1',
      authGeneration: 1,
      ...config,
    },
  });
  const credentialRef = await connectorSecrets.put(String(row._id), HOSTED_MCP_ACCESS_TOKEN, 'access-1');
  const refreshTokenRef = await connectorSecrets.put(String(row._id), HOSTED_MCP_REFRESH_TOKEN, 'refresh-1');
  await Integration.updateOne(
    { _id: row._id },
    {
      $set: {
        'config.credentialRef': credentialRef,
        'config.refreshTokenRef': refreshTokenRef,
        'config.credentialAuthGeneration': 1,
      },
    },
  );
  connectorSecrets.put.mockClear();
  return row._id;
};

// The pending state exactly as `/start` writes it onto an existing row.
const startReconnect = async (rowId, n = 2) => {
  await Integration.updateOne(
    { _id: rowId },
    {
      $inc: { 'config.authGeneration': 1 },
      $set: {
        'config.intake': 'oauth',
        'config.pendingAuth': {
          state: `st-${n}`,
          codeVerifier: `verifier-${n}`,
          expiresAt: new Date(Date.now() + 60 * 1000),
          browserNonce: `browser-${n}`,
          clientId: CLIENT_ID,
        },
      },
    },
  );
};

// Sent, not awaited: the arm decides when it finishes.
const sendCallback = (n = 2) => request(app)
  .get(`/connect/hosted-mcp/linear/callback?state=st-${n}&code=code-${n}`)
  .set('Cookie', `${intake.HOSTED_MCP_NONCE_COOKIE}=browser-${n}`)
  .then((res) => new URL(res.headers.location, 'https://commonly.me').searchParams);

const storedTokens = () => [...connectorSecrets.store.values()];

beforeAll(async () => {
  await setupMongoDb();
  await Integration.init();
});

afterAll(async () => {
  await closeMongoDb();
});

beforeEach(async () => {
  await clearMongoDb();
  connectorSecrets.store.clear();
  connectorSecrets.failRevoke.next = false;
  connectorSecrets.holdPut.gate = null;
  jest.clearAllMocks();
  revokedAtVendor = [];
  exchangeGate = null;
  intake.discoverAuthorizationServer.mockResolvedValue({
    issuer: 'https://mcp.linear.app',
    authorization_endpoint: 'https://mcp.linear.app/authorize',
    token_endpoint: TOKEN_ENDPOINT,
    revocation_endpoint: REVOKE_ENDPOINT,
  });
  global.fetch = jest.fn(async (url, init = {}) => {
    if (String(url) === REVOKE_ENDPOINT) {
      revokedAtVendor.push(new URLSearchParams(String(init.body)).get('token'));
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (exchangeGate) {
      const gate = exchangeGate;
      exchangeGate = null;
      gate.arrive();
      await gate.opened;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        scope: 'read openid',
        id_token: idToken('acct-1'),
      }),
    };
  });
});

describe('a removal racing the writers that put a token', () => {
  it('positive control: with no writer in flight, removal revokes the stored token and finishes first time', async () => {
    const rowId = await seedConnectedRow();
    const result = await remove();
    expect(result).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(revokedAtVendor).toEqual(['refresh-1']);
    expect(await Integration.findById(rowId).lean()).toBeNull();
    expect(storedTokens()).toEqual([]);
  });

  it('a callback past its retire write holds the row: removal refuses, then revokes the token the callback stored', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);

    const gate = makeGate();
    connectorSecrets.holdPut.gate = gate;
    const callback = sendCallback();
    await gate.arrived;

    // The callback has retired the row and is about to put access-2/refresh-2.
    const first = await remove();
    expect(first).toEqual(expect.objectContaining({
      removed: false,
      code: 'removal_busy',
      revokeAt: ENTRY.revoke.page,
    }));
    expect(revokedAtVendor).toEqual([]);
    expect((await Integration.findById(rowId).lean()).status).toBe('disconnected');

    gate.open();
    // The removal moved the row's generation, so the callback cannot publish,
    // and it revokes the grant it was handed rather than leave it to refs.
    expect((await callback).get('hostedMcp')).toBe('error');
    expect((await Integration.findById(rowId).lean()).status).toBe('disconnected');
    expect(revokedAtVendor).toEqual(['refresh-2']);

    const retry = await remove();
    expect(revokedAtVendor).toEqual(['refresh-2', 'refresh-2']);
    expect(retry).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
    expect(storedTokens()).toEqual([]);
  });

  // The security review's sequence for F28, exactly: the removal read the row
  // while a half-finished removal's mark was still on it, and the reconnect
  // finished before the removal's own write. A mark read from that snapshot
  // skips the vendor and sweeps the new token.
  it('reads the mark from its own write, not from the row the caller read before a reconnect', async () => {
    const rowId = await seedConnectedRow();
    connectorSecrets.failRevoke.next = true;
    expect(await remove()).toEqual(expect.objectContaining({ code: 'provider_revoked_removal_incomplete' }));
    const stale = await Integration.findById(rowId).lean();
    expect(stale.config[PROVIDER_REVOKED_MARK]).toBeTruthy();

    await startReconnect(rowId);
    expect((await sendCallback()).get('hostedMcp')).toBe('connected');

    const result = await remove({ connection: stale });
    expect(revokedAtVendor).toEqual(['refresh-1', 'refresh-2']);
    expect(result).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(storedTokens()).toEqual([]);
  });

  it('a refresh past its fence holds the row: removal refuses, then revokes the rotated token', async () => {
    const rowId = await seedConnectedRow({
      credentialAuthGeneration: 1,
      refreshGeneration: 0,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const gate = makeGate();
    const refresh = credentialFor(await Integration.findById(rowId).lean(), {
      clientIdFor: () => CLIENT_ID,
      clientSecretFor: () => undefined,
      sleep: async () => {},
      refreshAtVendor: async ({ refreshToken }) => {
        expect(refreshToken).toBe('refresh-1');
        gate.arrive();
        await gate.opened;
        return { accessToken: 'access-r', refreshToken: 'refresh-r', expiresIn: 3600, scope: 'read openid' };
      },
    });
    await gate.arrived;

    // The vendor has the refresh; the rotated pair is not stored yet.
    const first = await remove();
    expect(first).toEqual(expect.objectContaining({ removed: false, code: 'removal_busy' }));
    expect(revokedAtVendor).toEqual([]);

    gate.open();
    await expect(refresh).rejects.toMatchObject({ code: 'connection_mismatch' });
    expect(storedTokens()).toEqual(expect.arrayContaining(['refresh-r']));

    // A losing refresh leaves its lease to expire; the retry comes after it.
    const retry = await remove({ now: afterTheLease });
    expect(revokedAtVendor).toEqual(['refresh-r']);
    expect(retry).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
    expect(storedTokens()).toEqual([]);
  });

  // CodeRabbit on #3252: only the publish write records refs. A row whose old
  // grant came with no refresh token has no refresh ref, so a refresh token
  // this callback put before losing its publish is named by nothing, and the
  // removal's retry can send only the access token.
  it('a callback that loses its publish to a removal revokes its grant, even a refresh token no ref names', async () => {
    const rowId = await seedConnectedRow();
    await Integration.updateOne({ _id: rowId }, { $unset: { 'config.refreshTokenRef': '' } });
    connectorSecrets.store.delete(`${rowId}:${HOSTED_MCP_REFRESH_TOKEN.kind}`);
    await startReconnect(rowId);

    const gate = makeGate();
    connectorSecrets.holdPut.gate = gate;
    const callback = sendCallback();
    await gate.arrived;
    expect(await remove()).toEqual(expect.objectContaining({ code: 'removal_busy' }));

    gate.open();
    expect((await callback).get('hostedMcp')).toBe('error');
    expect(revokedAtVendor).toEqual(['refresh-2']);

    const retry = await remove();
    expect(revokedAtVendor).toEqual(['refresh-2', 'access-2']);
    expect(retry).toEqual(expect.objectContaining({ removed: true }));
  });

  // CodeRabbit on #3252: a refresh of the old pair can still be calling the
  // vendor when a reconnect retires the row, and the retire write replaces its
  // lease. Dropped at the publish, that lease no longer holds a removal off,
  // and the refresh's puts (upserts) land after the sweep.
  it('a refresh in flight across a reconnect keeps its lease after the callback publishes', async () => {
    const rowId = await seedConnectedRow({
      credentialAuthGeneration: 1,
      refreshGeneration: 0,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const gate = makeGate();
    const refresh = credentialFor(await Integration.findById(rowId).lean(), {
      clientIdFor: () => CLIENT_ID,
      clientSecretFor: () => undefined,
      sleep: async () => {},
      refreshAtVendor: async () => {
        gate.arrive();
        await gate.opened;
        return { accessToken: 'access-r', refreshToken: 'refresh-r', expiresIn: 3600, scope: 'read openid' };
      },
    });
    await gate.arrived;

    await startReconnect(rowId);
    expect((await sendCallback()).get('hostedMcp')).toBe('connected');

    const first = await remove();
    expect(first).toEqual(expect.objectContaining({ removed: false, code: 'removal_busy' }));
    expect(revokedAtVendor).toEqual([]);

    gate.open();
    await expect(refresh).rejects.toBeTruthy();

    const retry = await remove({ now: afterTheLease });
    expect(retry).toEqual(expect.objectContaining({ removed: true }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
    expect(storedTokens()).toEqual([]);
  });

  // CodeRabbit on #3252: the removal's vendor calls can outlast its lease, and
  // the lapse lets a `/start` through whose callback publishes new material
  // behind the same refs. Marking, sweeping and deleting then would end the new
  // material and leave its grant live at the vendor.
  it('a removal whose lease lapsed during its vendor call writes nothing over a reconnect that published meanwhile', async () => {
    const rowId = await seedConnectedRow();
    const vendorGate = makeGate();
    // A removal running behind the clock: the lease it takes has already lapsed.
    const removal = remove({
      now: () => new Date(Date.now() - REMOVAL_LEASE_MS - 1000),
      vendor: async ({ token }) => {
        revokedAtVendor.push(token);
        vendorGate.arrive();
        await vendorGate.opened;
      },
    });
    await vendorGate.arrived;

    await startReconnect(rowId);
    expect((await sendCallback()).get('hostedMcp')).toBe('connected');

    vendorGate.open();
    expect(await removal).toEqual(expect.objectContaining({ removed: false, code: 'removal_busy' }));
    expect(revokedAtVendor).toEqual(['refresh-1']);
    const row = await Integration.findById(rowId).lean();
    expect(row.status).toBe('connected');
    expect(row.config[PROVIDER_REVOKED_MARK]).toBeFalsy();
    expect(storedTokens()).toEqual(expect.arrayContaining(['access-2', 'refresh-2']));

    const retry = await remove();
    expect(revokedAtVendor).toEqual(['refresh-1', 'refresh-2']);
    expect(retry).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(storedTokens()).toEqual([]);
  });

  // A callback that exchanged its code before the removal began, and reaches
  // its retire write after the removal's. The removal's generation keeps it
  // from reconnecting a row being removed, and the grant it was handed is
  // revoked rather than dropped, so the removal's `providerRevoked: true`
  // still holds.
  it('a callback still exchanging when the removal lands cannot reconnect the row, and revokes the grant it was handed', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);

    const gate = makeGate();
    exchangeGate = gate;
    const callback = sendCallback();
    await gate.arrived;

    // The local sweep fails, so the row survives the removal and a callback
    // that slipped past it could still reconnect it.
    connectorSecrets.failRevoke.next = true;
    const first = await remove();
    expect(first).toEqual(expect.objectContaining({
      removed: false,
      code: 'provider_revoked_removal_incomplete',
      providerRevoked: true,
    }));
    expect(revokedAtVendor).toEqual(['refresh-1']);

    gate.open();
    const outcome = await callback;
    expect(outcome.get('hostedMcp')).toBe('error');
    expect(revokedAtVendor).toEqual(['refresh-1', 'refresh-2']);
    const after = await Integration.findById(rowId).lean();
    expect(after.status).toBe('disconnected');
    expect(storedTokens()).not.toContain('refresh-2');

    const retry = await remove();
    expect(retry).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(revokedAtVendor).toEqual(['refresh-1', 'refresh-2']);
  });

  // The other way a retire write loses: a newer /start. Some vendors revoke
  // every grant for an account and client together, so revoking here could
  // end the newer flow's grant too. Only a removal earns the revoke.
  it('a callback that loses to a newer /start, not a removal, revokes nothing', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);

    const gate = makeGate();
    exchangeGate = gate;
    const callback = sendCallback();
    await gate.arrived;

    await startReconnect(rowId, 3);

    gate.open();
    expect((await callback).get('hostedMcp')).toBe('error');
    expect(revokedAtVendor).toEqual([]);
    expect((await Integration.findById(rowId).lean()).status).toBe('connected');
  });

  // Both reviews of the first cut: a `/start` begun after the removal's fence
  // bumps the generation again, so the generation alone cannot keep its
  // callback out. The removal's own lease does: while it is held, the retire
  // write refuses, and the grant that callback was handed is revoked.
  it('a reconnect begun after the removal fenced the row cannot store a token the removal then sweeps', async () => {
    const rowId = await seedConnectedRow();
    const gate = makeGate();
    const removal = remove({
      vendor: async ({ token }) => {
        revokedAtVendor.push(token);
        gate.arrive();
        await gate.opened;
      },
    });
    await gate.arrived;

    // The removal holds the row and is at the vendor with refresh-1.
    await startReconnect(rowId);
    const outcome = await sendCallback();
    expect(outcome.get('hostedMcp')).toBe('error');
    expect(revokedAtVendor).toEqual(['refresh-1', 'refresh-2']);
    expect(storedTokens()).not.toContain('refresh-2');

    gate.open();
    expect(await removal).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
    expect(storedTokens()).toEqual([]);
  });

  // A refresh's lease equals its two vendor timeouts and nothing more, so its
  // puts can land just after the lease lapses. A removal treats it as held
  // for one more vendor timeout.
  it('a writer lease that lapsed a moment ago still holds the removal off; one long gone does not', async () => {
    const rowId = await seedConnectedRow();
    await Integration.updateOne({ _id: rowId }, { $set: { 'config.refreshingUntil': new Date(Date.now() - 5 * 1000) } });
    expect(await remove()).toEqual(expect.objectContaining({ removed: false, code: 'removal_busy' }));
    expect(revokedAtVendor).toEqual([]);

    await Integration.updateOne({ _id: rowId }, { $set: { 'config.refreshingUntil': new Date(Date.now() - 20 * 1000) } });
    expect(await remove()).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(revokedAtVendor).toEqual(['refresh-1']);
  });

  // The general review: a removal, then a quick new /start, both while an
  // older callback is still exchanging. The removal already happened, so the
  // older grant is revoked even though a newer flow is now pending.
  it('a callback fenced by a removal still revokes its grant when a newer /start has begun since', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);

    const gate = makeGate();
    exchangeGate = gate;
    const callback = sendCallback();
    await gate.arrived;

    connectorSecrets.failRevoke.next = true;
    await remove();
    await startReconnect(rowId, 3);

    gate.open();
    expect((await callback).get('hostedMcp')).toBe('error');
    expect(revokedAtVendor).toEqual(['refresh-1', 'refresh-2']);
  });

  it('a reconnect started before the removal but not yet finished cannot be finished after it', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);

    connectorSecrets.failRevoke.next = true;
    await remove();

    const outcome = await sendCallback();
    expect(outcome.get('hostedMcp')).toBe('error');
    expect(global.fetch).not.toHaveBeenCalledWith(TOKEN_ENDPOINT, expect.anything());
    expect((await Integration.findById(rowId).lean()).status).toBe('disconnected');
  });
});
