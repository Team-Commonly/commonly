// F183: the rename rewrites a DM pod's name AND description in Mongo, and the PG
// write used to update `pods.name` only, through hand-written SQL. It now goes
// through PGPod.update (pgMirrorWrite.mirrorPodRenamed), so PG `pods` carries
// both fields, and a PG failure still never rolls back the Mongo rename.
process.env.PG_HOST = 'localhost';

jest.mock('../../../services/pgMirrorWrite', () => ({ mirrorPodRenamed: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock('../../../models/User', () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), updateOne: jest.fn() },
}));

const Pod = require('../../../models/Pod').default;
const User = require('../../../models/User').default;
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { mirrorPodRenamed } = require('../../../services/pgMirrorWrite');
const { renameAgentDmPods } = require('../../../scripts/rename-agent-dm-pods');

describe('rename-agent-dm-pods PG mirror (F183)', () => {
  let pod;
  beforeEach(() => {
    pod = {
      _id: 'p1', type: 'agent-dm', name: 'openclaw ↔ openclaw', members: ['a', 'b'], save: jest.fn(),
    };
    Pod.find.mockReturnValue({ cursor: () => [pod][Symbol.iterator]() });
    User.find.mockReturnValue({ select: () => ({ lean: async () => [
      { _id: 'a', botMetadata: { displayName: 'Aria', agentName: 'openclaw' } },
      { _id: 'b', botMetadata: { displayName: 'Pixel', agentName: 'openclaw' } },
    ] }) });
    AgentInstallation.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  });
  afterEach(() => jest.clearAllMocks());

  it('writes the new name and description to PG after the Mongo save', async () => {
    mirrorPodRenamed.mockResolvedValue(true);
    const r = await renameAgentDmPods();
    expect(pod.save).toHaveBeenCalled();
    expect(mirrorPodRenamed).toHaveBeenCalledWith('p1', 'Aria ↔ Pixel', 'Agent-to-agent DM — Aria and Pixel');
    expect(r.pgSynced).toBe(1);
  });

  it('keeps the Mongo rename and counts nothing when the PG write fails', async () => {
    mirrorPodRenamed.mockResolvedValue(false);
    const r = await renameAgentDmPods();
    expect(r.applied).toBe(1);
    expect(r.pgSynced).toBe(0);
  });

  it('writes nothing in a dry run', async () => {
    await renameAgentDmPods({ dryRun: true });
    expect(mirrorPodRenamed).not.toHaveBeenCalled();
  });
});
