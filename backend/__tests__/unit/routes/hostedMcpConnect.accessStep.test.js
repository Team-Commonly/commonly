// D248: the callback's access step, in its own file so its callbacks stay
// clear of the main callback file's per-IP rate limit (60 a window).
// Harness copied from hostedMcpConnect.callback.test.js.
// TASK-172 slice 3: the callback. The vendor is a stub and the row is a mock,
// so every arm here is about the DECISION the callback makes — which state it
// will spend, what it does with a subject that changed, and what it leaves on
// the row — rather than about Linear.
// TASK-253: production vendor requests go through the outbound guard
// (services/hostedVendorFetch). These arms stub the vendor at global.fetch, so
// the guarded transport is mapped back to it, read at call time; the guard's
// own rules are tested in outboundUrlGuard.vendorEndpoint.test.js.
jest.mock('../../../services/hostedVendorFetch', () => ({
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  hostedVendorFetch: (...args) => global.fetch(...args),
}));

const FIXTURE_ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  revoke: { page: 'https://linear.app/settings/security' },
  tools: [],
};

jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return {
    HOSTED_MCP_ENTRIES: [FIXTURE_ENTRY],
    findHostedMcpEntry: actual.findHostedMcpEntry,
    // The callback copies this off the entry onto the row, so the partial mock
    // has to carry it: an unforwarded accessor reads as `undefined` and throws
    // at the write rather than at the import.
    hostedMcpRevokeTarget: actual.hostedMcpRevokeTarget,
  };
});

jest.mock('../../../services/hostedMcpIntakeService', () => {
  const actual = jest.requireActual('../../../services/hostedMcpIntakeService');
  return { ...actual, discoverAuthorizationServer: jest.fn() };
});

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../../services/hostedMcpDcrRegistry', () => ({
  ensureDcrClient: jest.fn(),
  dcrClientForRow: jest.fn(),
  refuseDcrClient: jest.fn(),
  // The real classifier: which refusals mean the vendor doesn't know the client.
  refusalNamesUnknownClient: jest.requireActual('../../../services/hostedMcpDcrRegistry').refusalNamesUnknownClient,
}));

jest.mock('../../../services/connectorSecrets', () => ({
  put: jest.fn(),
  get: jest.fn(),
  revoke: jest.fn(),
}));

jest.mock('../../../services/roomGrantService', () => ({
  revokeConnectionGrants: jest.fn(),
}));

jest.mock('../../../services/hostedMcpToolDefinitions', () => ({
  forgetHostedMcpDrift: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const connectRoutes = require('../../../routes/hostedMcpConnect');
const Integration = require('../../../models/Integration');
const connectorSecrets = require('../../../services/connectorSecrets');
const intake = require('../../../services/hostedMcpIntakeService');

const app = express();
app.use('/connect/hosted-mcp', connectRoutes);

const TOKEN_ENDPOINT = 'https://mcp.linear.app/token';
const idToken = (sub) => [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub })).toString('base64url'),
  'sig',
].join('.');

const BROWSER_COOKIE = 'commonly_hosted_mcp_nonce=browser-1';

const callback = (query = 'state=st-1&code=code-1', cookie = BROWSER_COOKIE, entryId = 'linear') => {
  const sent = request(app).get(`/connect/hosted-mcp/${entryId}/callback?${query}`);
  // The browser that started the flow sends this; `null` is the browser that
  // did not, which is the whole point of the cookie.
  return cookie === null ? sent : sent.set('Cookie', cookie);
};

/**
 * A row as the database would hand it back on a reconnect.
 *
 * The argument is a set of `config` fields, because that is where the
 * credential half actually lives: `config` is a strict subdocument, and a
 * fixture that spread `credentialRef` across the top level would let the
 * handler read the wrong shape and still look green (measured 2026-09-28 —
 * the same class of miss as the unprefixed `$set` beside it).
 */
const storedRow = (config = {}) => ({
  _id: 'row-1',
  status: 'pending',
  createdBy: 'user-1',
  config: {
    entryId: 'linear',
    pendingAuth: {
      state: 'st-1',
      codeVerifier: 'verifier-1',
      expiresAt: new Date(Date.now() + 60 * 1000),
      browserNonce: 'browser-1',
    },
    ...config,
  },
});

const okTokenResponse = {
  ok: true,
  json: async () => ({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope: 'read',
    id_token: idToken('acct-1'),
  }),
};

