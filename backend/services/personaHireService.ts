/**
 * Persona hiring — Phase 2 of the persona plan (ADR-022 D1/D2).
 *
 * This is Scout's signup install block, generalized: the per-user identity
 * convention, the idempotent installation upsert, membership, and the
 * scripted "it speaks first" opener. Signup keeps its own copy for Scout
 * (perUser manifests are refused here); a later cleanup can migrate it onto
 * this service once the hire path has production mileage.
 *
 * Hireability is the registry row's verified flag — the same curation
 * boundary the catalog gate enforces (#1072). Flipping a persona's row to
 * verified IS the launch switch for its seat.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { createHash } = require('crypto');

interface HireArgs {
  agentName: string;
  userId: string;
  podId: string;
}

interface HireResult {
  agentName: string;
  instanceId: string;
  podId: string;
  botUserId: string | null;
}

class HireError extends Error {
  code: string;

  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// D1's per-user identity convention (Sam, 2026-08-13): one colleague per
// user per persona, opaque, derivable with no lookup. Same derivation as
// Scout's signup block — the two must never drift, or a user's hire and
// their signup Scout would disagree about who they are.
export const perUserInstanceId = (userId: string): string => (
  `u${createHash('sha256').update(String(userId)).digest('hex').slice(0, 10)}`
);

export const hirePersona = async ({ agentName, userId, podId }: HireArgs): Promise<HireResult> => {
  const key = String(agentName || '').trim().toLowerCase();

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { FIRST_PARTY_APPS } = require('../config/native-agents/apps');
  const manifest = FIRST_PARTY_APPS.find((a: { agentName: string }) => a.agentName === key);
  if (!manifest) {
    throw new HireError('persona_not_found', 404, `No persona named '${key}'`);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
  const row = await AgentRegistry.findOne({ agentName: key }).lean();
  // verified = the hireable switch; perUser = signup's territory, not ours.
  if (!row || row.verified !== true || manifest.perUser) {
    throw new HireError('persona_not_available', 403, `Persona '${key}' is not open for hire yet`);
  }

  const instanceId = perUserInstanceId(userId);

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { buildInstallationConfig } = require('../scripts/seed-native-agents');
  await AgentInstallation.findOneAndUpdate(
    { agentName: key, podId, instanceId },
    {
      $set: {
        status: 'active',
        version: '1.0.0',
        displayName: manifest.displayName,
        scopes: ['context:read', 'messages:write', 'memory:read', 'memory:write'],
        config: buildInstallationConfig(manifest),
      },
      $setOnInsert: {
        agentName: key,
        podId,
        instanceId,
        installedBy: userId,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const AgentIdentityService = require('./agentIdentityService');
  const svc = AgentIdentityService.default || AgentIdentityService;
  const botUser = await svc.getOrCreateAgentUser(key, {
    instanceId,
    displayName: manifest.displayName,
    description: manifest.description,
  });

  if (botUser?._id) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const Pod = require('../models/Pod');
    await Pod.updateOne(
      { _id: podId, members: { $ne: botUser._id } },
      { $push: { members: botUser._id } },
    );

    // It speaks first (D2): deterministic and free, so the seat is never a
    // silent tile at the exact moment a first impression forms. Best-effort —
    // the hire stands even if the opener fails.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const AgentMessageService = require('./agentMessageService');
      await AgentMessageService.postMessage({
        agentName: key,
        instanceId,
        podId: String(podId),
        displayName: manifest.displayName,
        content: manifest.introMessage
          || `Hi — I'm ${manifest.displayName}. Mention me when you need me.`,
      });
    } catch (err) {
      console.warn(`[persona-hire] intro post failed for ${key}:${instanceId}:`, (err as Error).message);
    }
  }

  return {
    agentName: key,
    instanceId,
    podId: String(podId),
    botUserId: botUser?._id ? String(botUser._id) : null,
  };
};

// CJS compat, same shape as sibling services.
module.exports = { hirePersona, perUserInstanceId };
