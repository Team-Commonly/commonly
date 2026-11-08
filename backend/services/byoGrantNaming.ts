/**
 * F94: a grant may name the granter's own agents that run outside Commonly
 * (any harness in CONFINING_ADAPTERS, through the `commonly` daemon), read-only.
 *
 * The threat is plain: connector text can be written by outsiders (a Jira
 * comment, a shared Notion page, a Sentry event), and an agent with its own
 * shell and network cannot be held to anything once it has read that text. So
 * the grant is allowed only where the person who owns the data also owns the
 * agent and says yes to that, and never for the whole pod:
 *   - read only, and never a Limited Use connector (Calendar stays hosted-only).
 *     The one write it may hold is pull-request access on a GitHub App grant
 *     (TASK-783, `prWriteScope.ts`), every call parked for the granter;
 *   - every named agent is in the audience, is an agent, and is solely
 *     installed by the granter;
 *   - the granter ticked the consent, which records each agent's sandbox state;
 *   - an agent on a machine with no sandbox Commonly can enforce (native
 *     Windows) is never named: that refusal is not liftable (ruling A, 11-04).
 * The pod checks (private, invite-only, unbridged) still run in full.
 */
import User from '../models/User';
import type { IRoomGrant, IRoomGrantByoConsent } from '../models/RoomGrant';
import { LIMITED_USE_ENTRIES, isLimitedUseTool } from './limitedUseConnectors';
import { ownsRuntimeIdentity } from './runtimeIdentityOwnership';
import { judgeSeatConfinement } from './seatGrantConfinement';
import { CONFINING_ADAPTERS, PUBLIC_ONLY_GRANT_ADAPTERS, PUBLIC_ONLY_REASON } from './grantBrokerConfinement';
import { harnessCatalogEntry } from '../config/harnessCatalog';

/**
 * "Claude Code, Codex or OpenCode": the harnesses an agent can be NAMED on a
 * grant from, by their catalogue names, from the one list the confinement
 * check reads. pi, Qwen and Goose are left out (F175c, F175d): each holds a
 * grant only on a public seat, which needs no naming, and naming lifts nothing
 * for it.
 */
export const grantHarnessNames = (): string => {
  const names = [...CONFINING_ADAPTERS.keys()]
    .filter((id) => !PUBLIC_ONLY_GRANT_ADAPTERS.has(id))
    .map((id) => harnessCatalogEntry(id)?.label || id);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
};

export type ByoNamingRefusal = 'byo_read_only' | 'byo_limited_use' | 'byo_not_audience'
  | 'byo_not_agent' | 'byo_agent_not_owned' | 'byo_unconfined_host' | 'byo_adapter_unsupported'
  | 'byo_consent_required';

export const byoNamingRefusalMessage = (reason: ByoNamingRefusal): string => ({
  byo_read_only: 'An agent that runs on your computer can be named only on a read-only grant, '
    + 'or on one whose only write is opening a pull request.',
  byo_limited_use: 'This connector is used only by Commonly-hosted agents.',
  byo_not_audience: 'Name an agent that this grant reaches.',
  byo_not_agent: 'Only an agent can be named on a grant.',
  byo_agent_not_owned: 'You can name only an agent you installed, and that no one else installed.',
  byo_unconfined_host: 'This agent ran without a sandbox Commonly can enforce, so no grant can be used from it.',
  byo_adapter_unsupported: `Only a ${grantHarnessNames()} agent can be named on a grant.`,
  byo_consent_required: 'Confirm that what this agent reads can leave through it.',
}[reason]);

type NamingFields = { byoAgents?: unknown; byoConsent?: unknown } | IRoomGrant | null | undefined;

/** The agents a grant names, honoured only with its consent record. */
export const namedByoAgentIds = (grant: object | NamingFields): string[] => {
  const value = grant as { byoAgents?: unknown; byoConsent?: unknown } | null | undefined;
  if (!value?.byoConsent || !Array.isArray(value.byoAgents)) return [];
  return value.byoAgents.map(String);
};

