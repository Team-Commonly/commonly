// F28: a removal that revoked at the vendor and then failed locally leaves the
// row `disconnected` with `config.providerRevokedAt` set, so its retry can skip
// the vendor. If the person reconnects instead, the callback puts a NEW token
// behind the same refs. A mark that survived the reconnect would make the next
// removal skip the vendor revoke for that new token, delete it locally, and
// answer `providerRevoked: true` while the grant is still live at the vendor.
//
// Real mongod, because the claim is about what the row CARRIES between three
// writers (removal, callback, removal): a mocked model reports the update it
// was handed and cannot say what survives on the document.
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

// A literal: a `jest.mock` factory may not close over an out-of-scope binding.
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

// The secret store is the one seam kept in memory: the claim is about the row,
// and the refs it holds have to resolve to the token each step really wrote.
jest.mock('../../services/connectorSecrets', () => {
  const store = new Map();
  const failRevoke = { next: false };
  const failPut = { kind: null };
  return {
    store,
    failRevoke,
    failPut,
    put: jest.fn(async (rowId, kind, value) => {
      if (failPut.kind === kind) throw new Error('secret store unavailable');
      const ref = `${rowId}:${kind}`;
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
const { removeConnection, PROVIDER_REVOKED_MARK } = require('../../services/connectionRemovalService');
const connectRoutes = require('../../routes/hostedMcpConnect');

const OWNER_ID = new mongoose.Types.ObjectId('6a8f6de2a1dccf2e02f31028');
const CLIENT_ID = intake.hostedMcpClientMetadataUrl('linear');

const app = express();
app.use('/connect/hosted-mcp', connectRoutes);

const idToken = (sub) => [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub })).toString('base64url'),
  'sig',
].join('.');

// Only the vendor call is stubbed. Every other removal step is the production
// one, reading and writing the real row.
const removeWith = (revokeAtVendor) => async () => {
  const connection = await Integration.findOne({ type: 'hosted-mcp', createdBy: OWNER_ID }).lean();
  return removeConnection({
    connection,
    removedBy: String(OWNER_ID),
    revokeGrants: async () => 0,
    deps: {
      revokeAtVendor,
      clientIdFor: () => CLIENT_ID,
      clientSecretFor: () => undefined,
    },
  });
};

const seedConnectedRow = async () => {
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
const startReconnect = async (rowId) => {
  await Integration.updateOne(
    { _id: rowId },
    {
      $inc: { 'config.authGeneration': 1 },
      $set: {
        'config.intake': 'oauth',
        'config.pendingAuth': {
          state: 'st-2',
          codeVerifier: 'verifier-2',
          expiresAt: new Date(Date.now() + 60 * 1000),
          browserNonce: 'browser-2',
          clientId: CLIENT_ID,
        },
      },
    },
  );
};

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
  connectorSecrets.failPut.kind = null;
  jest.clearAllMocks();
  intake.discoverAuthorizationServer.mockResolvedValue({
    issuer: 'https://mcp.linear.app',
    authorization_endpoint: 'https://mcp.linear.app/authorize',
    token_endpoint: 'https://mcp.linear.app/token',
    revocation_endpoint: 'https://mcp.linear.app/revoke',
  });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
      scope: 'read openid',
      id_token: idToken('acct-1'),
    }),
  });
});

describe('a reconnect after a half-finished removal', () => {
  it('removal again calls the vendor revoke for the new token and answers providerRevoked from that call', async () => {
    const rowId = await seedConnectedRow();

    // 1. The vendor revoke takes, then the local sweep fails (after step 3b).
    const firstVendor = jest.fn(async () => {});
    connectorSecrets.failRevoke.next = true;
    const first = await removeWith(firstVendor)();
    expect(first).toMatchObject({ removed: false, code: 'provider_revoked_removal_incomplete', providerRevoked: true });
    expect(firstVendor).toHaveBeenCalledTimes(1);
    expect(firstVendor.mock.calls[0][0]).toMatchObject({ token: 'refresh-1', tokenTypeHint: 'refresh_token' });
    const marked = await Integration.findById(rowId).lean();
    expect(marked.status).toBe('disconnected');
    expect(marked.config[PROVIDER_REVOKED_MARK]).toBeTruthy();

    // 2. The person reconnects through the real callback, on the same row.
    await startReconnect(rowId);
    const res = await request(app)
      .get('/connect/hosted-mcp/linear/callback?state=st-2&code=code-2')
      .set('Cookie', `${intake.HOSTED_MCP_NONCE_COOKIE}=browser-2`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location, 'https://commonly.me').searchParams.get('hostedMcp')).toBe('connected');
    const reconnected = await Integration.findById(rowId).lean();
    expect(reconnected.status).toBe('connected');
    expect(await connectorSecrets.get(reconnected.config.refreshTokenRef)).toBe('refresh-2');
    expect(reconnected.config).not.toHaveProperty(PROVIDER_REVOKED_MARK);

    // 3. The next removal revokes the NEW token at the vendor, and its answer
    //    comes from that call rather than from the old mark.
    const secondVendor = jest.fn(async () => {});
    const second = await removeWith(secondVendor)();
    expect(secondVendor).toHaveBeenCalledTimes(1);
    expect(secondVendor.mock.calls[0][0]).toMatchObject({ token: 'refresh-2', tokenTypeHint: 'refresh_token' });
    expect(second).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
  });

  // The placement: the mark goes when the row is retired, BEFORE new material
  // lands behind the refs. A reconnect that dies after writing the new access
  // token never reaches the publish, so a mark cleared only there would still
  // be on the row, beside a token the vendor never saw revoked.
  it('a reconnect that fails after writing new material still leaves no mark, so removal calls the vendor', async () => {
    const rowId = await seedConnectedRow();
    connectorSecrets.failRevoke.next = true;
    await removeWith(jest.fn(async () => {}))();

    await startReconnect(rowId);
    connectorSecrets.failPut.kind = HOSTED_MCP_REFRESH_TOKEN;
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .get('/connect/hosted-mcp/linear/callback?state=st-2&code=code-2')
        .set('Cookie', `${intake.HOSTED_MCP_NONCE_COOKIE}=browser-2`);
      expect(new URL(res.headers.location, 'https://commonly.me').searchParams.get('hostedMcp')).toBe('error');
    } finally {
      log.mockRestore();
    }
    const halfWritten = await Integration.findById(rowId).lean();
    expect(await connectorSecrets.get(halfWritten.config.credentialRef)).toBe('access-2');
    expect(halfWritten.config).not.toHaveProperty(PROVIDER_REVOKED_MARK);

    // Only the call is asserted, not the answer. The refs now hold a mixed
    // pair (new access, old refresh), and what removal should report for that
    // is its own defect, filed separately: a test pinning today's answer
    // would break when that fix lands.
    connectorSecrets.failPut.kind = null;
    const vendor = jest.fn(async () => {});
    await removeWith(vendor)();
    expect(vendor).toHaveBeenCalledTimes(1);
  });

  it('positive control: a retry with no reconnect still skips the vendor, so the mark is what the fix clears', async () => {
    const rowId = await seedConnectedRow();
    connectorSecrets.failRevoke.next = true;
    await removeWith(jest.fn(async () => {}))();

    const retryVendor = jest.fn(async () => {});
    const retry = await removeWith(retryVendor)();
    expect(retryVendor).not.toHaveBeenCalled();
    expect(retry).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
  });
});
