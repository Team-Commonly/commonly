import { AgentInstallation } from '../models/AgentRegistry';
import Pod from '../models/Pod';
import User from '../models/User';
import { SIGNUP_INSTALLED_AGENT_NAMES } from '../config/native-agents/apps';

// The install composer already owns the honest, mentionable introduction copy.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { composeInstallIntro } = require('../routes/registry/helpers');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentMessageService = require('./agentMessageService');

type Installation = {
  agentName: string;
  instanceId?: string;
  displayName?: string;
  installedBy?: unknown;
  podId?: unknown;
};

const checked = new Set<string>();

/**
 * A listener's event poll is its first useful check-in. Token verification may
 * call /installations before the listener starts, so authentication alone is
 * too early to promise that a mention will reach the agent.
 */
export async function maybePostFirstAgentIntro(
  agentName: string,
  instanceId: string,
  installations: Installation[],
): Promise<void> {
  if (SIGNUP_INSTALLED_AGENT_NAMES.has(agentName.toLowerCase())) return;

  const owners = new Map<string, Installation>();
  for (const installation of installations) {
    const ownerId = String(installation.installedBy || '');
    if (ownerId && installation.podId && !owners.has(ownerId)) owners.set(ownerId, installation);
  }

  for (const [ownerId, installation] of owners) {
    const key = `${ownerId}:${agentName}:${instanceId}`;
    if (checked.has(key)) continue;

    // Include uninstalled rows: "first agent ever" is a historical fact, not
    // a count of today's active installations. Signup's Scout is excluded.
    const first = await AgentInstallation.findOne({
      installedBy: ownerId,
      agentName: { $nin: [...SIGNUP_INSTALLED_AGENT_NAMES] },
    }).sort({ createdAt: 1, _id: 1 }).select('agentName instanceId').lean();
    if (!first || first.agentName !== agentName
      || (first.instanceId || 'default') !== instanceId) {
      checked.add(key);
      continue;
    }

    const pod = await Pod.findById(installation.podId).select('type members createdBy').lean();
    // A personal workspace belongs to its creator. A 1:1 agent room instead
    // records the agent as createdBy, so identify the installer by membership.
    const isOwnRoom = pod?.type === 'agent-room'
      && pod.members?.some((member: unknown) => String(member) === ownerId);
    if (!pod || (!isOwnRoom && String(pod.createdBy) !== ownerId)) {
      checked.add(key);
      continue;
    }
    // Team pods already receive the install-time intro. Agent rooms were
    // excluded there even though their human and agent make two members.
    if (pod.type !== 'agent-room' && (pod.members?.length || 0) >= 2) {
      checked.add(key);
      continue;
    }
    if (pod.type === 'agent-dm' || pod.type === 'agent-admin') {
      checked.add(key);
      continue;
    }

    const at = new Date();
    const claimed = await User.findOneAndUpdate(
      { _id: ownerId, isBot: { $ne: true }, 'onboarding.firstAgentIntroAt': { $exists: false } },
      { $set: { 'onboarding.firstAgentIntroAt': at } },
      { new: false, projection: { _id: 1 } },
    );
    if (!claimed) {
      checked.add(key);
      continue;
    }

    const displayName = installation.displayName || agentName;
    const handle = instanceId !== 'default' ? instanceId : agentName;
    // Keep the claim even if posting throws. postMessage can persist a message
    // before a later side effect fails; releasing the claim would let another
    // check-in announce the same agent twice.
    checked.add(key);
    await AgentMessageService.postMessage({
      agentName,
      instanceId,
      displayName,
      podId: String(installation.podId),
      content: composeInstallIntro({
        displayName,
        handle,
        state: 'listening',
        fixCommand: '',
      }),
      metadata: { kind: 'install-intro' },
    });
  }
}

export function resetFirstAgentIntroCacheForTest(): void {
  checked.clear();
}