export const grantNamesAgent = (grant: object | NamingFields, agentUserId: unknown): boolean => (
  Boolean(agentUserId) && namedByoAgentIds(grant).includes(String(agentUserId))
);

/**
 * Of `ids`, the agents that still qualify now, read on every use (clause E's
 * per-request check): each is still an agent installed by the granter alone,
 * and the consent was the granter's. A second installer of the identity after
 * the mint ends its naming from that request on, without touching the row.
 */
const stillOwnedByGranter = async (grant: object | NamingFields, named: string[]): Promise<string[]> => {
  if (!named.length) return [];
  const value = grant as { ownerId?: unknown; byoConsent?: { by?: unknown } };
  const ownerId = String(value.ownerId || '');
  if (!ownerId || String(value.byoConsent?.by || '') !== ownerId) return [];
  const users = await User.find({ _id: { $in: named }, botType: 'agent' })
    .select('botMetadata.agentName botMetadata.instanceId').lean() as Array<{
      _id: unknown; botMetadata?: { agentName?: string; instanceId?: string };
    }>;
  const live: string[] = [];
  for (const user of users) {
    const agentName = user.botMetadata?.agentName;
    if (!agentName) continue;
    // eslint-disable-next-line no-await-in-loop
    const ownership = await ownsRuntimeIdentity(ownerId, agentName, user.botMetadata?.instanceId || 'default');
    if (ownership.owned) live.push(String(user._id));
  }
  return named.filter((id) => live.includes(id));
};

/**
 * The agents the pod gate exempts: every agent the lineage's consent covers,
 * still solely the granter's. It reads the consent, which a child inherits,
 * not the child's `byoAgents`, so a child scoped away from the named agent
 * still passes the gate in the pod that agent shares. Removing an agent takes
 * it out of the consent too, so while it stays in the pod the lineage is
 * refused (fail closed: it would still read what the grant posts there).
 */
export const byoPodExemptAgentIds = async (grant: object | NamingFields): Promise<string[]> => {
  const consent = (grant as { byoConsent?: IRoomGrantByoConsent }).byoConsent;
  if (!consent || !Array.isArray(consent.agents)) return [];
  return stillOwnedByGranter(grant, consent.agents.map((agent) => String(agent.userId)));
};

/**
 * Whether naming lets this agent use the grant unconfined. Only an agent the
 * consent recorded as not confined: one recorded `confined` consented without
 * the no-sandbox wording, so if its seat later stops confining, it is refused
 * like any other until the granter names it again.
 */
export const namingLiftsFor = async (grant: object | NamingFields, agentUserId: unknown): Promise<boolean> => {
  if (!grantNamesAgent(grant, agentUserId)) return false;
  const consent = (grant as { byoConsent?: IRoomGrantByoConsent }).byoConsent;
  const recorded = consent?.agents?.find((agent) => String(agent.userId) === String(agentUserId));
  if (!recorded || recorded.sandbox === 'confined') return false;
  return (await stillOwnedByGranter(grant, [String(agentUserId)])).includes(String(agentUserId));
};

/**
 * Naming lifts a refusal about the seat's sandbox. It never lifts an adapter
 * that is not approved for the broker, nor one approved only on a public seat
 * (pi, Qwen, Goose: `adapter_confines_public_only`; the daemon applies the same rule), nor
 * a machine with no enforceable sandbox (`hostUnconfined`, checked by callers).
 */
export const namingLiftsRefusal = (refusal: { reason?: unknown } | null | undefined): boolean => (
  Boolean(refusal) && refusal?.reason !== 'adapter_cannot_confine' && refusal?.reason !== PUBLIC_ONLY_REASON
);

type SandboxState = IRoomGrantByoConsent['agents'][number]['sandbox'];

