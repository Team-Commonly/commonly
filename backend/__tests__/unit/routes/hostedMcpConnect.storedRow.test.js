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
  revoke: 'https://mcp.linear.app/token',
  tools: [],
};

jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return { HOSTED_MCP_ENTRIES: [FIXTURE_ENTRY], findHostedMcpEntry: actual.findHostedMcpEntry };
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
  app = express();
  app.use('/connect/hosted-mcp', require('../../../routes/hostedMcpConnect'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

/** A pending row for `state`, as the start route would have left it. */
const seedPending = async ({ state, subject, credentialRef = 'ref-old' }) => {
  const row = await Integration.create({
    type: 'hosted-mcp',
    podId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
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
  intake.discoverAuthorizationServer.mockResolvedValue({ token_endpoint: TOKEN_ENDPOINT });
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

test('a vendor that DOES issue a subject stores it — the clear is not unconditional', async () => {
  const id = await seedPending({ state: 'st-keep', subject: 'acct-old' });
  exchange({ idToken: idToken('acct-new') });

  expect((await callback('st-keep')).status).toBe(302);
  expect((await stored(id)).providerSubject).toBe('acct-new');
});
