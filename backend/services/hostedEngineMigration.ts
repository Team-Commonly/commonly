/**
 * TASK-265: move every active hosted install from the Durable Object onto the
 * native engine (ADR-023 amendment A1). Dry run by default.
 *
 * Per agent identity (agentName, instanceId), because one agent can sit in
 * several pods, and in this order (Rhea and sprint-review on #2236):
 *   0. Refuse the identity, changing nothing, when its Durable Object is
 *      provisioned but the hosted worker is not configured: it could not be
 *      stopped, and would keep polling as the agent.
 *   1. Mark every row native FIRST. From that moment the token issuer refuses
 *      to mint for the identity (routes/registry/tokens.ts), so no token can
 *      be issued between the revoke and the mark. A failed row restores the
 *      rows already marked.
 *   2. Stop the Durable Object. On failure every row is restored, and the
 *      identity is exactly as it was.
 *   3. Revoke its runtime tokens. On failure the rows stay native (minting is
 *      refused) and the Durable Object is stopped; the report says to run
 *      again, and every run revokes for already-migrated identities.
 *   4. Pending events, which nothing polls once the Durable Object stops: a
 *      recent one on a provisioned install is handed to the in-process sweep
 *      (marked delivered; agentEventService re-runs it), so this script never
 *      runs a turn itself. A recent one on a stopped install, and any stale
 *      one, is closed with a reason.
 * One identity failing is reported and does not stop the others.
 */
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
const MIGRATED_FROM = 'durable-object';

export interface IdentityReport {
  agentName: string;
  instanceId: string;
  installs: number;
  provisioned: boolean;
  alreadyMigrated?: boolean;
  durableObjectStopped?: boolean;
  tokensRevoked?: number;
  /** Recent events on a provisioned install, handed to the in-process sweep. */
  pendingToSweep: number;
  /** Recent events on a stopped install, and stale ones, closed with a reason. */
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

const setHosted = (id: unknown, hosted: Record<string, unknown> | null) => AgentInstallation.updateOne(
  { _id: id },
  hosted && Object.keys(hosted).length ? { $set: { 'config.hosted': hosted } } : { $unset: { 'config.hosted': '' } },
);

const findAgentUser = (agentName: string, instanceId: string) => User.findOne({
  username: AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(agentName), instanceId),
  isBot: true,
});

const revokeFor = async (agentName: string, instanceId: string, installation: unknown): Promise<number> => {
  const agentUser = await findAgentUser(agentName, instanceId);
  if (!agentUser) return 0;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { revokeRuntimeTokensForAgent } = require('../routes/registry/tokens');
  const revoked = await revokeRuntimeTokensForAgent({ agentUser, agentName, instanceId, installation });
  return revoked.length;
};

