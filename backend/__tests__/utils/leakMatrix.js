/**
 * B1 leak matrix — shared harness.
 *
 * Every credential-bearing field is seeded with a unique, greppable SENTINEL
 * string (hashes included: a tokenHash is server-internal and must not leave
 * the server either). Each (route, role) case calls the real route through
 * supertest, then searches the serialized 2xx body for every sentinel. A
 * sentinel in a 2xx body is a leak.
 *
 * Known leaks on main are NOT skipped silently: they are listed in
 * KNOWN_EXPOSURES as exact (method, path, role, sentinelKey) tuples. The matrix
 * subtracts only those, so any other sentinel still fails. The ratchet test
 * (leakMatrix.ratchet.test.js) replays every entry and fails when an entry no
 * longer reproduces, so a fix forces this list to shrink.
 *
 * This file lives under __tests__/utils/ because jest's default testMatch
 * collects every .js under __tests__/ regardless of suffix, and utils/ is the
 * one directory jest.config.js ignores as tests.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');

const SENTINEL_SUFFIX = '7f3a';
const sentinelValue = (key) => `SENTINEL_${key}_${SENTINEL_SUFFIX}`;

/**
 * A sentinel registry for one seeded world: `s('INT_TELEGRAM_BOTTOKEN')`
 * returns the value and records it. `s.all` maps key -> value.
 */
const createSentinels = () => {
  const all = {};
  const s = (key) => {
    if (all[key]) throw new Error(`duplicate sentinel key ${key}`);
    all[key] = sentinelValue(key);
    return all[key];
  };
  s.all = all;
  return s;
};

/** Keys of every sentinel that appears anywhere in the response. */
const findSentinels = (res, sentinels) => {
  const haystack = `${JSON.stringify(res.body)}\n${res.text || ''}`;
  return Object.keys(sentinels).filter((key) => haystack.includes(sentinels[key])).sort();
};

// ---------------------------------------------------------------------------
// Auth mocks. Wired from each test file with
//   jest.mock('<path>/middleware/auth', () => require('<path>/utils/leakMatrix').authMock)
// ---------------------------------------------------------------------------

/**
 * Human identity from `x-test-user`, shaped like the JWT branch of
 * middleware/auth.ts: `req.user = { id }`, `req.userId = id`,
 * `req.authType = 'jwt'` (routes/auth.ts requireBrowserJwt reads authType).
 * No header -> 401. adminAuth stays REAL, so admin is a real role:'admin' row.
 */
const authMock = (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ msg: 'No token, authorization denied' });
  req.user = { id };
  req.userId = id;
  req.authType = 'jwt';
  return next();
};

/**
 * Agent identity from `x-test-agent` (a real bot User row id). Mirrors the
 * User-row-token branch of middleware/agentRuntimeAuth.ts: loads the bot User,
 * its active AgentInstallations by (agentName, instanceId), and derives
 * agentAuthorizedPodIds from them. Only the token lookup itself is skipped.
 */
