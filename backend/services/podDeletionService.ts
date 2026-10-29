// What deleting a pod removes, in one place. `DELETE /api/pods/:id`
// (podController.deletePod) and the synthetic-account purge
// (syntheticAccountPurgeService) both call this, so the two cannot drift apart
// about what a pod's deletion takes with it. Authorization is the caller's.
const Pod = require('../models/Pod');
const Message = require('../models/Message');
const Post = require('../models/Post');
const Summary = require('../models/Summary');
const PodAsset = require('../models/PodAsset');
const Integration = require('../models/Integration');
const { AgentInstallation } = require('../models/AgentRegistry');
const AgentProfile = require('../models/AgentProfile');

// Same gate as podController: the PG mirror exists only when PG is configured.
let PGPod: any;
let PGMessage: any;
if (process.env.PG_HOST) {
  // eslint-disable-next-line global-require
  PGPod = require('../models/pg/Pod');
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
}

export const deletePodCascade = async (podId: string): Promise<void> => {
  // A hierarchy link is not ownership. Keep children and their contents.
  await Pod.updateMany({ parentPod: podId }, { $unset: { parentPod: 1 } });
  await Message.deleteMany({ podId });
  // Read before the rows go: an agent whose last install was in this pod
  // must lose its runtime token with it, same as an uninstall.
  const installedAgents = await AgentInstallation.find({ podId })
    .select('agentName instanceId').lean();
  if (PGMessage) {
    await PGMessage.deleteByPodId(podId);
  }

  await Promise.allSettled([
    Post.deleteMany({ podId }),
    Summary.deleteMany({ podId }),
    PodAsset.deleteMany({ podId }),
    Integration.deleteMany({ podId }),
    AgentInstallation.deleteMany({ podId }),
    AgentProfile.deleteMany({ podId }),
  ]);

  const identities = new Map<string, { agentName: string; instanceId: string }>();
  for (const row of installedAgents || []) {
    const instanceId = row.instanceId || 'default';
    identities.set(`${row.agentName}:${instanceId}`, { agentName: row.agentName, instanceId });
  }
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { revokeRuntimeTokensAfterLastUninstall } = require('../routes/registry/tokens');
  // The helper counts active installs first, so an agent still installed in
  // another pod keeps its token, and a failed delete above revokes nothing.
  for (const { agentName, instanceId } of identities.values()) {
    await revokeRuntimeTokensAfterLastUninstall(agentName, instanceId);
  }

  if (PGPod) {
    await PGPod.delete(podId);
  }

  await Pod.deleteOne({ _id: podId });
};

// CJS compat, same shape as sibling services.
module.exports = { deletePodCascade };
