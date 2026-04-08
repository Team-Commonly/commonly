import Pod from '../models/Pod';
import Activity from '../models/Activity';
import { AgentInstallation } from '../models/AgentRegistry';
import AgentIdentityService from './agentIdentityService';

const MAX_TOTAL_INSTALLS = Math.max(1, parseInt(process.env.AGENT_AUTO_JOIN_MAX_TOTAL || '200', 10));
const MAX_PER_SOURCE = Math.max(1, parseInt(process.env.AGENT_AUTO_JOIN_MAX_PER_SOURCE || '25', 10));

interface AutoJoinOptions {
  source?: string;
}

interface AutoJoinResult {
  source: string;
  scannedSources: number;
  installed: number;
  skipped: number;
  limits: { maxTotal: number; maxPerSource: number };
}

class AgentAutoJoinService {
  static async runAutoJoinAgentOwnedPods({ source = 'scheduled' }: AutoJoinOptions = {}): Promise<AutoJoinResult> {
    const sourceInstallations = await AgentInstallation.find({
      status: 'active',
      'config.autonomy.autoJoinAgentOwnedPods': true,
    }).select('agentName instanceId displayName podId version scopes config installedBy').lean() as Array<Record<string, unknown>>;

    if (!sourceInstallations.length) {
      return { scannedSources: 0, installed: 0, skipped: 0, source, limits: { maxTotal: MAX_TOTAL_INSTALLS, maxPerSource: MAX_PER_SOURCE } };
    }

    let installed = 0;
    let skipped = 0;

    for (const sourceInstall of sourceInstallations) {
      if (installed >= MAX_TOTAL_INSTALLS) break;
      const instanceId = String(sourceInstall.instanceId || 'default');
      // eslint-disable-next-line no-await-in-loop
      const agentUser = await AgentIdentityService.getOrCreateAgentUser(String(sourceInstall.agentName), {
        instanceId,
        displayName: String(sourceInstall.displayName || ''),
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
        const isInstalled = await AgentInstallation.isInstalled(String(sourceInstall.agentName), (pod as { _id: import('mongoose').Types.ObjectId })._id, instanceId);
        if (isInstalled) {
          skipped += 1;
          // eslint-disable-next-line no-continue
          continue;
        }

        const sourceConfig = (sourceInstall.config || {}) as Record<string, unknown>;
        const sourceAutonomy = (sourceConfig.autonomy || {}) as Record<string, unknown>;
        const mergedConfig = {
          ...sourceConfig,
          heartbeat: { enabled: false },
          autonomy: {
            ...sourceAutonomy,
            autoJoined: true,
            autoJoinedFromPodId: sourceInstall.podId?.toString?.() || String(sourceInstall.podId),
            autoJoinSource: source,
          },
        };

        try {
          // eslint-disable-next-line no-await-in-loop
          await AgentInstallation.install(String(sourceInstall.agentName), (pod as { _id: import('mongoose').Types.ObjectId })._id, {
            version: String(sourceInstall.version || '1.0.0'),
            config: mergedConfig as unknown as Map<string, unknown>,
            scopes: Array.isArray(sourceInstall.scopes) ? sourceInstall.scopes as string[] : [],
            installedBy: agentUser._id,
            instanceId,
            displayName: String(sourceInstall.displayName || ''),
          });
          // eslint-disable-next-line no-await-in-loop
          await AgentIdentityService.ensureAgentInPod(agentUser, (pod as Record<string, unknown>)._id);
          try {
            const agentMeta = agentUser.botMetadata as Record<string, unknown> | undefined;
            // eslint-disable-next-line no-await-in-loop
            await Activity.create({
              type: 'pod_event',
              actor: {
                id: agentUser._id,
                name: agentMeta?.displayName || agentUser.username,
                type: 'agent',
                verified: true,
              },
              action: 'agent_auto_join',
              content: `${String(sourceInstall.agentName)} auto-joined this pod via autonomy policy.`,
              podId: (pod as Record<string, unknown>)._id,
              sourceType: 'event',
              sourceId: `${String(sourceInstall.agentName)}:${instanceId}`,
              agentMetadata: {
                agentName: sourceInstall.agentName,
              },
            });
          } catch (activityError) {
            console.warn('[agent-autojoin] failed to log activity:', (activityError as Error).message);
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

export default AgentAutoJoinService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