const agentRuntimeAuthMock = async (req, res, next) => {
  const id = req.get('x-test-agent');
  if (!id) return res.status(401).json({ message: 'Missing agent token' });
  try {
    // eslint-disable-next-line global-require
    const User = require('../../models/User');
    // eslint-disable-next-line global-require
    const { AgentInstallation } = require('../../models/AgentRegistry');
    const agentUser = await User.findById(id);
    if (!agentUser) return res.status(401).json({ message: 'Invalid agent token' });
    const agentName = String(agentUser.botMetadata?.agentName || '').toLowerCase();
    const instanceId = agentUser.botMetadata?.instanceId || 'default';
    const installations = await AgentInstallation.find({ agentName, instanceId, status: 'active' }).lean();
    req.agentUser = agentUser;
    req.agentInstallations = installations;
    req.agentInstallation = installations[0] || null;
    req.agentAuthorizedPodIds = installations.map((inst) => String(inst.podId));
    return next();
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * ToolCall is Postgres-backed; mocked at the module boundary as
 * grants.read.test.js does. The row carries an `args` field holding a
 * sentinel: the broker never stores arguments, and the trail route must not
 * serialize them even if a row somehow did.
 */
const TOOLCALL_ARGS_SENTINEL_KEY = 'TOOLCALL_ARGS';
const toolCallMock = {
  listForGrant: async (grantId) => [{
    callId: 'call-leak-1',
    grantId,
    podId: 'p',
    installationId: 'install-1',
    agentUserId: 'seat',
    tool: 'github.list_issues',
    argsDigest: 'a'.repeat(64),
    at: new Date('2026-09-11T04:00:00.000Z'),
    outcome: 'ok',
    durationMs: 120,
    args: { token: sentinelValue(TOOLCALL_ARGS_SENTINEL_KEY) },
  }],
  countsForGrant: async () => ({ total: 1, ok: 1, refused: 0, pending_approval: 0, failed: 0 }),
  digestArgs: () => 'a'.repeat(64),
  reserveBudgetLineage: async () => ({ ok: true }),
};

/**
 * Network backstop for suites whose routes construct a DiscordService: no
 * request leaves the process. Wired with
 *   jest.mock('axios', () => require('<path>/utils/leakMatrix').axiosMock)
 * GET answers a fixed channel list that carries no credential (it never echoes
 * the Authorization header). DiscordService itself stays REAL: a stubbed
 * service returning channels would fabricate the status the case measures.
 * Plain functions, not jest.fn: jest.config sets restoreMocks.
 */
const axiosMock = (() => {
  const refuse = async () => { throw new Error('leak matrix: network disabled'); };
  const stub = {
    get: async () => ({ status: 200, data: [{ id: 'chan-1', name: 'general', type: 0, topic: '', position: 0 }] }),
    post: refuse,
    put: refuse,
    patch: refuse,
    delete: refuse,
    request: refuse,
    isAxiosError: () => false,
    interceptors: { request: { use: () => 0 }, response: { use: () => 0 } },
    defaults: { headers: { common: {} } },
  };
  stub.create = () => stub;
  stub.default = stub;
  return stub;
})();

// ---------------------------------------------------------------------------
// Disclosures that are intended, and exposures that are known.
// ---------------------------------------------------------------------------

/**
 * Intended disclosures — not leaks. config.connectCode is the one-time enable
 * code a Telegram connector's owner pastes into Telegram. It is allowed exactly
 * where a frontend surface reads it, and nowhere else:
 *  - GET /api/integrations/:podId (owner/member/admin): ChatRoom's pod
 *    integrations list (frontend/src/components/ChatRoom.tsx:957, :1184 fetch;
 *    :1395 reads existingIntegration.config.connectCode). A stranger is 403.
 *  - GET /api/installables (owner): the Connectors page builds each catalog
 *    row's connector from entry.integration (V2ConnectorsPage.tsx:215 fetch,
 *    :782-790 connectorForEntry, :794-799 items) and reads connectCode in
 *    codeIsLive / the aside (:154-157, :1097-1099).
 *  - GET /api/integrations/user/all (owner): the same page's legacy and
 *    catalog-unavailable rows (V2ConnectorsPage.tsx:212 fetch, :217,
 *    :802-805), read by the same :154-157 / :1097-1099 code.
 * Telegram only: those reads sit behind isTelegram (:601, :1089). A Slack row's
 * config.connectCode is its OAuth state (routes/installables.ts:278), never read
 * by the frontend, so it stays a KNOWN_EXPOSURE. /api/integrations/admin/all
 * (AppsManagement.tsx:153) never reads connectCode.
 */
const ALLOWED_DISCLOSURES = [
  ...['owner', 'member', 'admin'].map((role) => ({
    method: 'GET', path: '/api/integrations/:podId', role, sentinelKey: 'INT_TELEGRAM_CONNECTCODE',
  })),
  { method: 'GET', path: '/api/installables', role: 'owner', sentinelKey: 'INST_TELEGRAM_CONNECTCODE' },
  { method: 'GET', path: '/api/integrations/user/all', role: 'owner', sentinelKey: 'INT_TELEGRAM_CONNECTCODE' },
];

/**
 * An access exposure: a role that must be refused (401/403) gets a 2xx. It is
 * listed with this literal in place of a sentinel key. The case keeps
 * `expect` at today's 2xx and carries `refuse: true`; the ratchet checks the
 * case still answers 2xx, so the entry must go when the route starts refusing.
 */
const ACCESS_2XX = 'ACCESS_2XX';

/**
 * Leaks that reproduce on main today, sorted by (path, variant, method, role,
 * sentinelKey). Each entry is an exact (method, path, role, sentinelKey) tuple
 * observed in a real 2xx body, or an ACCESS_2XX tuple. The matrix fails on any
 * leak not listed; the ratchet fails on any entry that no longer reproduces,
 * so the list only shrinks. Remove an entry when its fix lands.
 */
const KNOWN_EXPOSURES = [];

// `variant` distinguishes two cases on one route template (a pod grant vs a
// seat grant on GET /api/grants/:grantId); an entry must name it to match.
const sameCase = (entry, c) => entry.method === c.method && entry.path === c.path && entry.role === c.role
  && (entry.variant || null) === (c.variant || null);
const keysFor = (list, c) => list.filter((e) => sameCase(e, c)).map((e) => e.sentinelKey);

/** The order KNOWN_EXPOSURES must be written in; also its uniqueness key. */
const exposureSortKey = (e) => [e.path, e.variant || '', e.method, e.role, e.sentinelKey].join('\u0000');
const entryName = (e) => `${e.method} ${e.path}${e.variant ? ` [${e.variant}]` : ''} as ${e.role} (${e.sentinelKey})`;

const is2xx = (status) => status >= 200 && status < 300;

/**
 * Everything wrong with one case's result, as readable strings. Pure, so the
 * ACCESS_2XX and subtraction rules are testable without a route. `lists`
 * defaults to the real ALLOWED_DISCLOSURES / KNOWN_EXPOSURES.
 */
const caseProblems = (c, status, found, lists = {}) => {
  const allowedList = lists.allowed || ALLOWED_DISCLOSURES;
  const knownList = lists.known || KNOWN_EXPOSURES;
  const problems = [];
  if (status !== c.expect) problems.push(`status ${status}, pinned ${c.expect}`);
  if (!is2xx(status)) return problems; // refused: recorded by the status pin above
  const known = keysFor(knownList, c);
  if (c.refuse && !known.includes(ACCESS_2XX)) {
    problems.push(`answered ${status} to a role that must get 401/403 — unlisted ${ACCESS_2XX}`);
  }
  const allowed = new Set([...keysFor(allowedList, c), ...known]);
  found.filter((key) => !allowed.has(key)).forEach((key) => problems.push(`unexpected sentinel ${key} in 2xx body`));
  return problems;
};

// ---------------------------------------------------------------------------
// Store helpers.
// ---------------------------------------------------------------------------

const connectMemoryMongo = async () => {
  // eslint-disable-next-line global-require
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  return mongod;
};

const disconnectMemoryMongo = async (mongod) => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
};

const clearStore = async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((col) => col.deleteMany({})));
};

