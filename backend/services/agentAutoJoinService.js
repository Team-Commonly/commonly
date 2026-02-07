const Pod = require('../models/Pod');
const Activity = require('../models/Activity');
const { AgentInstallation } = require('../models/AgentRegistry');
const AgentIdentityService = require('./agentIdentityService');

const MAX_TOTAL_INSTALLS = Math.max(1, parseInt(process.env.AGENT_AUTO_JOIN_MAX_TOTAL || '200', 10));
const MAX_PER_SOURCE = Math.max(1, parseInt(process.env.AGENT_AUTO_JOIN_MAX_PER_SOURCE || '25', 10));

class AgentAutoJoinService {
  static async runAutoJoinAgentOwnedPods({ source = 'scheduled' } = {}) {
    const sourceInstallations = await AgentInstallation.find({
      status: 'active',
      'config.autonomy.autoJoinAgentOwnedPods': true,
    }).select('agentName instanceId displayName podId version scopes config installedBy').lean();

    if (!sourceInstallations.length) {
      return { scannedSources: 0, installed: 0, skipped: 0, source };
    }

    let installed = 0;
    let skipped = 0;

    for (const sourceInstall of sourceInstallations) {
      if (installed >= MAX_TOTAL_INSTALLS) break;
      const instanceId = sourceInstall.instanceId || 'default';
      // eslint-disable-next-line no-await-in-loop
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(sourceInstall.agentName, {
        instanceId,
        displayName: sourceInstall.displayName,
      });
      // eslint-disable-next-line no-await-in-loop
      const agentOwnedPods = await Pod.find({
        createdBy: agentUser._id,
        _id: { $ne: sourceInstall.podId },
      }).select('_id').lean();

      let installedForSource = 0;
      // eslint-disable-next-line no-restricted-syntax
      for (const pod of agentOwnedPods) {
        if (installed >= MAX_TOTAL_INSTALLS || installedForSource >= MAX_PER_SOURCE) break;
        // eslint-disable-next-line no-await-in-loop
        const isInstalled = await AgentInstallation.isInstalled(sourceInstall.agentName, pod._id, instanceId);
        if (isInstalled) {
          skipped += 1;
          // eslint-disable-next-line no-continue
          continue;
        }

        const mergedConfig = {
          ...(sourceInstall.config || {}),
          autonomy: {
            ...(sourceInstall.config?.autonomy || {}),
            autoJoined: true,
            autoJoinedFromPodId: sourceInstall.podId?.toString?.() || String(sourceInstall.podId),
            autoJoinSource: source,
          },
        };

        try {
          // eslint-disable-next-line no-await-in-loop
          await AgentInstallation.install(sourceInstall.agentName, pod._id, {
            version: sourceInstall.version || '1.0.0',
            config: mergedConfig,
            scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes : [],
            installedBy: agentUser._id,
            instanceId,
            displayName: sourceInstall.displayName,
          });
          // eslint-disable-next-line no-await-in-loop
          await AgentIdentityService.ensureAgentInPod(agentUser, pod._id);
          try {
            // eslint-disable-next-line no-await-in-loop
            await Activity.create({
              type: 'pod_event',
              actor: {
                id: agentUser._id,
                name: agentUser.botMetadata?.displayName || agentUser.username,
                type: 'agent',
                verified: true,
              },
              action: 'agent_auto_join',
              content: `${sourceInstall.agentName} auto-joined this pod via autonomy policy.`,
              podId: pod._id,
              sourceType: 'event',
              sourceId: `${sourceInstall.agentName}:${instanceId}`,
              agentMetadata: {
                agentName: sourceInstall.agentName,
              },
            });
          } catch (activityError) {
            console.warn('[agent-autojoin] failed to log activity:', activityError.message);
          }
          installed += 1;
          installedForSource += 1;
        } catch (error) {
          skipped += 1;
        }
      }
    }

    return {
      source,
      scannedSources: sourceInstallations.length,
      installed,
      skipped,
      limits: {
        maxTotal: MAX_TOTAL_INSTALLS,
        maxPerSource: MAX_PER_SOURCE,
      },
    };
  }
}

module.exports = AgentAutoJoinService;