beforeEach(() => {
  jest.clearAllMocks();
  FIXTURE_ENTRY.client = 'cimd';
  delete FIXTURE_ENTRY.revoke.endpoint;
  connectorSecrets.get.mockReset();
  connectorSecrets.put.mockReset();
  connectorSecrets.revoke.mockReset();
  intake.discoverAuthorizationServer.mockResolvedValue({
    // §3.3's required claim, so the stub matches what real discovery returns.
    issuer: 'https://mcp.linear.app',
    authorization_endpoint: 'https://mcp.linear.app/authorize',
    token_endpoint: TOKEN_ENDPOINT,
    // A revoke goes only to the endpoint the issuer advertises (TASK-252), so the
    // stub advertises the one the revoking arms pin, as the real vendors do.
    revocation_endpoint: 'https://mcp.linear.app/revoke',
  });
  connectorSecrets.put.mockResolvedValueOnce('ref-access').mockResolvedValueOnce('ref-refresh');
  global.fetch = jest.fn().mockResolvedValue(okTokenResponse);
  setStoredRow();
});

/**
 * One row, seen twice: by the lookup and by the atomic claim that hands back
 * the pre-image. Setting only the lookup would leave the claim's copy bare, and
 * an arm about what the pre-image CONTAINED would pass on the empty one.
 */
const setStoredRow = (overrides = {}) => {
  const row = storedRow(overrides);
  Integration.findOne.mockResolvedValue(row);
  Integration.findOneAndUpdate.mockReset();
  Integration.findOneAndUpdate
    .mockResolvedValueOnce(row)
    .mockResolvedValueOnce({ _id: 'row-1' })
    .mockResolvedValueOnce({ _id: 'row-1' });
};

const outcome = (res) => {
  const url = new URL(res.headers.location, 'https://commonly.me');
  const result = {
    status: res.status,
    hostedMcp: url.searchParams.get('hostedMcp'),
    code: url.searchParams.get('code'),
  };
  const entryId = url.searchParams.get('entryId');
  const revokeAt = url.searchParams.get('revokeAt');
  const extraScopes = url.searchParams.getAll('extraScope');
  const next = url.searchParams.get('next');
  if (next) result.next = next;
  if (entryId) result.entryId = entryId;
  if (revokeAt) result.revokeAt = revokeAt;
  if (extraScopes.length) result.extraScopes = extraScopes;
  return result;
};