/**
 * What the consent line may say about an agent's sandbox. `confined` needs
 * positive evidence: the seat is bound to a machine (so the daemon spawns it
 * and applies its public baseline) and the server judged its declaration
 * confinable. A server "no refusal" alone also covers a row with no sandbox
 * block at all, which for a bring-your-own install (its token pasted into the
 * person's own client, runtimeType `webhook`) means nothing confines it, so
 * that reads as `unknown`, which the consent line treats as no sandbox.
 */
export const sandboxStateFor = (
  judgement: { refusal: unknown; scope?: string },
  seat: { machineId?: unknown; runtimeType?: unknown },
): SandboxState => {
  if (judgement.refusal) return 'unconfined';
  const daemonSpawned = typeof seat.machineId === 'string' && seat.machineId !== ''
    && String(seat.runtimeType || '').toLowerCase() !== 'webhook';
  return judgement.scope === 'seat' && daemonSpawned ? 'confined' : 'unknown';
};

export type ByoNamingResult =
  | { refusal: ByoNamingRefusal; consent?: undefined }
  | { refusal: null; consent: IRoomGrantByoConsent };

export const checkByoNaming = async (input: {
  byoAgents: string[];
  consented: unknown;
  granterId: string;
  audience: string[];
  writeMode: unknown;
  entryId?: string;
  tools: string[];
  /** The grant's pod: the install read here must be the one the form read. */
  podId?: string;
  /**
   * TASK-783: the grant holds pull-request access, already checked by the mint
   * (`prWriteMintRefusal`: write-with-confirm, a GitHub App, and no write but
   * the PR tools). That is the one write a named agent may hold, each call
   * parked for the granter; every other write keeps `byo_read_only`.
   */
  prWrite?: boolean;
}): Promise<ByoNamingResult> => {
  if (input.writeMode !== 'read' && !(input.prWrite === true && input.writeMode === 'write-with-confirm')) {
    return { refusal: 'byo_read_only' };
  }
  if ((input.entryId && LIMITED_USE_ENTRIES.has(input.entryId)) || input.tools.some(isLimitedUseTool)) {
    return { refusal: 'byo_limited_use' };
  }
  if (input.byoAgents.some((id) => !input.audience.includes(id))) return { refusal: 'byo_not_audience' };
  const users = await User.find({ _id: { $in: input.byoAgents } })
    .select('botType botMetadata.agentName botMetadata.instanceId botMetadata.machineId').lean() as Array<{
      _id: unknown; botType?: string; botMetadata?: { agentName?: string; instanceId?: string; machineId?: string };
    }>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentInstallation } = require('../models/AgentRegistry');
  if (users.length !== input.byoAgents.length) return { refusal: 'byo_not_agent' };
  const agents: IRoomGrantByoConsent['agents'] = [];
  for (const user of users) {
    const agentName = String(user.botMetadata?.agentName || '').trim().toLowerCase();
    const instanceId = String(user.botMetadata?.instanceId || 'default');
    if (user.botType !== 'agent' || !agentName) return { refusal: 'byo_not_agent' };
    // eslint-disable-next-line no-await-in-loop -- a grant names a handful of agents
    const ownership = await ownsRuntimeIdentity(input.granterId, agentName, instanceId);
    if (!ownership.owned) return { refusal: 'byo_agent_not_owned' };
    // eslint-disable-next-line no-await-in-loop
    const judgement = await judgeSeatConfinement({ agentUserId: String(user._id), agentName, instanceId });
    if (judgement.hostUnconfined) return { refusal: 'byo_unconfined_host' };
    if (judgement.refusal && !namingLiftsRefusal(judgement.refusal)) return { refusal: 'byo_adapter_unsupported' };
    // eslint-disable-next-line no-await-in-loop
    const installation = await AgentInstallation.findOne({
      agentName, instanceId, installedBy: input.granterId, status: 'active', ...(input.podId ? { podId: input.podId } : {}),
    }).select('config.runtime.runtimeType').lean();
    agents.push({
      userId: String(user._id),
      sandbox: sandboxStateFor(judgement, {
        machineId: user.botMetadata?.machineId, runtimeType: installation?.config?.runtime?.runtimeType,
      }),
    });
  }
  if (input.consented !== true) return { refusal: 'byo_consent_required' };
  // The form's words differ when the grant holds pull-request access, so the
  // record says which ones the person agreed to.
  const version = input.prWrite === true ? 'byo-pr-v1' : 'byo-v1';
  return { refusal: null, consent: { by: input.granterId, at: new Date(), version, agents } };
};

