// F35: a writer that stops between its two puts leaves a MIXED pair behind the
// row's refs: the new access token, and the refresh token of the grant before
// it. The new grant's refresh token is held by nobody. A removal that sends
// only the refresh token revokes the OLD grant, and used to answer
// `providerRevoked: true` while the new grant stayed live at the vendor.
//
// Real mongod and the REAL secret store, because the evidence is what the
// store records: each put carries the generation of the write that made it,
// and a pair whose two halves disagree came from two different writes.
process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';
process.env.CONNECTOR_SECRET_KEYS = `f35:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'f35';

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
const ConnectorSecret = require('../../models/ConnectorSecret');
const connectorSecrets = require('../../services/connectorSecrets');
const intake = require('../../services/hostedMcpIntakeService');
const { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } = require('../../services/connectorSecretKinds');
const { secretWriteGeneration } = require('../../services/hostedMcpSecretGeneration');
const { removeConnection, PROVIDER_REVOKED_MARK, WRITER_LEASE_OVERRUN_MS } = require('../../services/connectionRemovalService');
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

// Every token sent to the vendor's RFC 7009 endpoint, with its hint, in order.
let revokedAtVendor;
// When set, the revoke endpoint refuses tokens sent with this hint.
let refuseHint;

const remove = async ({ now } = {}) => removeConnection({
  connection: await Integration.findOne({ type: 'hosted-mcp', createdBy: OWNER_ID }).lean(),
  removedBy: String(OWNER_ID),
  revokeGrants: async () => 0,
  deps: { clientIdFor: () => CLIENT_ID, clientSecretFor: () => undefined, ...(now ? { now } : {}) },
});

// A refresh whose put threw leaves its lease to lapse; a removal waits it out.
const afterTheLease = () => new Date(Date.now() + REFRESH_LEASE_MS + WRITER_LEASE_OVERRUN_MS + 1000);

// A connected row whose pair a callback stored, exactly as it stores one: both
// halves at the generation of that authorization's first write.
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
  const generation = secretWriteGeneration(1, 0);
  const credentialRef = await connectorSecrets.put(String(row._id), HOSTED_MCP_ACCESS_TOKEN, 'access-1', generation);
  const refreshTokenRef = await connectorSecrets.put(String(row._id), HOSTED_MCP_REFRESH_TOKEN, 'refresh-1', generation);
  await Integration.updateOne(
    { _id: row._id },
    {
      $set: {
        'config.credentialRef': credentialRef,
        'config.refreshTokenRef': refreshTokenRef,
        'config.credentialAuthGeneration': 1,
        'config.refreshGeneration': 0,
      },
    },
  );
  return row._id;
};

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

const sendCallback = () => request(app)
  .get('/connect/hosted-mcp/linear/callback?state=st-2&code=code-2')
  .set('Cookie', `${intake.HOSTED_MCP_NONCE_COOKIE}=browser-2`)
  .then((res) => new URL(res.headers.location, 'https://commonly.me').searchParams);

// The store refuses the refresh-token half of the next write, once: the
// access half has already landed behind its ref.
const failNextRefreshPut = (real) => {
  let armed = true;
  return jest.fn(async (rowId, spec, material, generation) => {
    if (armed && spec.kind === HOSTED_MCP_REFRESH_TOKEN.kind) {
      armed = false;
      throw new Error('secret store unavailable');
    }
    return real(rowId, spec, material, generation);
  });
};

// The same refusal, on the callback route's own handle on the store.
const failCallbackRefreshPut = () => {
  const real = connectorSecrets.put;
  jest.spyOn(connectorSecrets, 'put').mockImplementation(failNextRefreshPut(real));
};

const refresh = (rowId, { put, refreshed }) => Integration.findById(rowId).lean().then((row) => credentialFor(row, {
  clientIdFor: () => CLIENT_ID,
  clientSecretFor: () => undefined,
  sleep: async () => {},
  ...(put ? { secrets: { ...connectorSecrets, put } } : {}),
  refreshAtVendor: async () => refreshed,
}));

const expire = (rowId) => Integration.updateOne(
  { _id: rowId },
  { $set: { 'config.expiresAt': new Date(Date.now() - 60 * 60 * 1000) } },
);

const secretsLeft = () => ConnectorSecret.countDocuments({});

beforeAll(async () => {
  await setupMongoDb();
  await Integration.init();
  await ConnectorSecret.init();
});

afterAll(async () => {
  await closeMongoDb();
});

beforeEach(async () => {
  await clearMongoDb();
  jest.restoreAllMocks();
  revokedAtVendor = [];
  refuseHint = null;
  intake.discoverAuthorizationServer.mockResolvedValue({
    issuer: 'https://mcp.linear.app',
    authorization_endpoint: 'https://mcp.linear.app/authorize',
    token_endpoint: TOKEN_ENDPOINT,
    revocation_endpoint: REVOKE_ENDPOINT,
  });
  global.fetch = jest.fn(async (url, init = {}) => {
    if (String(url) === REVOKE_ENDPOINT) {
      const body = new URLSearchParams(String(init.body));
      const hint = body.get('token_type_hint');
      if (hint === refuseHint) {
        return { ok: false, status: 400, json: async () => ({ error: 'unsupported_token_type' }) };
      }
      revokedAtVendor.push(`${hint}:${body.get('token')}`);
      return { ok: true, status: 200, json: async () => ({}) };
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

describe('a removal of a pair whose two halves came from different writes', () => {
  it('positive control: a pair one callback stored is revoked by its refresh token, and the vendor revoke is claimed', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);
    expect((await sendCallback()).get('hostedMcp')).toBe('connected');
    revokedAtVendor = [];

    const result = await remove();
    expect(revokedAtVendor).toEqual(['refresh_token:refresh-2']);
    expect(result).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
    expect(await secretsLeft()).toBe(0);
  });

  it('a callback whose refresh put failed: the new access token is revoked too, and the vendor revoke is not claimed', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);
    failCallbackRefreshPut();
    expect((await sendCallback()).get('hostedMcp')).toBe('error');
    connectorSecrets.put.mockRestore();
    revokedAtVendor = [];

    // access-2 is behind the access ref; refresh-1 is still behind the refresh
    // ref, and refresh-2 was never stored.
    const result = await remove();
    expect(revokedAtVendor).toEqual(['refresh_token:refresh-1', 'access_token:access-2']);
    expect(result).toEqual(expect.objectContaining({
      removed: true,
      providerRevoked: false,
      revokeAt: ENTRY.revoke.page,
    }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
    expect(await secretsLeft()).toBe(0);
  });

  it('a refresh whose refresh put failed: the rotated access token is revoked too, and the vendor revoke is not claimed', async () => {
    const rowId = await seedConnectedRow();
    await expire(rowId);
    await expect(refresh(rowId, {
      put: failNextRefreshPut(connectorSecrets.put),
      refreshed: { accessToken: 'access-r', refreshToken: 'refresh-r', expiresIn: 3600, scope: 'read openid' },
    })).rejects.toThrow();

    const result = await remove({ now: afterTheLease });
    expect(revokedAtVendor).toEqual(['refresh_token:refresh-1', 'access_token:access-r']);
    expect(result).toEqual(expect.objectContaining({ removed: true, providerRevoked: false }));
    expect(await secretsLeft()).toBe(0);
  });

  // A vendor that does not rotate hands back no refresh token, and the refresh
  // re-writes the one it holds at its own generation. That pair is whole, and
  // must not read as mixed: every removal on such a vendor would then disown a
  // revoke that took.
  it('a refresh at a vendor that does not rotate leaves a whole pair, revoked and claimed as before', async () => {
    const rowId = await seedConnectedRow();
    await expire(rowId);
    await refresh(rowId, { refreshed: { accessToken: 'access-r', expiresIn: 3600, scope: 'read openid' } });

    const result = await remove();
    expect(revokedAtVendor).toEqual(['refresh_token:refresh-1']);
    expect(result).toEqual(expect.objectContaining({ removed: true, providerRevoked: true }));
  });

  // RFC 7009 only says a server SHOULD revoke access tokens. A vendor that
  // refuses one must not hold the row forever: the removal finishes, and the
  // person is sent to the page, which is the only place left to end the grant.
  it('a vendor that refuses to revoke the access token still lets the removal finish, without claiming the revoke', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);
    failCallbackRefreshPut();
    await sendCallback();
    connectorSecrets.put.mockRestore();
    revokedAtVendor = [];
    refuseHint = 'access_token';

    const result = await remove();
    expect(revokedAtVendor).toEqual(['refresh_token:refresh-1']);
    expect(result).toEqual(expect.objectContaining({
      removed: true,
      providerRevoked: false,
      revokeAt: ENTRY.revoke.page,
    }));
    expect(await Integration.findById(rowId).lean()).toBeNull();
  });

  // The mark tells a retry the vendor is done. On a mixed pair the vendor
  // never confirmed the grant ended, so a removal that stops in its sweep
  // must leave no mark that a retry would read as `providerRevoked: true`.
  it('a mixed pair whose sweep fails leaves no provider-revoked mark for the retry to claim', async () => {
    const rowId = await seedConnectedRow();
    await startReconnect(rowId);
    failCallbackRefreshPut();
    await sendCallback();
    connectorSecrets.put.mockRestore();

    const failDelete = jest.spyOn(Integration, 'findByIdAndDelete').mockRejectedValueOnce(new Error('db down'));
    const first = await remove();
    expect(first).toEqual(expect.objectContaining({
      removed: false,
      code: 'provider_revoked_removal_incomplete',
      providerRevoked: false,
    }));
    expect((await Integration.findById(rowId).lean()).config[PROVIDER_REVOKED_MARK]).toBeFalsy();
    failDelete.mockRestore();

    const retry = await remove();
    expect(retry).toEqual(expect.objectContaining({ removed: true, providerRevoked: false }));
  });
});
