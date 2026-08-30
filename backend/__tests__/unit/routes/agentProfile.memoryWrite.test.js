/**
 * The public agent profile is mounted WITHOUT auth (see the file header of
 * routes/agentProfile.ts), so it may report THAT an agent saved and when —
 * never WHICH section. The owner/admin memory view keeps the exact section;
 * both derive from the same max() over AGENT_WRITABLE_SECTIONS.
 */

jest.mock('../../../models/User', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
// Keep the real AGENT_WRITABLE_SECTIONS — the selection rule under test reads
// it — and stub only the query.
jest.mock('../../../models/AgentMemory', () => ({
  ...jest.requireActual('../../../models/AgentMemory'),
  findOne: jest.fn(),
}));
jest.mock('../../../models/AgentRun', () => ({ find: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({ find: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({}));
// #1336 added AgentProfile + a .sort() on the installation chain; this
// suite's mocks predate both (main went red on merge — the author updated
// the sibling suites' mocks but not this one).
jest.mock('../../../models/AgentProfile', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
  AgentRegistry: { findOne: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentDisplayLabel: jest.fn((u, f) => f),
  syncUserToPostgreSQL: jest.fn(),
}));
jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => next()));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const AgentMemory = require('../../../models/AgentMemory');
const AgentRun = require('../../../models/AgentRun');
const PodAsset = require('../../../models/PodAsset');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const router = require('../../../routes/agentProfile');

// The route swallows handler errors into a 500. Capture what it logged so a
// wiring failure names itself instead of arriving as a passing "no section
// name" assertion on an empty body.
let handlerError;
jest.spyOn(console, 'error').mockImplementation((...args) => { handlerError = args; });

const getHandler = (method, path) => {
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === path && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} handler not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const response = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const lean = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
const selectLean = (value) => ({ select: jest.fn().mockReturnValue(lean(value)) });

const UPDATED_AT = new Date('2026-08-26T10:00:00Z');

const runProfile = async (sections) => {
  User.findOne.mockReturnValue(selectLean({
    _id: 'agent-user', username: 'observer', isBot: true, profilePicture: 'default',
    botMetadata: { agentName: 'claude-code', instanceId: 'observer', capabilities: [] },
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }));
  PodAsset.find.mockReturnValue(selectLean([]));
  // Route chain is find().sort().select().lean() since #1336.
  AgentInstallation.find.mockReturnValue({ sort: () => selectLean([]) });
  Pod.find.mockReturnValue(selectLean([]));
  AgentMemory.findOne.mockReturnValue(selectLean({ sections }));
  AgentRun.find.mockReturnValue({
    sort: () => ({ limit: () => selectLean([]) }),
  });

  const res = response();
  await getHandler('get', '/:agentName/:instanceId?')(
    { params: { agentName: 'claude-code', instanceId: 'observer' }, query: {} },
    res,
  );
  if (res.statusCode !== 200) {
    throw new Error(`handler ${res.statusCode}: ${JSON.stringify(handlerError)}`);
  }
  return res;
};

describe('GET /:agentName/:instanceId — last agent write', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports a durable write as a kind, without the section name', async () => {
    const res = await runProfile({
      long_term: { content: 'durable decision', updatedAt: UPDATED_AT },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.memory.lastAgentWrite).toEqual({ kind: 'durable', updatedAt: UPDATED_AT });
  });

  it('reports a housekeeping write as bookkeeping, without the section name', async () => {
    const res = await runProfile({
      runtime_meta: { content: 'runtime snapshot', updatedAt: UPDATED_AT },
    });

    expect(res.body.memory.lastAgentWrite).toEqual({ kind: 'bookkeeping', updatedAt: UPDATED_AT });
  });

  it('never emits a section name on this unauthenticated route', async () => {
    const res = await runProfile({
      dedup_state: { content: 'message ids', updatedAt: UPDATED_AT },
    });

    expect(JSON.stringify(res.body)).not.toContain('dedup_state');
    expect(Object.keys(res.body.memory.lastAgentWrite).sort()).toEqual(['kind', 'updatedAt']);
  });

  it('omits the field entirely when only automated writers have touched the envelope', async () => {
    const res = await runProfile({
      system_exchanges: { entries: [], visibility: 'private', updatedAt: UPDATED_AT },
    });

    expect(res.body.memory.lastAgentWrite).toBeNull();
  });
});
