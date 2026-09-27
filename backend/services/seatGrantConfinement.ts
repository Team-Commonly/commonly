/**
 * Does the seat CALLING the broker declare an environment that cannot confine
 * it? (TASK-175)
 *
 * The refusal already ran where the broker is OFFERED — the server projection,
 * the grant read, the daemon's derive — and never where the grant is USED.
 * `routes/mcpGrants.ts` handed any caller holding a token and a grant id
 * straight to `callTool`, so a seat that nothing confines could spend a grant
 * whose only bound, for a read, IS confinement: reads never park (scope note
 * §5, Wren 74882/74883).
 *
 * The seat's declaration is resolved the way the grant read resolves it, not
 * from `req.agentInstallation`: on the bot-token path that is
 * `installations[0]` (`backend/middleware/agentRuntimeAuth.ts:176`) and can
 * name a row belonging to another pod (Wren 74882). The projection is the same
 * `projectSeatEnvironments` the daemon's work list is built from, so the
 * verdict here cannot disagree with what the seat is handed.
 *
 * Absent is NOT a refusal. A seat no projection holds, and one whose
 * declaration names neither an adapter nor a runtimeType, stay daemon-decided —
 * undeclared, the daemon resolves only claude or codex
 * (`cli/src/commands/daemon.js:142`), never pi, so failing closed there would
 * refuse working claude seats (Wren 12:17Z).
 *
 * Disagreement fails closed: the seat's rows can be projected by more than one
 * owner, and if any projection withholds the broker, the call is refused. A
 * refusal can only ever be ADDED by this rule, never removed.
 */
import { Types } from 'mongoose';
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';
import { GrantBrokerRefusal, grantBrokerRefusal } from './grantBrokerConfinement';
import { SeatEnvironmentEntry, projectSeatEnvironments, seatEnvironmentKey } from './seatEnvironmentProjection';

/** `unbound` is the same word the grant read uses: nothing projected this seat. */
export type SeatConfinementScope = 'seat' | 'unbound';

export interface SeatConfinementJudgement {
  refusal: GrantBrokerRefusal | null;
  scope: SeatConfinementScope;
}

export interface SeatCallerIdentity {
  agentName?: unknown;
  instanceId?: unknown;
  agentUserId?: unknown;
}

const NOT_JUDGED: SeatConfinementJudgement = { refusal: null, scope: 'unbound' };

/** The seat's own row: the identity the auth path resolved, for the key fallback. */
const loadSeat = async (agentUserId: unknown): Promise<{
  botMetadata?: { agentName?: unknown; instanceId?: unknown };
} | null> => {
  // The routes in front of this pass the token's identity and Mongo will not
  // cast a non-ObjectId — a 500 is not a judgement.
  if (typeof agentUserId !== 'string' || !Types.ObjectId.isValid(agentUserId)) return null;
  const seat = await User.findById(agentUserId)
    .select('botMetadata.machineId botMetadata.agentName botMetadata.instanceId')
    .lean();
  return seat as never;
};

/**
 * The keys this caller could be projected under.
 *
 * The route's values come from the installation the token authenticated with;
 * the bot's own `botMetadata` is the identity the auth middleware resolved
 * (`resolveTokenAgentIdentity`). They agree whenever an installation row exists
 * (the middleware finds the rows BY that identity), and differ only on the
 * legacy path where there is none. Both are looked up: a lookup that finds
 * nothing cannot add a refusal, and missing the seat's real key would be the
 * fail-open direction.
 */
const seatKeysFor = (caller: SeatCallerIdentity, seat: {
  botMetadata?: { agentName?: unknown; instanceId?: unknown };
} | null): Set<string> => {
  const keys = new Set<string>();
  keys.add(seatEnvironmentKey(caller.agentName, caller.instanceId));
  const meta = seat?.botMetadata;
  if (meta?.agentName) keys.add(seatEnvironmentKey(meta.agentName, meta.instanceId));
  return keys;
};

/**
 * The owners whose projection can hold this seat: the installers of its own
 * installation rows.
 *
 * This is a complete characterization, not a sample. `projectSeatEnvironments`
 * filters `{ installedBy }` and keys each entry by the ROW's own identity, so a
 * seat can appear in a projection only when that owner installed one of its
 * rows — which is the same row this scan matches. The machine's owner is
 * therefore not a second source to consult: every projection they could hold
 * the seat in is one of these rows, and consulting both would only add a query
 * per call.
 *
 * Every installer is used rather than the one the token authenticated with,
 * because `req.agentInstallation` is `installations[0]` on the bot-token path
 * (agentRuntimeAuth.ts:176) and can name a row from another pod (Wren 74882).
 */
const ownerIdsFor = async (keys: Set<string>): Promise<Set<string>> => {
  const owners = new Set<string>();
  // AgentInstallation normalises its identity parts in JS, not in the query
  // (seatEnvironmentProjection), so the match is made on the same key the
  // projection builds rather than on a raw `agentName` string.
  const installs = await AgentInstallation.find({ status: 'active' })
    .select('agentName instanceId installedBy').lean();
  for (const install of installs) {
    const row = install as { agentName?: unknown; instanceId?: unknown; installedBy?: unknown };
    if (!keys.has(seatEnvironmentKey(row.agentName, row.instanceId))) continue;
    if (row.installedBy) owners.add(String(row.installedBy));
  }
  return owners;
};

/**
 * Judge the calling seat. A non-null `refusal` means the broker must not run
 * this call; `scope` says what was looked at, so a null refusal does not carry
 * two meanings ("judged, confinable" vs "never projected").
 */
export const judgeSeatConfinement = async (caller: SeatCallerIdentity): Promise<SeatConfinementJudgement> => {
  const seat = await loadSeat(caller.agentUserId);
  const keys = seatKeysFor(caller, seat);
  const owners = await ownerIdsFor(keys);
  if (!owners.size) return NOT_JUDGED;

  const entries = new Map<string, SeatEnvironmentEntry>();
  for (const owner of owners) {
    // One projection per owner, exactly the daemon's scope. A projection with no
    // row for the seat says nothing rather than "confinable".
    // eslint-disable-next-line no-await-in-loop -- owners are per-seat and few; one scan each
    const byIdentity = await projectSeatEnvironments({ installedBy: owner });
    for (const key of keys) {
      const entry = byIdentity.get(key);
      if (entry) entries.set(`${owner}\0${key}`, entry);
    }
  }

  let judged = false;
  for (const entry of entries.values()) {
    judged = true;
    const refusal = grantBrokerRefusal(entry.environment, entry.runtime);
    // Fail closed on disagreement: the first projection that withholds the
    // broker decides, even if a sibling projection would have admitted it.
    if (refusal) return { refusal, scope: 'seat' };
  }
  return judged ? { refusal: null, scope: 'seat' } : NOT_JUDGED;
};

export default { judgeSeatConfinement };
