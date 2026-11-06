// What POST /api/registry/agents/:name/pods/:podId copies, and from which row.
// The route then runs the install path, so this file holds only what an install
// body would otherwise have had to guess for a running agent.
import { AgentInstallation, AgentRegistry } from '../models/AgentRegistry';
import Pod from '../models/Pod';
import { DM_POD_TYPES_GUARD } from './agentIdentityService';
import { IDENTITY_COLLATION, installationIdentityFilter } from './agentInstallationIdentity';
import { PROJECTION_OWN_KEYS } from './dmService';

/**
 * Config that belongs to one pod's row, not to the agent. On top of what a DM
 * leaves behind (PROJECTION_OWN_KEYS), the wake choices: Settings writes them
 * per pod, and approvalActionService's create_pod clone drops wakeOnMessage for
 * the same reason, so the new pod gets its own default (wakeDefaultService).
 * `hosted` is the kernel's record of the engine, which install rebuilds.
 */
const POD_OWN_CONFIG_KEYS = new Set(['wakeOnMessage', 'boardWake', 'welcomeWake', 'digestWake', 'hosted']);

export const inheritablePodConfig = (config?: Record<string, unknown> | null): Record<string, unknown> => (
  Object.fromEntries(Object.entries(config || {})
    .filter(([key]) => !PROJECTION_OWN_KEYS.has(key) && !POD_OWN_CONFIG_KEYS.has(key)))
);

type SourceRow = {
  podId: unknown;
  status: string;
  version?: string;
  scopes?: string[];
  config?: ({ autoJoinSource?: unknown; runtime?: { runtimeType?: unknown } } & Record<string, unknown>) | null;
};
export type AdditionSource =
  | { source: SourceRow; fromProjection: boolean; refusal?: undefined }
  | { refusal: { status: number; body: Record<string, unknown> }; source?: undefined };

const refuse = (status: number, code: string, error: string): AdditionSource => ({
  refusal: { status, body: { code, error } },
});

const NOT_OWNER = (): AdditionSource => refuse(403, 'not_agent_owner', 'Only the agent\'s owner can add it to a pod.');

const hasRuntime = (row: SourceRow) => Boolean(row.config?.runtime?.runtimeType);

/**
 * The row to copy, or why not. Ownership is the Settings test (`installedBy`,
 * on a row that isn't uninstalled, in a pod that still exists), on rows that
 * name an owner. A DM's row and a row a mention pulled in don't: they name
 * whoever opened the DM or typed the mention (dmService, agentMentionService).
 *
 * A DM row is copied only when it is all that's left and the caller published
 * the agent, which they can't be as a guest. An `agent-dm` row carries no
 * runtime, so there is nothing to copy from one.
 */
export const resolveAdditionSource = async (
  agentName: string, instanceId: string, userId: unknown,
): Promise<AdditionSource> => {
  const rows = await AgentInstallation.find({
    ...installationIdentityFilter(agentName, instanceId), installedBy: userId, status: { $ne: 'uninstalled' },
  }).collation(IDENTITY_COLLATION).sort({ createdAt: 1, _id: 1 }).lean() as unknown as SourceRow[];
  const pods = await Pod.find({ _id: { $in: rows.map((row) => row.podId) } }).select('type').lean();
  const podType = new Map(pods.map((pod: { _id: unknown; type?: string }) => [String(pod._id), String(pod.type)]));
  const standing = rows.filter((row) => podType.has(String(row.podId)));
  const inDm = (row: SourceRow) => DM_POD_TYPES_GUARD.has(podType.get(String(row.podId)) as string);
  const namesOwner = standing.filter((row) => !inDm(row) && !row.config?.autoJoinSource);

  if (namesOwner.length) {
    const active = namesOwner.filter((row) => row.status === 'active');
    // Adding would bring a paused agent back, and with nothing active the
    // install path takes the identity for dormant and revokes its tokens.
    if (!active.length) return refuse(409, 'agent_not_active', 'This agent isn\'t active in any pod. Resume it first.');
    return { source: active.find(hasRuntime) || active[0], fromProjection: false };
  }

  const dmRows = standing.filter((row) => inDm(row) && row.status === 'active');
  if (!dmRows.length) return NOT_OWNER();
  const entry = await AgentRegistry.findOne({ agentName }).select('publisher.userId').lean() as
    { publisher?: { userId?: unknown } } | null;
  if (String(entry?.publisher?.userId || '') !== String(userId)) return NOT_OWNER();
  const source = dmRows.find(hasRuntime);
  if (!source) {
    return refuse(409, 'agent_source_has_no_runtime', 'This agent only has a DM row, with no runtime to copy. Install it into a pod first.');
  }
  return { source, fromProjection: true };
};

/**
 * A source can name an owner and still have no runtime, because its agent runs
 * from a projection. The new row needs that runtime: routing takes the newest
 * row with the key set, so a null copied here would hide the working one.
 */
export const withRoutedRuntime = async (
  config: Record<string, unknown>, agentName: string, instanceId: string,
): Promise<Record<string, unknown>> => {
  if ((config.runtime as { runtimeType?: unknown } | undefined)?.runtimeType) return config;
  const sibling = await AgentInstallation.findOne({
    ...installationIdentityFilter(agentName, instanceId),
    status: 'active',
    'config.runtime.runtimeType': { $nin: [null, ''] },
  }).collation(IDENTITY_COLLATION).sort({ createdAt: -1 }).select('config.runtime')
    .lean() as { config?: { runtime?: unknown } } | null;
  return sibling?.config?.runtime ? { ...config, runtime: sibling.config.runtime } : config;
};

/**
 * Whether someone else owns a row of this name. A DM's row and a row a mention
 * pulled in name a guest or a typist, not an owner (resolveAdditionSource).
 */
export const hasForeignOwner = async (
  agentName: string, instanceId: string, userId: unknown,
): Promise<boolean> => {
  const rows = await AgentInstallation.find({
    ...installationIdentityFilter(agentName, instanceId), installedBy: { $ne: userId },
  }).collation(IDENTITY_COLLATION).select('podId config.autoJoinSource').lean() as unknown as SourceRow[];
  const candidates = rows.filter((row) => !row.config?.autoJoinSource);
  if (!candidates.length) return false;
  const dmPods = await Pod.find({
    _id: { $in: candidates.map((row) => row.podId) }, type: { $in: [...DM_POD_TYPES_GUARD] },
  }).select('_id').lean();
  const inDm = new Set(dmPods.map((pod: { _id: unknown }) => String(pod._id)));
  return candidates.some((row) => !inDm.has(String(row.podId)));
};

export default {
  inheritablePodConfig, resolveAdditionSource, withRoutedRuntime, hasForeignOwner,
};