export interface ByoCandidate {
  userId: string;
  agentName: string;
  instanceId: string;
  /** Can this grant name it at all; when not, `reason` says why. */
  nameable: boolean;
  reason?: 'unconfined_host' | 'adapter_unsupported';
  sandbox: IRoomGrantByoConsent['agents'][number]['sandbox'];
  /**
   * F179: the seat was placed on a machine whose daemon hasn't adopted it yet.
   * Until it does, the server has no machine to read the sandbox from, so
   * `sandbox` describes the unbound seat, not where it will run. Display only:
   * nothing that enforces a grant reads it, and the mint judges again.
   */
  awaitingMachine?: true;
}

/**
 * The caller's own agents in a pod that run outside the narrowed native
 * runtime, with what the server knows of each one's sandbox. The grant form
 * reads this before the person consents, so the line it shows names the
 * sandbox state the mint will record. Agents someone else installed are left
 * out: they could never be named by this caller.
 */
export const listByoCandidates = async (podId: string, callerId: string): Promise<ByoCandidate[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { AgentInstallation } = require('../models/AgentRegistry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { runsInNarrowedProcess } = require('./hostedEngine');
  const pod = await Pod.findById(podId).select('members').lean();
  if (!pod) return [];
  const users = await User.find({ _id: { $in: (pod.members || []).map(String) }, botType: 'agent' })
    .select('botMetadata.agentName botMetadata.instanceId botMetadata.machineId botMetadata.requestedMachineId')
    .lean() as Array<{
      _id: unknown;
      botMetadata?: { agentName?: string; instanceId?: string; machineId?: string; requestedMachineId?: string | null };
    }>;
  const out: ByoCandidate[] = [];
  for (const user of users) {
    const agentName = String(user.botMetadata?.agentName || '').trim().toLowerCase();
    const instanceId = String(user.botMetadata?.instanceId || 'default');
    if (!agentName) continue;
    // eslint-disable-next-line no-await-in-loop -- a pod holds at most a few agents
    const installation = await AgentInstallation.findOne({ podId, agentName, instanceId, status: 'active' })
      .select('config').lean();
    if (!installation || runsInNarrowedProcess(installation)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await ownsRuntimeIdentity(callerId, agentName, instanceId)).owned) continue;
    // eslint-disable-next-line no-await-in-loop
    const judgement = await judgeSeatConfinement({ agentUserId: String(user._id), agentName, instanceId });
    const base = { userId: String(user._id), agentName, instanceId };
    // Placed on a machine its daemon hasn't adopted yet: judged unbound for now.
    const awaitingMachine = Boolean(user.botMetadata?.requestedMachineId) && !user.botMetadata?.machineId;
    const awaiting = awaitingMachine ? { awaitingMachine: true as const } : {};
    if (judgement.hostUnconfined) {
      out.push({ ...base, nameable: false, reason: 'unconfined_host', sandbox: 'unconfined' });
    } else if (judgement.refusal && !namingLiftsRefusal(judgement.refusal)) {
      out.push({ ...base, nameable: false, reason: 'adapter_unsupported', sandbox: 'unknown', ...awaiting });
    } else {
      out.push({
        ...base,
        nameable: true,
        sandbox: sandboxStateFor(judgement, {
          machineId: user.botMetadata?.machineId, runtimeType: installation.config?.runtime?.runtimeType,
        }),
        ...awaiting,
      });
    }
  }
  return out;
};
