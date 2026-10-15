jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn() },
}));

const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const {
  assertAgentRuntimeMayJoinPod,
  assertInstalledAgentMayJoinPod,
  runtimeTypeFromConfig,
} = require('../../../services/outsiderGrantAgentJoinPolicy');

describe('outsider-writable grant agent join policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    podHasOutsiderWritableGrant.mockResolvedValue(true);
  });

  it('refuses a non-native join with a separate-pod reason', async () => {
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'opencode')).rejects.toMatchObject({
      code: 'outsider_grant_non_native_agent_join',
      statusCode: 403,
      message: expect.stringContaining('Use a separate pod'),
    });
  });

  it('allows a native agent and a non-native agent after the grant ends', async () => {
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'native')).resolves.toBeUndefined();
    expect(podHasOutsiderWritableGrant).not.toHaveBeenCalled();
    podHasOutsiderWritableGrant.mockResolvedValue(false);
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'opencode')).resolves.toBeUndefined();
  });

  it('allows hosted on the native engine but refuses hosted on the Durable Object', async () => {
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'hosted', 'native')).resolves.toBeUndefined();
    expect(podHasOutsiderWritableGrant).not.toHaveBeenCalled();
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'hosted', 'durable-object')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'hosted')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
  });

  it('requires a live native installation for an undeclared membership writer', async () => {
    AgentInstallation.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({
        config: new Map([['runtime', { runtimeType: 'native' }]]),
      }) }),
    });
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'sample-agent', 'default')).resolves.toBeUndefined();
    expect(AgentInstallation.findOne).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1', agentName: 'sample-agent', instanceId: 'default', status: 'active',
    }));
    expect(runtimeTypeFromConfig(new Map([['runtime', { runtimeType: 'native' }]]))).toBe('native');
  });

  it('allows an installed hosted-native agent but refuses an installed Durable Object agent', async () => {
    const lean = jest.fn()
      .mockResolvedValueOnce({ config: new Map([
        ['runtime', { runtimeType: 'hosted' }], ['hosted', { engine: 'native' }],
      ]) })
      .mockResolvedValueOnce({ config: new Map([
        ['runtime', { runtimeType: 'hosted' }], ['hosted', { engine: 'durable-object' }],
      ]) });
    AgentInstallation.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean }) });
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).resolves.toBeUndefined();
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
    expect(AgentInstallation.findOne.mock.results[0].value.select).toHaveBeenCalledWith('config');
  });

  // Rhea on #2236 (a600bf3d): an unfinished TASK-265 migration is not native
  // for joins, on either the installed-agent path or the engine string the
  // other join sites pass (hostedEngineInEffect).
  it('refuses an agent whose migration is unfinished and allows it once done', async () => {
    // eslint-disable-next-line global-require
    const { hostedEngineInEffect } = require('../../../services/hostedEngine');
    const migrated = (state) => new Map([
      ['runtime', { runtimeType: 'hosted' }],
      ['hosted', { engine: 'native', migratedFrom: 'durable-object', migration: { state, doProvisioned: true } }],
    ]);
    const lean = jest.fn()
      .mockResolvedValueOnce({ config: migrated('marked') })
      .mockResolvedValueOnce({ config: migrated('done') });
    AgentInstallation.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean }) });
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).resolves.toBeUndefined();

    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'hosted', hostedEngineInEffect({ config: migrated('stopped') })))
      .rejects.toHaveProperty('code', 'outsider_grant_non_native_agent_join');
    await expect(assertAgentRuntimeMayJoinPod('pod-1', 'hosted', hostedEngineInEffect({ config: migrated('done') })))
      .resolves.toBeUndefined();
  });

  it('never puts a caller-controlled query object in the installation lookup', async () => {
    AgentInstallation.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    });
    await expect(assertInstalledAgentMayJoinPod({ $ne: null }, 'bot', 'default')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
    expect(AgentInstallation.findOne).toHaveBeenCalledWith(expect.objectContaining({
      podId: '[object Object]',
    }));
  });

  it('refuses absent and non-native installations before membership', async () => {
    const lean = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      config: new Map([['runtime', { runtimeType: 'webhook' }]]),
    });
    AgentInstallation.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean }) });
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
    await expect(assertInstalledAgentMayJoinPod('pod-1', 'bot', 'default')).rejects.toHaveProperty(
      'code', 'outsider_grant_non_native_agent_join',
    );
  });
});

// Rhea on #2236 (a600bf3d): every site that decides how an agent runs or what it
// may join must use the engine in effect, which is native only once a
// migration finished. Only these read the STORED engine: the engine module, the
// migration (which writes it), and the hosted route (which picks the provision
// branch; the token issuer refuses on the stored engine by design).
describe('who reads the stored engine', () => {
  // eslint-disable-next-line global-require
  const fs = require('fs');
  // eslint-disable-next-line global-require
  const path = require('path');
  const ROOT = path.join(__dirname, '../../..');
  const ALLOWED = new Set(['services/hostedEngine.ts', 'services/hostedEngineMigration.ts', 'routes/hosted.ts']);
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(rel);
    return /\.(ts|js)$/.test(entry.name) ? [rel] : [];
  });

  it('is limited to the engine module, the migration and the hosted route', () => {
    const readers = ['services', 'routes', 'middleware', 'controllers']
      .filter((dir) => fs.existsSync(path.join(ROOT, dir)))
      .flatMap(walk)
      .filter((file) => /\bhostedEngineOf\b/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(readers.sort()).toEqual([...ALLOWED].sort());
  });
});
