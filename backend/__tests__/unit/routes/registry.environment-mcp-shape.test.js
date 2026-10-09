// TASK-071 / C4-SEC: an `environment.mcp` entry's shape was never validated
// where it is WRITTEN. `validateEnvironmentSpec` runs only in the CLI (an
// operator's `--environment <file>`); the write that daemons execute is
// `PATCH /api/registry/pods/:podId/agents/:name`, which merged `config`
// wholesale (Vera's premise correction, 2026-09-19), so a PATCH could store an
// entry whose fields contradict its own transport and every reader resolved it
// differently — pi's client drops the entry, its connect path resolves
// url-first.
//
// The gate Vera described is the first test here: a PATCH carrying
// `{ transport: 'http', url, command }` must come back a typed 400.
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'member-1' };
  req.userId = 'member-1';
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  updateMany: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const User = require('../../../models/User');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

const ME = 'member-1';
const STDIO_ENTRY = {
  name: 'commonly',
  transport: 'stdio',
  command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env: { COMMONLY_API_URL: '${COMMONLY_API_URL}' },
};

const installation = (over = {}) => ({
  agentName: 'openclaw',
  podId: 'pod-1',
  instanceId: 'curator',
  status: 'active',
  scopes: ['integration:read'],
  config: new Map(Object.entries({ environment: { version: 1, sandbox: { mode: 'workspace' } } })),
  installedBy: ME,
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

const setPod = (over = {}) => {
  Pod.findById.mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      _id: 'pod-1',
      createdBy: 'someone-else',
      members: [{ userId: ME }],
      ...over,
    }),
  });
};

const patch = (config, extra = {}) => request(app)
  .patch('/api/registry/pods/pod-1/agents/openclaw')
  .send({ instanceId: 'curator', config, ...extra });

// The caller is the installer here, so the installer gate is not what any of
// these assertions are about — every 400 below has to come from the shape
// check, and `save` never having run is what proves the refusal happened
// BEFORE the write rather than beside it.
describe('agent config PATCH — write-time mcp entry shape (TASK-071)', () => {
  let primary;

  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: ME, role: 'user' }) }),
    });
    primary = installation();
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
  });

  it("Vera's gate: refuses transport 'http' carrying both a url and a command, and writes nothing", async () => {
    const res = await patch({
      environment: {
        version: 1,
        mcp: [{ name: 'evil', transport: 'http', url: 'https://evil.example/mcp', command: ['sh', '-c', 'curl evil'] }],
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_environment_spec');
    expect(res.body.fields).toEqual([
      expect.objectContaining({ field: 'environment.mcp[0].command' }),
    ]);
    expect(primary.save).not.toHaveBeenCalled();
    expect(primary.config.get('environment')).toEqual({ version: 1, sandbox: { mode: 'workspace' } });
  });

  it("refuses transport 'http' with no url — a remote server with nothing to reach", async () => {
    const res = await patch({ environment: { version: 1, mcp: [{ name: 'x', transport: 'http' }] } });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual([
      expect.objectContaining({ field: 'environment.mcp[0].url' }),
    ]);
    expect(primary.save).not.toHaveBeenCalled();
  });

  it("refuses a stdio entry carrying a url — two contradictory ways to reach one server", async () => {
    const res = await patch({
      environment: { version: 1, mcp: [{ ...STDIO_ENTRY, url: 'https://evil.example/mcp' }] },
    });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual([
      expect.objectContaining({ field: 'environment.mcp[0].url' }),
    ]);
    expect(primary.save).not.toHaveBeenCalled();
  });

  it('refuses a url-only entry that declares no transport — the record every reader has to guess at', async () => {
    const res = await patch({
      environment: { version: 1, mcp: [{ name: 'x', url: 'https://remote.example/mcp' }] },
    });

    expect(res.status).toBe(400);
    // Refused twice over, and both are true of this record: there is no
    // command to run, and the url it does carry is one a stdio entry must not
    // have. Reporting only one would leave the caller fixing the other.
    expect(res.body.fields.map((e) => e.field)).toEqual([
      'environment.mcp[0].command',
      'environment.mcp[0].url',
    ]);
    expect(primary.save).not.toHaveBeenCalled();
  });

  it('refuses a string command, because no reader in this repo executes one', async () => {
    const res = await patch({
      environment: { version: 1, mcp: [{ name: 'x', transport: 'stdio', command: 'npx -y @commonlyai/mcp' }] },
    });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual([
      expect.objectContaining({ field: 'environment.mcp[0].command' }),
    ]);
    expect(primary.save).not.toHaveBeenCalled();
  });

  it('reports every offending entry at once, not the first', async () => {
    const res = await patch({
      environment: {
        version: 1,
        mcp: [
          { name: 'a', transport: 'http', command: ['sh'] },
          { name: 'b', transport: 'stdio', url: 'https://x.example/mcp', command: ['npx'] },
        ],
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.fields.map((e) => e.field)).toEqual([
      'environment.mcp[0].url',
      'environment.mcp[0].command',
      'environment.mcp[1].url',
    ]);
  });

  it("refuses an unknown transport rather than letting the reader infer one from the fields", async () => {
    // The url is deliberate: it makes the early `return` observable. Without
    // it, a fallen-through record would add the stdio url error as well, and
    // the entry would be refused for a rule it has no transport to break.
    const res = await patch({
      environment: {
        version: 1,
        mcp: [{ name: 'x', transport: 'ftp', command: ['npx'], url: 'https://x.example/mcp' }],
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.fields.map((e) => e.field)).toEqual(['environment.mcp[0].transport']);
  });

  it('accepts a well-formed stdio entry and stores it verbatim, env included', async () => {
    const res = await patch({ environment: { version: 1, mcp: [STDIO_ENTRY] } });

    expect(res.status).toBe(200);
    expect(primary.save).toHaveBeenCalledTimes(1);
    expect(primary.config.get('environment')).toEqual({ version: 1, mcp: [STDIO_ENTRY] });
  });

  it('accepts a well-formed http entry, with url and no command', async () => {
    const res = await patch({
      environment: { version: 1, mcp: [{ name: 'x', transport: 'http', url: 'https://remote.example/mcp' }] },
    });

    expect(res.status).toBe(200);
    expect(primary.save).toHaveBeenCalledTimes(1);
  });

  it('leaves a row that already holds a malformed entry patchable for its other fields', async () => {
    // The deliberate limit, pinned: only the environment this BODY declares is
    // checked, never the merged result. A legacy row must not become
    // unpatchable for its displayName because of a sibling's shape.
    primary = installation({
      config: new Map(Object.entries({
        environment: { version: 1, mcp: [{ name: 'legacy', transport: 'http', url: 'https://x.example/mcp', command: ['sh'] }] },
      })),
    });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await patch({ heartbeat: { enabled: true } }, { displayName: 'Renamed' });

    expect(res.status).toBe(200);
    expect(primary.save).toHaveBeenCalledTimes(1);
    expect(AgentProfile.updateMany).toHaveBeenCalled();
  });

  it('is unbothered by a body that does not mention the environment at all', async () => {
    const res = await patch({ heartbeat: { enabled: false } });

    expect(res.status).toBe(200);
    expect(primary.config.get('environment')).toEqual({ version: 1, sandbox: { mode: 'workspace' } });
  });
});
