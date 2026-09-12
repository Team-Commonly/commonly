/**
 * B1 leak matrix — the ratchet. Mounts every suite's routers in one app and
 * replays each KNOWN_EXPOSURES entry against a freshly seeded world. If an
 * allowlisted exposure no longer reproduces (the leak was fixed, the route now
 * refuses, or the case it names no longer exists), this fails with "remove
 * this entry from KNOWN_EXPOSURES", so the list can only shrink.
 *
 * It lives in one file because jest isolates modules per test file: the
 * per-suite files cannot see each other's results. It also holds the list's
 * own contract (sorted, duplicate-free, reasoned) and the pure case rules.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) and is pulled in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);
// Same network backstop as leakMatrix.webhooks.test.js, so a replayed webhook case sees the same world.
jest.mock('axios', () => require('../../utils/leakMatrix').axiosMock);

const fs = require('fs');
const {
  ACCESS_2XX, KNOWN_EXPOSURES, assertKnownExposuresStillLeak, caseProblems, connectMemoryMongo,
  disconnectMemoryMongo, exposureSortKey,
} = require('../../utils/leakMatrix');
const { SUITES } = require('../../utils/leakMatrixSuites');

describe('KNOWN_EXPOSURES list contract', () => {
  test('is sorted by (path, variant, method, role, sentinelKey) and duplicate-free', () => {
    const keys = KNOWN_EXPOSURES.map(exposureSortKey);
    const misplaced = keys
      .map((key, i) => (i > 0 && !(keys[i - 1] < key) ? `${keys[i - 1]}  >=  ${key}` : null))
      .filter(Boolean);
    expect(misplaced).toEqual([]);
  });

  test('every entry is a complete tuple with a reason', () => {
    const incomplete = KNOWN_EXPOSURES
      .filter((e) => !e.method || !e.path || !e.role || !e.sentinelKey || !e.reason)
      .map(exposureSortKey);
    expect(incomplete).toEqual([]);
  });

  test('every suite has its own matrix file, and the ratchet replays every suite', () => {
    const files = fs.readdirSync(__dirname)
      .map((f) => /^leakMatrix\.(.+)\.test\.js$/.exec(f))
      .filter(Boolean)
      .map((m) => m[1])
      .filter((name) => name !== 'ratchet')
      .sort();
    expect(files).toEqual(Object.keys(SUITES).sort());
  });
});

describe('caseProblems: subtraction and ACCESS_2XX rules', () => {
  const c = { method: 'GET', path: '/x', role: 'stranger', expect: 200, refuse: true };
  const leakCase = { method: 'GET', path: '/y', role: 'owner', expect: 200 };
  const entry = (over) => ({ method: 'GET', path: '/x', role: 'stranger', reason: 'r', ...over });

  test('a refuse case answering 2xx with no ACCESS_2XX entry fails', () => {
    expect(caseProblems(c, 200, [], { known: [], allowed: [] }))
      .toEqual([`answered 200 to a role that must get 401/403 — unlisted ${ACCESS_2XX}`]);
  });

  test('a refuse case answering 2xx is accepted when pinned as ACCESS_2XX', () => {
    expect(caseProblems(c, 200, [], { known: [entry({ sentinelKey: ACCESS_2XX })], allowed: [] })).toEqual([]);
  });

  test('ACCESS_2XX does not excuse a body leak on the same case', () => {
    expect(caseProblems(c, 200, ['K'], { known: [entry({ sentinelKey: ACCESS_2XX })], allowed: [] }))
      .toEqual(['unexpected sentinel K in 2xx body']);
  });

  test('a refused case only checks its status pin', () => {
    expect(caseProblems({ ...c, expect: 403 }, 403, ['K'], { known: [], allowed: [] })).toEqual([]);
    expect(caseProblems({ ...c, expect: 403 }, 200, [], { known: [], allowed: [] })[0]).toBe('status 200, pinned 403');
  });

  test('a listed leak passes, an unlisted one fails', () => {
    const known = [{ method: 'GET', path: '/y', role: 'owner', sentinelKey: 'A', reason: 'r' }];
    expect(caseProblems(leakCase, 200, ['A'], { known, allowed: [] })).toEqual([]);
    expect(caseProblems(leakCase, 200, ['A', 'B'], { known, allowed: [] })).toEqual(['unexpected sentinel B in 2xx body']);
  });
});

describe('ratchet', () => {
  let mongod;

  beforeAll(async () => {
    mongod = await connectMemoryMongo();
  });

  afterAll(async () => {
    await disconnectMemoryMongo(mongod);
  });

  // Replays every suite's world in one test: ~9s alone, but past jest's 30s
  // default under the parallel full-suite run, so it carries its own budget.
  test('every KNOWN_EXPOSURES entry still reproduces (fixing one forces the list to shrink)', async () => {
    const problems = await assertKnownExposuresStillLeak(Object.values(SUITES));
    expect(problems).toEqual([]);
  }, 120_000);
});