describe('hosted-mcp connect: callback access step (D248)', () => {
  // D248: a connection that still has nothing to reach (GitHub with no App
  // installation) goes straight on to the entry's access page.
  describe('access setup after connecting', () => {
    afterEach(() => {
      delete FIXTURE_ENTRY.accessPage;
      delete FIXTURE_ENTRY.needsAccessSetup;
    });

    it('sends the page on to the access step when the entry says nothing is reachable yet', async () => {
      FIXTURE_ENTRY.accessPage = 'https://github.com/apps/commonly-connect/installations/new';
      FIXTURE_ENTRY.needsAccessSetup = jest.fn().mockResolvedValue(true);
      const res = await callback();
      expect(outcome(res)).toEqual({
        status: 302, hostedMcp: 'connected', code: null, entryId: 'linear', next: 'access',
      });
      expect(FIXTURE_ENTRY.needsAccessSetup).toHaveBeenCalledWith('access-1');
    });

    it('lands on the connectors page as before when access is already set up', async () => {
      FIXTURE_ENTRY.accessPage = 'https://github.com/apps/commonly-connect/installations/new';
      FIXTURE_ENTRY.needsAccessSetup = jest.fn().mockResolvedValue(false);
      expect(outcome(await callback())).toEqual({ status: 302, hostedMcp: 'connected', code: null });
    });

    it('a failed check still reports the connection, without the access step', async () => {
      FIXTURE_ENTRY.accessPage = 'https://github.com/apps/commonly-connect/installations/new';
      FIXTURE_ENTRY.needsAccessSetup = jest.fn().mockRejectedValue(new Error('timeout'));
      expect(outcome(await callback())).toEqual({ status: 302, hostedMcp: 'connected', code: null });
      // "Still reports connected" holds only if the pair was stored first: the
      // check runs after both puts and the publishing row write, never before.
      expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
      expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(3);
      const checkedAt = FIXTURE_ENTRY.needsAccessSetup.mock.invocationCallOrder[0];
      const lastWrite = Math.max(
        ...connectorSecrets.put.mock.invocationCallOrder,
        ...Integration.findOneAndUpdate.mock.invocationCallOrder,
      );
      expect(checkedAt).toBeGreaterThan(lastWrite);
    });

    // A reconnect whose old grant only the person can withdraw returns early
    // with the revoke page; the access step rides along on the same redirect.
    describe('on a reconnect that names the revoke page', () => {
      // An old pair with no recorded subject: the accounts cannot be compared,
      // so the old token is never sent and the page is the only recovery.
      const uncomparableReconnect = () => setStoredRow({
        credentialRef: 'ref-old-access',
        refreshTokenRef: 'ref-old-refresh',
      });

      it('also sends the page on to the access step when nothing is reachable yet', async () => {
        FIXTURE_ENTRY.accessPage = 'https://github.com/apps/commonly-connect/installations/new';
        FIXTURE_ENTRY.needsAccessSetup = jest.fn().mockResolvedValue(true);
        uncomparableReconnect();
        expect(outcome(await callback())).toEqual({
          status: 302,
          hostedMcp: 'connected',
          code: null,
          entryId: 'linear',
          revokeAt: FIXTURE_ENTRY.revoke.page,
          next: 'access',
        });
        expect(FIXTURE_ENTRY.needsAccessSetup).toHaveBeenCalledWith('access-1');
      });

      it('names only the revoke page when access is already set up', async () => {
        FIXTURE_ENTRY.accessPage = 'https://github.com/apps/commonly-connect/installations/new';
        FIXTURE_ENTRY.needsAccessSetup = jest.fn().mockResolvedValue(false);
        uncomparableReconnect();
        expect(outcome(await callback())).toEqual({
          status: 302,
          hostedMcp: 'connected',
          code: null,
          entryId: 'linear',
          revokeAt: FIXTURE_ENTRY.revoke.page,
        });
      });
    });

    it('never asks without an access page to send the person to', async () => {
      FIXTURE_ENTRY.needsAccessSetup = jest.fn().mockResolvedValue(true);
      expect(outcome(await callback())).toEqual({ status: 302, hostedMcp: 'connected', code: null });
      expect(FIXTURE_ENTRY.needsAccessSetup).not.toHaveBeenCalled();
    });
  });

  // D248 (a): GitHub's "Install & Authorize" returns to this callback with
  // `code`, `installation_id` and `setup_action`, and no state of ours. The
  // walk on 11-04 showed "This connection attempt expired" after an install
  // that worked. It is an install outcome, not a failed connect, and its code
  // is never redeemed: with no state there is no way to tie it to the person.
  describe('a return from installing the App', () => {
    const ACCESS = 'https://github.com/apps/commonly-connect/installations/new';
    beforeEach(() => { FIXTURE_ENTRY.accessPage = ACCESS; });
    afterEach(() => { delete FIXTURE_ENTRY.accessPage; });

    it.each(['install', 'update'])('setup_action=%s with no state lands as installed, redeeming nothing', async (action) => {
      const res = await callback(`code=code-1&installation_id=123456&setup_action=${action}`, null);
      expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'installed', code: null, entryId: 'linear' });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(Integration.findOne).not.toHaveBeenCalled();
      expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('a vendor error wins over install parameters on the same return', async () => {
      const res = await callback('error=access_denied&setup_action=install&installation_id=1', null);
      expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'consent_denied' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('a stateless return that is not an install is still refused', async () => {
      expect(outcome(await callback('code=code-1', null)))
        .toEqual({ status: 302, hostedMcp: 'error', code: 'invalid_state' });
    });

    it('an installation id that is not a number is refused', async () => {
      expect(outcome(await callback('code=code-1&installation_id=12x&setup_action=install', null)))
        .toEqual({ status: 302, hostedMcp: 'error', code: 'invalid_state' });
    });

    it('an entry with no install page is refused, so no other vendor can claim the outcome', async () => {
      delete FIXTURE_ENTRY.accessPage;
      expect(outcome(await callback('code=code-1&installation_id=123456&setup_action=install', null)))
        .toEqual({ status: 302, hostedMcp: 'error', code: 'invalid_state' });
    });

    it('a return that does carry our state finishes the connect as usual', async () => {
      const res = await callback('state=st-1&code=code-1&installation_id=123456&setup_action=install');
      expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'connected', code: null });
    });
  });
});
