/**
 * TASK-265: move every active hosted install from the Durable Object onto the
 * native engine (ADR-023 amendment A1). Dry run by default.
 *
 * Forward-only and resumable, with no rollback (Rhea's third review of
 * #2236). Each row records how far its identity got, in
 * `config.hosted.migration`:
 *
 *   { state: 'marked' | 'stopped' | 'done', doProvisioned: boolean }
 *
 * Every run resumes each unfinished identity from its recorded state, per
 * agent identity (agentName, instanceId), since one agent can sit in several
 * pods:
 *   0. Refuse, changing nothing, when a Durable Object that still needs
 *      stopping is provisioned but the hosted worker is not configured.
 *   1. mark:   every row native, state 'marked'. From here the token issuer
 *              refuses to mint for the identity, and re-checks after saving,
 *              so a mint already in flight takes its own token back
 *              (routes/registry/tokens.ts). Until 'done' the rows are NOT
 *              native for execution, grant eligibility or joins
 *              (hostedEngineInEffect), so no step's failure leaves an
 *              identity with an outside channel counted as in-process.
 *   2. stop:   the Durable Object, whenever the worker is configured, since
 *              its stop is idempotent and a provision can land after this
 *              run read the rows; state 'stopped'. Recorded apart from the
 *              mark, so a run interrupted before the stop stops it on the
 *              next run instead of assuming it happened. A provision in
 *              flight across the migration does not overwrite it either: the
 *              route's record write is fenced on the stored engine
 *              (routes/hosted.ts).
 *   3. revoke: the identity's runtime tokens.
 *   4. events: pending events, which nothing polls once the Durable Object
 *              stops. A recent one on a provisioned install is handed to the
 *              in-process sweep (marked delivered; #2226 re-runs it), so this
 *              script never runs a turn. Others are closed with a reason.
 *   5. done.
 * An event enqueued while this runs is routed before it is inserted, so it
 * can land 'pending' after step 4 (the rows are not native until 'done') and
 * a later run skips a done identity. A one-shot scan here cannot be made
 * durable (Rhea on #2236); the recurring in-process sweep runs such events
 * instead (AgentEventService.rescueStrandedPendingInProcess).
 * Every step is idempotent. A step that fails stops that identity there; the
 * report says which, and the next run resumes it. Nothing is reported done
 * that is not.
 */
import {
  HOSTED_ENGINE_NATIVE, MIGRATED_FROM_DURABLE_OBJECT, hostedEngineOf, readHostedConfig,
} from './hostedEngine';

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

type MigrationState = 'marked' | 'stopped' | 'done';

