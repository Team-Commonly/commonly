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
 * refuse working claude seats (Wren 12:17Z). An absent SANDBOX block is
 * daemon-decided only for a seat bound to a machine: with no daemon nothing
 * derives a baseline, so it refuses as `sandbox_absent` (F150, below).
 *
 * Disagreement fails closed: the seat's rows can be projected by more than one
 * owner, and if any projection withholds the broker, the call is refused. A
 * refusal can only ever be ADDED by this rule, never removed.
 */
import { Types } from 'mongoose';
import User from '../models/User';
import Machine from '../models/Machine';
import { AgentInstallation } from '../models/AgentRegistry';
import {
  GRANT_BROKER_REFUSAL_CODE, GrantBrokerRefusal, grantBrokerRefusal, grantBrokerRefusalWithoutDaemon, runsOnCommonly,
} from './grantBrokerConfinement';
import { SeatEnvironmentEntry, projectSeatEnvironments, seatEnvironmentKey } from './seatEnvironmentProjection';

/** `unbound` is the same word the grant read uses: nothing projected this seat. */
export type SeatConfinementScope = 'seat' | 'unbound';

export interface SeatConfinementJudgement {
  refusal: GrantBrokerRefusal | null;
  scope: SeatConfinementScope;
  /**
   * The seat's machine reported no sandbox Commonly can enforce (D245). Unlike
   * a declaration, no consent lifts this one (F94, ruling A).
   */
  hostUnconfined?: true;
  /**
   * F356: the refusal is because the seat's machine has not reported its
   * sandbox yet. It also sets hostUnconfined, so nothing lifts it; this flag
   * only lets a surface say "not reported" instead of "no sandbox".
   */
  hostUnreported?: true;
}

export interface SeatCallerIdentity {
  agentName?: unknown;
  instanceId?: unknown;
  agentUserId?: unknown;
}

const NOT_JUDGED: SeatConfinementJudgement = { refusal: null, scope: 'unbound' };

