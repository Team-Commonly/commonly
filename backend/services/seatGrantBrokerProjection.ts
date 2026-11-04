/**
 * What a BYO seat receives from its live room grants: one MCP server per grant,
 * or a typed refusal. Two routes hand this out, and both call the one function
 * below rather than a copy of it:
 *
 *  - `GET /api/agent-binding/assigned`, the daemon's work list, per seat on the
 *    calling machine (`routes/agentBinding.ts`), and
 *  - `GET /api/agents/runtime/grant-brokers`, read by a seat that runs with
 *    `commonly agent run` and no daemon, for its own identity only (F150).
 *
 * Grants are capabilities, not installation config: querying them means revoke
 * and expiry take effect on the next read without rewriting every
 * AgentInstallation. Which grants a seat has is not decided here —
 * `selectLiveGrantsForIdentities` owns that predicate and the hosted run path
 * (TASK-132) asks the same question, so a seat cannot be handed a capability one
 * path projects and the other withholds. What stays here is the BYO shape: the
 * environment-confined refusal and the MCP server naming.
 *
 * The grant is external reach, so it is only injected into an environment that
 * can confine it: a seat whose declaration no host would confine gets NO broker
 * servers and a typed refusal instead (TASK-063 — fail closed rather than hand
 * a seat a capability it cannot be held to). F94: a grant that names the seat
 * (its owner's own agent, with consent) lifts a sandbox refusal, never
 * `adapter_cannot_confine` (`namingLiftsRefusal`).
 *
 * Delivery is not authority. Every broker call re-reads the grant and refuses a
 * revoked or expired one (`toolBrokerService` → `assertGrantUsable`), and
 * re-judges the calling seat (`judgeSeatConfinement`), so a stale entry held by
 * a seat between reads reaches nothing.
 */
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';
import { GRANT_BROKER_ID, GRANT_BROKER_URL } from './installable/toolInstallables';
import { GrantBrokerRefusal, grantBrokerRefusal, normalizeAdapter } from './grantBrokerConfinement';
import { namingLiftsFor, namingLiftsRefusal } from './byoGrantNaming';
import { grantBrokerServer, selectLiveGrantsForIdentities } from './grantBrokerProjectionService';
import {
  SeatEnvironmentEntry,
  normalizeIdentityPart,
  projectSeatEnvironments,
  seatEnvironmentKey,
} from './seatEnvironmentProjection';

export type GrantProjectionIdentity = { _id?: unknown; botMetadata?: Record<string, unknown> };
export type GrantProjectionEntry = Pick<SeatEnvironmentEntry, 'podIds' | 'environment' | 'runtime'>;
export type IdentityGrantProjection = { servers: Record<string, unknown>[]; refusal: GrantBrokerRefusal | null };

export interface GrantProjectionOptions {
  /**
   * The adapter the CALLER says it runs. The daemon path has none: the row's
   * own runtime names it. A run-path seat declares it, and it is judged IN
   * ADDITION to the row's runtime, so a declaration can only add a refusal.
   */
  adapter?: string | null;
  /**
   * Who decides an ABSENT sandbox block. On the daemon path the daemon does: it
   * derives a confining baseline before the seat spawns, so the server must not
   * refuse, and naming has nothing to lift. On the run path nothing derives a
   * baseline, and the seat's own `withholdGrantBroker` refuses an absent block
   * (`sandbox_absent`), so a grant that names the seat must say so on the entry
   * or the consent the granter gave is dropped client-side. `false` flags a
   * named entry even when the server itself raised no refusal.
   */
  daemonDecidesAbsentSandbox?: boolean;
}

/** The server's verdict for one seat, with the caller's declared adapter judged too. */
const refusalFor = (entry: GrantProjectionEntry, adapter: string | null): GrantBrokerRefusal | null => {
  if (adapter) {
    const declared = grantBrokerRefusal(entry.environment, { adapter });
    if (declared) return declared;
  }
  return grantBrokerRefusal(entry.environment, entry.runtime);
};