export interface IdentityReport {
  agentName: string;
  instanceId: string;
  installs: number;
  /** Where this run found the identity: 'new' or the recorded state. */
  from: 'new' | MigrationState;
  /** Where it ended: 'done', or the step that failed. */
  reached: 'done' | 'refused' | 'mark' | 'stop' | 'revoke' | 'events' | 'finish' | 'dry-run';
  doProvisioned: boolean;
  durableObjectStopped?: boolean;
  tokensRevoked?: number;
  pendingToSweep: number;
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

const migrationOf = (row: any): { state?: MigrationState; doProvisioned?: boolean } => {
  const value = readHostedConfig(row).migration;
  return value && typeof value === 'object' ? value as { state?: MigrationState; doProvisioned?: boolean } : {};
};

const setState = (ids: unknown[], state: MigrationState) => AgentInstallation.updateMany(
  { _id: { $in: ids } },
  { $set: { 'config.hosted.migration.state': state } },
);

const findAgentUser = (agentName: string, instanceId: string) => User.findOne({
  username: AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(agentName), instanceId),
  isBot: true,
});

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
    const isProvisioned = (row: any) => Boolean(readHostedConfig(row).provisionedAt);
    const unmarked = rows.filter((row) => hostedEngineOf(row) !== HOSTED_ENGINE_NATIVE);
    const migrated = rows.filter((row) => readHostedConfig(row).migratedFrom === MIGRATED_FROM_DURABLE_OBJECT);
    const unfinished = migrated.filter((row) => migrationOf(row).state !== 'done');
    // Done, or born native: nothing to do.
    if (!unmarked.length && !unfinished.length) continue;

    const states = unfinished.map((row) => migrationOf(row).state || 'marked');
    const from: IdentityReport['from'] = unmarked.length ? 'new' : (states.includes('marked') ? 'marked' : 'stopped');
    const doProvisioned = unmarked.some(isProvisioned) || migrated.some((row) => migrationOf(row).doProvisioned === true);
    // Stopped only when every migrated row says so and nothing is left to mark.
    const stopped = !unmarked.length && migrated.every((row) => ['stopped', 'done'].includes(migrationOf(row).state || ''));
    // eslint-disable-next-line no-await-in-loop
    const pending = await AgentEvent.find({ agentName, instanceId, status: 'pending' }).lean();
    const runningPods = new Set(rows.filter(isProvisioned).map((row) => String(row.podId)));
    const recent = (event: any) => now.getTime() - new Date(event.createdAt).getTime() < STALE_PENDING_MS;
    const sweepable = (event: any) => recent(event) && runningPods.has(String(event.podId));
    const toSweep = pending.filter(sweepable);
    const toClose = pending.filter((event: any) => !toSweep.includes(event));
    // A recent event on a running install goes to the in-process sweep (#2226
    // re-runs a delivered event with no nonce); any other is closed with a
    // reason. Only still-pending events are touched.
    const handOff = async (events: any[]) => {
      for (const event of events) {
        if (sweepable(event)) {
          // eslint-disable-next-line no-await-in-loop
          await AgentEvent.updateOne(
            { _id: event._id, status: 'pending' },
            { $set: { status: 'delivered', deliveredAt: now, deliveryNonce: null }, $inc: { attempts: 1 } },
          );
        } else {
          const reason = recent(event)
            ? 'hosted engine migrated while this agent was stopped; it was not run'
            : 'hosted engine migrated before this event ran (stale)';
          // eslint-disable-next-line no-await-in-loop
          await AgentEvent.updateOne({ _id: event._id, status: 'pending' }, { $set: { status: 'failed', error: reason } });
        }
      }
    };
    const entry: IdentityReport = {
      agentName,
      instanceId,
      installs: rows.length,
      from,
      reached: 'dry-run',
      doProvisioned,
      pendingToSweep: toSweep.length,
      pendingClosed: toClose.length,
    };
    report.identities.push(entry);

    if (doProvisioned && !stopped && !hostedRuntime.isConfigured()) {
      entry.reached = 'refused';
      entry.error = 'its Durable Object is provisioned but the hosted worker is not configured, so it cannot be '
        + 'stopped; refused';
      continue;
    }
    if (!apply) continue;
    // Only rows this migration owns: never a row of the same agent born native.
    const ids = [...unmarked, ...migrated].map((row) => row._id);

    // 1. Mark. From here the issuer refuses, and takes back an in-flight mint.
    entry.reached = 'mark';
    try {
      // eslint-disable-next-line no-await-in-loop
      const agentUser = unmarked.length ? await findAgentUser(agentName, instanceId) : null;
      const about = aboutFrom(agentUser?.botMetadata?.description);
      for (const row of unmarked) {
        // eslint-disable-next-line no-await-in-loop
        await AgentInstallation.updateOne({ _id: row._id }, {
          $set: {
            'config.hosted': {
              engine: HOSTED_ENGINE_NATIVE,
              provisionedAt: isProvisioned(row) ? now : null,
              ...(about ? { about } : {}),
              migratedFrom: MIGRATED_FROM_DURABLE_OBJECT,
              migratedAt: now,
              migration: { state: 'marked', doProvisioned },
            },
          },
        });
      }
    } catch (error) {
      entry.error = `marking stopped part-way (${(error as Error).message}); run again to continue`;
      continue;
    }

    // 2. Stop the Durable Object, recorded separately from the mark. Whenever
    // the worker is configured, not only when this run saw it provisioned: a
    // provision can complete between the read above and the mark, and the
    // worker's stop is a no-op for an agent it is not running.
    entry.reached = 'stop';
    try {
      if (!stopped && hostedRuntime.isConfigured()) {
        // eslint-disable-next-line no-await-in-loop
        await hostedRuntime.deprovisionAgent(agentName, instanceId);
        entry.durableObjectStopped = true;
      }
      // eslint-disable-next-line no-await-in-loop
      await setState(ids, 'stopped');
    } catch (error) {
      entry.error = `the Durable Object was not stopped (${(error as Error).message}); the rows are native, `
        + 'so no token can be minted; run again to stop it';
      continue;
    }

    // 3. Revoke.
    entry.reached = 'revoke';
    try {
      // eslint-disable-next-line no-await-in-loop
      const agentUser = await findAgentUser(agentName, instanceId);
      if (agentUser) {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const { revokeRuntimeTokensForAgent } = require('../routes/registry/tokens');
        // eslint-disable-next-line no-await-in-loop
        const revoked = await revokeRuntimeTokensForAgent({ agentUser, agentName, instanceId, installation: rows[0] });
        entry.tokensRevoked = revoked.length;
      } else {
        entry.tokensRevoked = 0;
      }
    } catch (error) {
      entry.error = `tokens not revoked (${(error as Error).message}); run again to finish`;
      continue;
    }

    // 4. Pending events, so a re-run picks up whatever a failed run left.
    entry.reached = 'events';
    try {
      // eslint-disable-next-line no-await-in-loop
      await handOff(pending);
    } catch (error) {
      entry.error = `pending events not all handled (${(error as Error).message}); run again to finish`;
      continue;
    }

    // 5. Done.
    entry.reached = 'finish';
    try {
      // eslint-disable-next-line no-await-in-loop
      await setState(ids, 'done');
      entry.reached = 'done';
    } catch (error) {
      entry.error = `not recorded as done (${(error as Error).message}); run again`;
    }
  }
  return report;
};

module.exports = { migrateHostedInstallsToNative };