/** Every raw document in the store, serialized — the positive control. */
const rawStoreText = async () => {
  const collections = await mongoose.connection.db.collections();
  const dumps = await Promise.all(collections.map((col) => col.find({}).toArray()));
  return JSON.stringify(dumps);
};

// ---------------------------------------------------------------------------
// Matrix execution.
// ---------------------------------------------------------------------------

const buildApp = (suites) => {
  const app = express();
  app.use(express.json());
  suites.forEach((suite) => suite.mount(app));
  return app;
};

const caseName = (c) => `${c.method} ${c.path}${c.variant ? ` [${c.variant}]` : ''} as ${c.role}`;
const caseKey = (c) => `${c.method} ${c.path}${c.variant ? ` [${c.variant}]` : ''}`;

const runCase = async (app, ctx, c) => {
  const identity = ctx.identities[c.role];
  if (!identity) throw new Error(`suite has no identity for role ${c.role}`);
  // An identity is { user } (human), { agent } (bot User row), { bearer } (a
  // raw Authorization bearer checked by the route's REAL middleware, e.g. a
  // cm_daemon_ token), or {} (anonymous: no credential at all).
  let req = request(app)[c.method.toLowerCase()](c.url(ctx));
  if (identity.user) req = req.set('x-test-user', String(identity.user));
  if (identity.agent) {
    // dualAuth routes pick agentRuntimeAuth only for a cm_agent_ bearer.
    req = req.set('x-test-agent', String(identity.agent)).set('Authorization', 'Bearer cm_agent_leakmatrix');
  }
  if (identity.bearer) req = req.set('Authorization', `Bearer ${identity.bearer}`);
  const res = await req;
  return { status: res.status, found: findSentinels(res, ctx.sentinels), res };
};