export const grantServersForIdentities = async (
  identities: GrantProjectionIdentity[],
  entries: Map<string, GrantProjectionEntry>,
  options: GrantProjectionOptions = {},
): Promise<Map<string, IdentityGrantProjection>> => {
  const identityIds = identities
    .map((identity) => String(identity._id || ''))
    .filter(Boolean);
  if (!identityIds.length) return new Map();
  const adapter = normalizeAdapter(options.adapter);
  const daemonDecidesAbsentSandbox = options.daemonDecidesAbsentSandbox !== false;

  // One predicate for both delivery paths (TASK-132): BYO seats project for
  // every pod they are installed in, and a hosted run passes only its own pod.
  // Neither path decides for itself what "live, audience, target" means.
  const liveGrants = await selectLiveGrantsForIdentities({
    identityIds,
    podIds: Array.from(new Set(Array.from(entries.values()).flatMap((entry) => entry.podIds))),
  });
  if (!liveGrants.size) return new Map();

  const output = new Map<string, IdentityGrantProjection>();
  for (const identityId of identityIds) {
    const grants = liveGrants.get(identityId) || [];
    const identity = identities.find((candidate) => String(candidate._id || '') === identityId);
    const meta = identity?.botMetadata || {};
    const assigned = entries.get(seatEnvironmentKey(meta.agentName, meta.instanceId));
    if (!assigned) continue;
    const existingMcp = Array.isArray(assigned.environment?.mcp) ? assigned.environment.mcp as unknown[] : [];
    const usedNames = new Set(
      existingMcp
        // The builtin component is a template only; once a live grant exists,
        // replace that placeholder entry with the grant-specific URL below.
        .filter((server) => !(
          (server as Record<string, unknown>)?.name === GRANT_BROKER_ID
          && (server as Record<string, unknown>)?.url === GRANT_BROKER_URL
        ))
        .map((server) => (server as Record<string, unknown>)?.name)
        .filter((name: unknown): name is string => typeof name === 'string'),
    );
    const refusal = refusalFor(assigned, adapter);
    // Naming can lift a sandbox refusal; on the run path it also has to travel
    // with an entry the server did not refuse, for the seat's own guard.
    const namingCanApply = refusal ? namingLiftsRefusal(refusal) : !daemonDecidesAbsentSandbox;
    const servers: Record<string, unknown>[] = [];
    let refused = false;
    for (const grant of grants) {
      const grantId = typeof grant.grantId === 'string' ? grant.grantId : '';
      if (!grantId) continue;
      // F94: a grant that names this seat (its owner's own agent, with consent)
      // rides even when the seat cannot confine it.
      // eslint-disable-next-line no-await-in-loop
      const byoNamed = namingCanApply && await namingLiftsFor(grant, identityId);
      if (refusal && !byoNamed) {
        // The grant is live and applies to this seat; the seat cannot be held
        // to it, so it is withheld rather than projected unenforced.
        refused = true;
        continue;
      }

      let serverName = GRANT_BROKER_ID;
      if (usedNames.has(serverName)) serverName = `${GRANT_BROKER_ID}-${grantId}`;
      usedNames.add(serverName);
      servers.push(grantBrokerServer(grantId, serverName, { byoNamed }));
    }
    if (servers.length || refused) {
      output.set(identityId, { servers, refusal: refused ? refusal : null });
    }
  }
  return output;
};

/**
 * F150: the run-path read. The seat is the token's own bot User — the caller
 * names nothing but its adapter — so the result can never carry a grant for
 * another identity.
 *
 * The projection is the daemon's per-owner one: `/assigned` projects the
 * machine owner's installations, and a run-path seat has no machine, so each
 * installer of the seat's own rows is projected in turn (the same owner set
 * `judgeSeatConfinement` reads). A row the seat installed itself (an auto-join
 * copies its source's config) is not an owner's, as in /installations (D247).
 * A refusal from any projection is reported (fail closed, as the per-call
 * judgement does), and the broker re-checks every call either way.
 */
export const grantBrokersForRuntimeSeat = async (
  { agentUserId, adapter }: { agentUserId: string; adapter: string },
): Promise<IdentityGrantProjection> => {
  const none: IdentityGrantProjection = { servers: [], refusal: null };
  const seat = await User.findOne({ _id: agentUserId, isBot: true })
    .select('_id botMetadata.agentName botMetadata.instanceId').lean() as GrantProjectionIdentity | null;
  const agentName = normalizeIdentityPart(seat?.botMetadata?.agentName);
  if (!seat || !agentName) return none;
  const key = seatEnvironmentKey(agentName, seat.botMetadata?.instanceId);

  const installs = await AgentInstallation.find({ agentName, status: 'active' })
    .select('agentName instanceId installedBy').lean() as Array<{
      agentName?: unknown; instanceId?: unknown; installedBy?: unknown;
    }>;
  const owners = Array.from(new Set(installs
    .filter((install) => seatEnvironmentKey(install.agentName, install.instanceId) === key)
    .map((install) => String(install.installedBy || ''))
    .filter((owner) => owner && owner !== String(seat._id))));

  const servers: Record<string, unknown>[] = [];
  let refusal: GrantBrokerRefusal | null = null;
  for (const owner of owners) {
    // eslint-disable-next-line no-await-in-loop -- owners are per-seat and few
    const entry = (await projectSeatEnvironments({ installedBy: owner, agentName })).get(key);
    if (!entry) continue;
    // eslint-disable-next-line no-await-in-loop
    const projected = (await grantServersForIdentities([seat], new Map([[key, entry]]), {
      adapter, daemonDecidesAbsentSandbox: false,
    })).get(String(seat._id));
    if (!projected) continue;
    if (projected.refusal && !refusal) refusal = projected.refusal;
    for (const server of projected.servers) {
      // One entry per grant (its url names it). A second owner's projection of
      // the same grant adds nothing; a name taken by another grant is suffixed.
      if (servers.some((existing) => existing.url === server.url)) continue;
      const named = servers.some((existing) => existing.name === server.name)
        ? { ...server, name: `${GRANT_BROKER_ID}-${String(server.url).split('/').pop()}` }
        : server;
      servers.push(named);
    }
  }
  return { servers, refusal };
};

export default { grantServersForIdentities, grantBrokersForRuntimeSeat };
