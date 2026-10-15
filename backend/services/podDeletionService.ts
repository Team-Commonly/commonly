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