/**
 * Defines one describe block for a suite: a positive control proving the
 * sentinels are really in the store, then one test per (route, role) case.
 * Each case also pins its expected status, so a harness break that turns
 * every call into a 500 cannot pass vacuously.
 */
const defineLeakMatrix = (suite) => {
  describe(`leak matrix: ${suite.name}`, () => {
    let mongod;
    let app;
    let ctx;

    beforeAll(async () => {
      mongod = await connectMemoryMongo();
      app = buildApp([suite]);
      ctx = await suite.seed();
    });

    afterAll(async () => {
      await disconnectMemoryMongo(mongod);
    });

    test(`${suite.name}: every seeded sentinel is actually in the store (positive control)`, async () => {
      const raw = await rawStoreText();
      const boundary = new Set(ctx.boundarySentinels || []);
      const missing = Object.keys(ctx.sentinels).filter((key) => !boundary.has(key) && !raw.includes(ctx.sentinels[key]));
      expect(missing).toEqual([]);
    });

    suite.cases.forEach((c) => {
      const name = caseName(c).replace(/ as (.*)$/, ' as $1 leaks no credential');
      test(name, async () => {
        const { status, found } = await runCase(app, ctx, c);
        const problems = caseProblems(c, status, found);
        expect({ case: caseName(c), problems }).toEqual({ case: caseName(c), problems: [] });
      });
    });
  });
};

/**
 * The ratchet: every KNOWN_EXPOSURES entry must name a real matrix case and
 * still reproduce — a sentinel entry must still leak its sentinel in a 2xx
 * body; an ACCESS_2XX entry must name a `refuse` case that still answers 2xx.
 * Replays each entry against a freshly seeded world for its suite.
 */
const assertKnownExposuresStillLeak = async (suites, known = KNOWN_EXPOSURES) => {
  const app = buildApp(suites);
  const problems = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const suite of suites) {
    const entries = known.filter((e) => suite.cases.some((c) => sameCase(e, c)));
    if (!entries.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await clearStore();
    // eslint-disable-next-line no-await-in-loop
    const ctx = await suite.seed();
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of entries) {
      const c = suite.cases.find((candidate) => sameCase(entry, candidate));
      // eslint-disable-next-line no-await-in-loop
      const { status, found } = await runCase(app, ctx, c);
      if (entry.sentinelKey === ACCESS_2XX) {
        if (!c.refuse) {
          problems.push(`${entryName(entry)} names a case not marked refuse: true — mark the case or drop the entry`);
        } else if (!is2xx(status)) {
          problems.push(`${entryName(entry)} no longer answers 2xx (status ${status}) — remove this entry from KNOWN_EXPOSURES`);
        }
      } else if (!is2xx(status) || !found.includes(entry.sentinelKey)) {
        problems.push(`${entryName(entry)} no longer leaks (status ${status}) — remove this entry from KNOWN_EXPOSURES`);
      }
    }
  }
  const orphans = known.filter((e) => !suites.some((suite) => suite.cases.some((c) => sameCase(e, c))));
  orphans.forEach((e) => problems.push(`${entryName(e)} matches no matrix case — remove this entry from KNOWN_EXPOSURES`));
  return problems;
};

module.exports = {
  ACCESS_2XX,
  ALLOWED_DISCLOSURES,
  KNOWN_EXPOSURES,
  SENTINEL_SUFFIX,
  TOOLCALL_ARGS_SENTINEL_KEY,
  agentRuntimeAuthMock,
  assertKnownExposuresStillLeak,
  axiosMock,
  authMock,
  buildApp,
  caseKey,
  caseName,
  caseProblems,
  entryName,
  exposureSortKey,
  clearStore,
  connectMemoryMongo,
  createSentinels,
  defineLeakMatrix,
  disconnectMemoryMongo,
  findSentinels,
  rawStoreText,
  runCase,
  sentinelValue,
  toolCallMock,
};
