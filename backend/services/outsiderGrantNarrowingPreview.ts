/**
 * F164 (TASK-781, D244): say where a seat loses writes to the outsider-grant
 * narrowing, to the humans who can act on it.
 *
 * agentRuntimeAuth confines a token-holding seat's pod writes once an
 * outsider-writable grant reaches any of its installation pods: one such pod
 * leaves it writing there only, two or more leave it writing nowhere (403
 * `outsider_grant_runtime_narrowed`). That is deliberate and unchanged here.
 * This module only reports it, from the same census
 * (podsWithOutsiderWritableGrants) and the same write rule
 * (podWriteSurvivesNarrowing) the guard runs, so a warning and the guard
 * cannot disagree.
 *
 * Pod names are shown only for pods the viewer can see (DMService.canViewPod).
 * Any other pod is a count, never a name or an id.
 */
import Pod from '../models/Pod';
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';
import { installationIdentityFilter } from './agentInstallationIdentity';
import { podsWithOutsiderWritableGrants } from './nativeOutsiderGrantPolicy';
import { podWriteSurvivesNarrowing } from './outsiderGrantNarrowingRule';
import { runsInNarrowedProcess } from './hostedEngine';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const DMService = require('./dmService') as {
  canViewPod: (userId: unknown, pod: { type?: string; members?: unknown[] } | null) => Promise<boolean>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const AgentIdentityService = require('./agentIdentityService') as {
  buildAgentUsername: (agentType: string, instanceId: string) => string;
  resolveAgentType: (agentNameOrType: string) => string;
};

export const RUNTIME_NARROWED_CODE = 'outsider_grant_runtime_narrowed';
export const NARROWING_CONFIRM_CODE = 'outsider_grant_narrowing_confirm_required';

export interface NarrowingPodRef { podId: string; name: string }

export interface InstallNarrowingPreview {
  code: typeof RUNTIME_NARROWED_CODE;
  /** Pods the seat writes in today and would not after the install, that the viewer can see. */
  losesWrites: NarrowingPodRef[];
  /** How many more such pods the viewer cannot see. */
  hiddenLosesWritesCount: number;
  /** Whether the seat could write in the pod it is being installed into. */
  targetWritable: boolean;
}

export type InstallNarrowingResult =
  | { status: 'clear' }
  | { status: 'warn'; preview: InstallNarrowingPreview }
  // The census could not be read. The guard fails closed on the same failure,
  // so the install asks for a confirm rather than going ahead quietly.
  | { status: 'unavailable' };

const objectId = (value: unknown): string | null => {
  const id = String(value || '');
  return /^[a-f\d]{24}$/i.test(id) ? id.toLowerCase() : null;
};

const identityInstallationPodIds = async (agentName: string, instanceId: string): Promise<string[]> => {
  const rows = await AgentInstallation.find({
    ...installationIdentityFilter(agentName, instanceId || 'default'),
    status: 'active',
  }).select('podId').lean() as Array<{ podId?: unknown }>;
  return [...new Set(rows.map((row) => objectId(row.podId)).filter((id): id is string => Boolean(id)))];
};

/** Split pods into the ones the viewer may see by name and a count of the rest. */
const namePodsForViewer = async (
  podIds: string[], viewerId: unknown,
): Promise<{ visible: NarrowingPodRef[]; hiddenCount: number }> => {
  if (!podIds.length) return { visible: [], hiddenCount: 0 };
  const pods = await Pod.find({ _id: { $in: podIds } }).select('_id name type members').lean() as Array<{
    _id: unknown; name?: string; type?: string; members?: unknown[];
  }>;
  const byId = new Map(pods.map((pod) => [String(pod._id), pod]));
  const visible: NarrowingPodRef[] = [];
  let hiddenCount = 0;
  for (const podId of podIds) {
    const pod = byId.get(podId);
    // eslint-disable-next-line no-await-in-loop
    if (pod && await DMService.canViewPod(viewerId, pod)) {
      visible.push({ podId, name: String(pod.name || 'Pod') });
    } else {
      hiddenCount += 1;
    }
  }
  return { visible, hiddenCount };
};

/**
 * What installing (agentName, instanceId) into `targetPodId` would do to its
 * writes. Only seats that authenticate with a runtime token meet the guard; an
 * install that runs in Commonly's narrowed process holds none, so it is clear.
 */
export const previewInstallNarrowing = async ({
  agentName, instanceId, targetPodId, viewerId, runtimeType, hostedEngine,
}: {
  agentName: string;
  instanceId: string;
  targetPodId: string;
  viewerId: unknown;
  runtimeType?: unknown;
  hostedEngine?: unknown;
}): Promise<InstallNarrowingResult> => {
  if (runsInNarrowedProcess({ config: { runtime: { runtimeType }, hosted: { engine: hostedEngine } } })) {
    return { status: 'clear' };
  }
  const target = objectId(targetPodId);
  if (!target) return { status: 'clear' };
  try {
    const current = (await identityInstallationPodIds(agentName, instanceId)).filter((id) => id !== target);
    // A new seat has no other pod to lose, and alone in one pod it writes there.
    if (!current.length) return { status: 'clear' };
    // The same principal the install's ensureAgentInPod adds to the pod.
    const agentUser = await User.findOne({
      username: AgentIdentityService.buildAgentUsername(
        AgentIdentityService.resolveAgentType(agentName), instanceId || 'default',
      ),
      isBot: true,
    }).select('_id').lean() as { _id?: unknown } | null;
    const before = await podsWithOutsiderWritableGrants(current);
    const after = await podsWithOutsiderWritableGrants([...current, target], agentUser?._id
      ? { addMember: { podId: target, userId: String(agentUser._id) } } : {});
    const lost = current.filter((podId) => podWriteSurvivesNarrowing(before, podId)
      && !podWriteSurvivesNarrowing(after, podId));
    const targetWritable = podWriteSurvivesNarrowing(after, target);
    if (!lost.length && targetWritable) return { status: 'clear' };
    const { visible, hiddenCount } = await namePodsForViewer(lost, viewerId);
    return {
      status: 'warn',
      preview: {
        code: RUNTIME_NARROWED_CODE, losesWrites: visible, hiddenLosesWritesCount: hiddenCount, targetWritable,
      },
    };
  } catch (error) {
    console.error('[install] outsider grant narrowing preview failed:', error);
    return { status: 'unavailable' };
  }
};

/** The refusal text a client without its own copy (the CLI, a script) shows. */
export const installNarrowingMessage = (agentName: string, result: InstallNarrowingResult): string => {
  if (result.status !== 'warn') {
    return `Could not check whether installing ${agentName} here would limit where it can write. `
      + 'Send confirmNarrowing: true to install anyway.';
  }
  const { losesWrites, hiddenLosesWritesCount, targetWritable } = result.preview;
  const names = losesWrites.map((pod) => pod.name);
  if (hiddenLosesWritesCount) {
    names.push(`${hiddenLosesWritesCount} other pod${hiddenLosesWritesCount === 1 ? '' : 's'}`);
  }
  const parts = [];
  if (names.length) parts.push(`it would stop writing in ${names.join(', ')}`);
  if (!targetWritable) parts.push('it could not write in this pod either');
  return `An outside-writable grant would reach ${agentName}'s pods, so ${parts.join(', and ')}. `
    + 'Send confirmNarrowing: true to install anyway.';
};

export interface RuntimeNarrowingStatus {
  code: typeof RUNTIME_NARROWED_CODE;
  /** How many of the seat's pods an outsider-writable grant reaches. */
  narrowedPodCount: number;
  /** The one pod it can still write in (exactly one reached pod), when the viewer can see it. */
  writablePod: NarrowingPodRef | null;
  /** True when that one pod exists but the viewer cannot see it. */
  writablePodHidden: boolean;
  /** The census failed; runtime auth refuses every write until it reads. */
  unavailable?: boolean;
}

/**
 * The owner's readable form of the 403: whether runtime auth is narrowing this
 * seat now, and where it can still write. Null when nothing narrows it.
 */
export const runtimeNarrowingStatus = async ({
  agentName, instanceId, viewerId,
}: { agentName: string; instanceId: string; viewerId: unknown }): Promise<RuntimeNarrowingStatus | null> => {
  let podIds: string[];
  let narrowed: Set<string>;
  try {
    const installations = await AgentInstallation.find({
      ...installationIdentityFilter(agentName, instanceId || 'default'),
      status: 'active',
    }).select('podId config').lean() as Array<{ podId?: unknown; config?: unknown }>;
    // A seat Commonly runs in-process holds no runtime token, so the guard never sees it.
    if (!installations.length || installations.every((row) => runsInNarrowedProcess(row))) return null;
    podIds = [...new Set(installations.map((row) => objectId(row.podId)).filter((id): id is string => Boolean(id)))];
    narrowed = await podsWithOutsiderWritableGrants(podIds);
  } catch (error) {
    // Runtime auth refuses every write on this failure, so the page says it could not check.
    console.error('[agent-settings] outsider grant narrowing status failed:', error);
    return {
      code: RUNTIME_NARROWED_CODE, narrowedPodCount: 0, writablePod: null, writablePodHidden: false, unavailable: true,
    };
  }
  // One reached pod out of one loses nothing: the seat writes where it lives.
  if (!narrowed.size || (narrowed.size === 1 && podIds.length === 1)) return null;
  const onlyPod = narrowed.size === 1 ? [...narrowed][0] : null;
  const named = onlyPod ? await namePodsForViewer([onlyPod], viewerId) : { visible: [], hiddenCount: 0 };
  return {
    code: RUNTIME_NARROWED_CODE,
    narrowedPodCount: narrowed.size,
    writablePod: named.visible[0] || null,
    writablePodHidden: named.hiddenCount > 0,
  };
};