export const migrateHostedInstallsToNative = async (
  { apply = false, now = new Date() }: { apply?: boolean; now?: Date } = {},
): Promise<MigrationReport> => {
  const report: MigrationReport = { dryRun: !apply, identities: [] };
  const installs = await AgentInstallation.find({ status: 'active', 'config.runtime.runtimeType': 'hosted' }).lean();
  const byIdentity = new Map<string, any[]>();
  for (const install of installs) {
    const key = `${install.agentName}:${install.instanceId || 'default'}`;
    byIdentity.set(key, [...(byIdentity.get(key) || []), install]);
  }

  for (const rows of byIdentity.values()) {
    const agentName = String(rows[0].agentName);
    const instanceId = String(rows[0].instanceId || 'default');
    const todo = rows.filter((row) => hostedEngineOf(row) !== HOSTED_ENGINE_NATIVE);
    const isProvisioned = (row: any) => Boolean(readHostedConfig(row).provisionedAt);

    if (!todo.length) {
      // Already moved by an earlier run. Finish it: a migrated identity holds
      // no runtime token, even if that run's revoke failed.
      if (!rows.some((row) => readHostedConfig(row).migratedFrom === MIGRATED_FROM)) continue;
      const entry: IdentityReport = {
        agentName, instanceId, installs: rows.length, provisioned: rows.some(isProvisioned),
        alreadyMigrated: true, pendingToSweep: 0, pendingClosed: 0,
      };
      report.identities.push(entry);
      if (apply) {
        try {
          // eslint-disable-next-line no-await-in-loop
          entry.tokensRevoked = await revokeFor(agentName, instanceId, rows[0]);
        } catch (error) {
          entry.error = `tokens not revoked (${(error as Error).message}); run again`;
        }
      }
      continue;
    }

    const provisioned = todo.some(isProvisioned);
    // eslint-disable-next-line no-await-in-loop
    const pending = await AgentEvent.find({ agentName, instanceId, status: 'pending' }).lean();
    const podIsRunning = (podId: unknown) => todo.some((row) => String(row.podId) === String(podId) && isProvisioned(row));
    const recent = (event: any) => now.getTime() - new Date(event.createdAt).getTime() < STALE_PENDING_MS;
    const toSweep = pending.filter((event: any) => recent(event) && podIsRunning(event.podId));
    const toClose = pending.filter((event: any) => !toSweep.includes(event));
    const entry: IdentityReport = {
      agentName,
      instanceId,
      installs: todo.length,
      provisioned,
      pendingToSweep: toSweep.length,
      pendingClosed: toClose.length,
    };
    report.identities.push(entry);

    if (provisioned && !hostedRuntime.isConfigured()) {
      entry.error = 'its Durable Object is provisioned but the hosted worker is not configured, so it cannot be '
        + 'stopped; refused, nothing changed';
      continue;
    }
    if (!apply) continue;

    // 1. Mark every row native first, so minting is refused from here on.
    // eslint-disable-next-line no-await-in-loop
    const agentUser = await findAgentUser(agentName, instanceId);
    const about = aboutFrom(agentUser?.botMetadata?.description);
    const previous = new Map(todo.map((row) => [String(row._id), readHostedConfig(row)]));
    const restore = async (ids: string[]) => {
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await setHosted(id, previous.get(id) || null);
      }
    };
    const marked: string[] = [];
    try {
      for (const row of todo) {
        // eslint-disable-next-line no-await-in-loop
        await setHosted(row._id, {
          engine: HOSTED_ENGINE_NATIVE,
          provisionedAt: isProvisioned(row) ? now : null,
          ...(about ? { about } : {}),
          migratedFrom: MIGRATED_FROM,
          migratedAt: now,
        });
        marked.push(String(row._id));
      }
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await restore(marked).catch(() => undefined);
      entry.error = `marking failed (${(error as Error).message}); restored, nothing changed`;
      continue;
    }

    // 2. Stop the Durable Object; on failure, put every row back.
    if (provisioned) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await hostedRuntime.deprovisionAgent(agentName, instanceId);
        entry.durableObjectStopped = true;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await restore(marked).catch(() => undefined);
        entry.error = `the Durable Object did not stop (${(error as Error).message}); restored, nothing changed`;
        continue;
      }
    }

    // 3. Revoke. The rows are native (no new token can be minted) and the
    // Durable Object is stopped, so a failure here is finished by a re-run.
    try {
      // eslint-disable-next-line no-await-in-loop
      entry.tokensRevoked = await revokeFor(agentName, instanceId, todo[0]);
    } catch (error) {
      entry.error = `tokens not revoked (${(error as Error).message}); the rows are native and the Durable `
        + 'Object is stopped; run again to finish';
    }

    // 4. Pending events: hand recent ones on a running install to the sweep,
    // close the rest with a reason. This script never runs a turn itself.
    for (const event of toSweep) {
      // eslint-disable-next-line no-await-in-loop
      await AgentEvent.updateOne(
        { _id: event._id, status: 'pending' },
        { $set: { status: 'delivered', deliveredAt: now, deliveryNonce: null }, $inc: { attempts: 1 } },
      );
    }
    for (const event of toClose) {
      const reason = recent(event)
        ? 'hosted engine migrated while this agent was stopped; it was not run'
        : 'hosted engine migrated before this event ran (stale)';
      // eslint-disable-next-line no-await-in-loop
      await AgentEvent.updateOne({ _id: event._id, status: 'pending' }, { $set: { status: 'failed', error: reason } });
    }
  }
  return report;
};

module.exports = { migrateHostedInstallsToNative };
