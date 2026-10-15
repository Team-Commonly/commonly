/**
 * TASK-265: move every active hosted install from the Durable Object onto the
 * native engine (ADR-023 amendment A1). Dry run by default.
 *
 * Per agent identity (agentName, instanceId), because one agent can be
 * installed in several pods:
 *   1. stop its Durable Object, when one was provisioned and the worker is
 *      configured, so nothing outside the backend still polls as it;
 *   2. revoke its runtime tokens: a native-engine agent holds none
 *      (routes/registry/tokens.ts refuses to mint one);
 *   3. mark each of its active hosted installs native, keeping whether it was
 *      provisioned, and carrying the persona sentence the seat shows
 *      (botMetadata.description) into the hosted prompt;
 *   4. events still pending for it, which nothing polls once the Durable
 *      Object stops, run in-process when recent and are closed with a reason
 *      when stale, so a person's question is answered or visibly dropped,
 *      never silently parked.
 * One identity failing is reported and does not stop the others.
 */
import crypto from 'crypto';
import { HOSTED_ENGINE_NATIVE, hostedEngineOf, readHostedConfig } from './hostedEngine';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentEvent = require('../models/AgentEvent');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hostedRuntime = require('./hostedRuntimeService');

const STALE_PENDING_MS = 10 * 60 * 1000;
const ABOUT_LIMIT = 160;

export interface IdentityReport {
  agentName: string;
  instanceId: string;
  installs: number;
  provisioned: boolean;
  durableObjectStopped?: boolean;
  tokensRevoked?: number;
  pendingRun: number;
  pendingClosed: number;
  error?: string;
}

export interface MigrationReport {
  dryRun: boolean;
  identities: IdentityReport[];
}

const aboutFrom = (description: unknown): string | undefined => {
  const text = typeof description === 'string' ? description.trim().replace(/\s+/g, ' ').slice(0, ABOUT_LIMIT) : '';
  return text || undefined;
};

export const migrateHostedInstallsToNative = async (
  { apply = false, now = new Date() }: { apply?: boolean; now?: Date } = {},
): Promise<MigrationReport> => {
  const report: MigrationReport = { dryRun: !apply, identities: [] };
  const installs = await AgentInstallation.find({ status: 'active', 'config.runtime.runtimeType': 'hosted' });
  const byIdentity = new Map<string, any[]>();
  for (const install of installs) {
    if (hostedEngineOf(install) === HOSTED_ENGINE_NATIVE) continue;
    const key = `${install.agentName}:${install.instanceId || 'default'}`;
    byIdentity.set(key, [...(byIdentity.get(key) || []), install]);
  }

  for (const rows of byIdentity.values()) {
    const agentName = String(rows[0].agentName);
    const instanceId = String(rows[0].instanceId || 'default');
    const provisioned = rows.some((row) => Boolean(readHostedConfig(row).provisionedAt));
    // eslint-disable-next-line no-await-in-loop
    const pending = await AgentEvent.find({ agentName, instanceId, status: 'pending' }).lean();
    const isStale = (event: any) => now.getTime() - new Date(event.createdAt).getTime() >= STALE_PENDING_MS;
    const entry: IdentityReport = {
      agentName,
      instanceId,
      installs: rows.length,
      provisioned,
      pendingRun: pending.filter((event: any) => !isStale(event)).length,
      pendingClosed: pending.filter(isStale).length,
    };
    report.identities.push(entry);
    if (!apply) continue;

    try {
      if (provisioned && hostedRuntime.isConfigured()) {
        // eslint-disable-next-line no-await-in-loop
        await hostedRuntime.deprovisionAgent(agentName, instanceId);
        entry.durableObjectStopped = true;
      }
      // eslint-disable-next-line no-await-in-loop
      const agentUser = await User.findOne({
        username: AgentIdentityService.buildAgentUsername(agentName, instanceId),
        isBot: true,
      });
      if (agentUser) {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const { revokeRuntimeTokensForAgent } = require('../routes/registry/tokens');
        // eslint-disable-next-line no-await-in-loop
        const revoked = await revokeRuntimeTokensForAgent({ agentUser, agentName, instanceId, installation: rows[0] });
        entry.tokensRevoked = revoked.length;
      }
      const about = aboutFrom(agentUser?.botMetadata?.description);
      for (const row of rows) {
        const wasProvisioned = Boolean(readHostedConfig(row).provisionedAt);
        row.config.set('hosted', {
          engine: HOSTED_ENGINE_NATIVE,
          provisionedAt: wasProvisioned ? now : null,
          ...(about ? { about } : {}),
          migratedFrom: 'durable-object',
          migratedAt: now,
        });
        // eslint-disable-next-line no-await-in-loop
        await row.save();
      }

      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const AgentEventService = require('./agentEventService');
      for (const event of pending) {
        if (isStale(event)) {
          // eslint-disable-next-line no-await-in-loop
          await AgentEvent.updateOne(
            { _id: event._id, status: 'pending' },
            { $set: { status: 'failed', error: 'hosted engine migrated before this event ran (stale)' } },
          );
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const installation = rows.find((row) => String(row.podId) === String(event.podId));
        if (!installation || !readHostedConfig(installation).provisionedAt) continue;
        // eslint-disable-next-line no-await-in-loop
        const claimed = await AgentEvent.findOneAndUpdate(
          { _id: event._id, status: 'pending' },
          {
            $set: { status: 'delivered', deliveredAt: new Date(), deliveryNonce: crypto.randomBytes(16).toString('hex') },
            $inc: { attempts: 1 },
          },
          { new: true },
        );
        if (claimed) AgentEventService.dispatchInProcess(claimed, installation, agentName, instanceId, String(claimed.type || ''));
      }
    } catch (error) {
      entry.error = (error as Error).message;
    }
  }
  return report;
};

module.exports = { migrateHostedInstallsToNative };
