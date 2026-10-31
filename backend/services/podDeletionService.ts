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
  // An agent whose last install was in this pod loses its runtime token, as
  // on uninstall. Uninstall the rows and revoke before deleting anything:
  // if a revoke throws, the rows are still here and a retried delete finds
  // them again. The helper counts active installs, so an agent installed in
  // another pod keeps its token.
  const installedAgents = await AgentInstallation.find({ podId })
    .select('agentName instanceId').lean();
  await AgentInstallation.updateMany({ podId }, { $set: { status: 'uninstalled' } });
  const identities = new Map<string, { agentName: string; instanceId: string }>();
  for (const row of installedAgents || []) {
    const instanceId = row.instanceId || 'default';
    identities.set(`${row.agentName}:${instanceId}`, { agentName: row.agentName, instanceId });
  }
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { revokeRuntimeTokensAfterLastUninstall } = require('../routes/registry/tokens');
  for (const { agentName, instanceId } of identities.values()) {
    await revokeRuntimeTokensAfterLastUninstall(agentName, instanceId);
  }

  // Nothing irreversible runs before the revoke above, so a failure there
  // leaves the pod and its content for the retry.
  // A hierarchy link is not ownership. Keep children and their contents.
  await Pod.updateMany({ parentPod: podId }, { $unset: { parentPod: 1 } });
  await Message.deleteMany({ podId });
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

  if (PGPod) {
    await PGPod.delete(podId);
  }

  await Pod.deleteOne({ _id: podId });
};

// CJS compat, same shape as sibling services.
module.exports = { deletePodCascade };