/** The seat's own row: the identity the auth path resolved, for the key fallback. */
const loadSeat = async (agentUserId: unknown): Promise<{
  botMetadata?: { agentName?: unknown; instanceId?: unknown; machineId?: unknown; hostUnconfined?: unknown };
} | null> => {
  // The routes in front of this pass the token's identity and Mongo will not
  // cast a non-ObjectId — a 500 is not a judgement.
  if (typeof agentUserId !== 'string' || !Types.ObjectId.isValid(agentUserId)) return null;
  const seat = await User.findById(agentUserId)
    .select('botMetadata.machineId botMetadata.hostUnconfined botMetadata.agentName botMetadata.instanceId')
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
/**
 * D245: a seat bound to a machine whose daemon reported native Windows (with or
 * without the user's own `--unsandboxed`) is refused
 * whatever its declaration says. The declaration still reads `trust: public`
 * there by design (the stored record keeps it), so the projection alone would
 * judge the seat confinable. Like every rule in this file, it can only add a
 * refusal.
 */
const UNCONFINED_HOST_REFUSAL: GrantBrokerRefusal = {
  code: GRANT_BROKER_REFUSAL_CODE,
  decidedBy: 'server',
  reason: 'sandbox_mode_unenforceable',
  detail: 'this agent runs on native Windows, where Commonly has no sandbox it can enforce, '
    + 'so no grant can be used from it',
};

/** A foreground run's own mark: it says what the seat did, wherever it runs now. */
const UNSANDBOXED_RUN_REFUSAL: GrantBrokerRefusal = {
  code: GRANT_BROKER_REFUSAL_CODE,
  decidedBy: 'server',
  reason: 'sandbox_mode_unenforceable',
  detail: 'this agent ran without a sandbox, so no grant can be used from it until its owner clears that '
    + 'with `commonly agent clear-unsandboxed`',
};

/** F356: a machine whose daemon has not reported its sandbox yet. */
export const UNREPORTED_HOST_REFUSAL: GrantBrokerRefusal = {
  code: GRANT_BROKER_REFUSAL_CODE,
  decidedBy: 'server',
  reason: 'sandbox_not_reported',
  detail: "this agent's computer has not reported whether it runs agents in a sandbox, so no grant can be used "
    + 'from it yet; it reports on the daemon\'s next heartbeat (update the Commonly CLI if this stays)',
};

export const onUnconfinedHost = async (machineId: unknown): Promise<boolean> => {
  if (typeof machineId !== 'string' || !machineId) return false;
  return Boolean(await Machine.exists({ machineId, hostUnconfined: true }));
};

/**
 * The seat's machine as a sandbox verdict: 'unconfined' (reported none),
 * 'unreported' (no report yet, never read as confined), 'confined', or 'none'
 * when the seat has no machine (a foreground run marks the seat itself).
 */
const hostSandboxState = async (machineId: unknown): Promise<'unconfined' | 'unreported' | 'confined' | 'none'> => {
  if (typeof machineId !== 'string' || !machineId) return 'none';
  const machine = await Machine.findOne({ machineId }).select('hostUnconfined hostSandboxReportedAt').lean();
  if (!machine) return 'none';
  if ((machine as { hostUnconfined?: unknown }).hostUnconfined === true) return 'unconfined';
  return (machine as { hostSandboxReportedAt?: unknown }).hostSandboxReportedAt ? 'confined' : 'unreported';
};

/** The refusal a seat's host earns whatever its declaration says, or null. */
export const unconfinedHostRefusal = async (seat: {
  botMetadata?: { machineId?: unknown; hostUnconfined?: unknown };
} | null): Promise<GrantBrokerRefusal | null> => {
  const host = await hostSandboxState(seat?.botMetadata?.machineId);
  if (host === 'unconfined') return UNCONFINED_HOST_REFUSAL;
  if (host === 'unreported') return UNREPORTED_HOST_REFUSAL;
  return seat?.botMetadata?.hostUnconfined === true ? UNSANDBOXED_RUN_REFUSAL : null;
};

export const judgeSeatConfinement = async (caller: SeatCallerIdentity): Promise<SeatConfinementJudgement> => {
  const seat = await loadSeat(caller.agentUserId);
  // A foreground run has no machine to report for it, so it marks the seat
  // itself (POST /api/agents/runtime/host-unconfined).
  const hostRefusal = await unconfinedHostRefusal(seat);
  if (hostRefusal) {
    return { refusal: hostRefusal, scope: 'seat', hostUnconfined: true,
      ...(hostRefusal === UNREPORTED_HOST_REFUSAL ? { hostUnreported: true as const } : {}) };
  }
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

  // F150 (security review): a seat bound to no machine has no daemon to derive
  // a sandbox baseline, so an absent sandbox block on its row confines nothing
  // and is refused (`sandbox_absent`, which naming lifts). A daemon seat, and a
  // runtime Commonly runs (`runsOnCommonly`, read inside the predicate from the
  // row), keep the old reading.
  const judge = seat?.botMetadata?.machineId ? grantBrokerRefusal : grantBrokerRefusalWithoutDaemon;
  let judged = false;
  for (const entry of entries.values()) {
    judged = true;
    const refusal = judge(entry.environment, entry.runtime);
    // Fail closed on disagreement: the first projection that withholds the
    // broker decides, even if a sibling projection would have admitted it.
    if (refusal) return { refusal, scope: 'seat' };
  }
  return judged ? { refusal: null, scope: 'seat' } : NOT_JUDGED;
};

/**
 * TASK-783 re-judge: an approved call parked from a hosted turn runs only if
 * Commonly still runs that agent. Every active installation of the identity
 * must be on a Commonly-run runtime, the seat must be bound to no machine, and
 * there must be at least one: a row moved to someone's own machine, or gone,
 * fails closed. Matched on the same identity keys the judgement above uses.
 */
export const hostedCallerStillCommonlyRun = async (caller: SeatCallerIdentity): Promise<boolean> => {
  const seat = await loadSeat(caller.agentUserId);
  if (!seat || seat.botMetadata?.machineId) return false;
  const keys = seatKeysFor(caller, seat);
  const installs = await AgentInstallation.find({ status: 'active' })
    .select('agentName instanceId config').lean();
  const rows = (installs as Array<{ agentName?: unknown; instanceId?: unknown; config?: { runtime?: unknown } }>)
    .filter((row) => keys.has(seatEnvironmentKey(row.agentName, row.instanceId)));
  return rows.length > 0 && rows.every((row) => runsOnCommonly(row.config?.runtime));
};

export default { judgeSeatConfinement, hostedCallerStillCommonlyRun };
