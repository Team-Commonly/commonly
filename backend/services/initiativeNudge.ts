/**
 * Stall nudge for an initiative (Initiative v1 row 3; design #2788, §4).
 *
 * Only the selected status drives a nudge, so `needs your check`, `blocked`,
 * `waiting on you` and a stalled part inside a moving initiative never nudge.
 * An episode is dated by the newest evidence when the stall began (the
 * derivation's `activity.since`), not by the run, so repeated runs inside one
 * episode land on one AttentionItem through its unique index.
 *
 * The AttentionItem needs a pod and an initiative spans pods. The nudge goes to
 * the pod of the open linked Task the digest names as "Next" (lowest `taskNum`),
 * else the first `pod` link. With neither, or with no human to receive it,
 * nothing is written and the result says why, for the digest to print. A
 * failed write is reported as `failed`, never as "no human", and the next run
 * retries it.
 */
import type { DerivedInitiativeStatus, InitiativeInput } from './initiativeStatus';

export interface NudgeTask {
  _id: unknown;
  podId: unknown;
  taskNum?: number | null;
  status: string;
  prUrl?: string | null;
}

export interface NudgeInitiative extends InitiativeInput {
  _id: unknown;
  title: string;
  owner?: { userId?: unknown; agentUserId?: unknown } | null;
  nudges?: Array<{ episodeStart: Date | string; nudgedAt: Date | string }>;
}

export type StallNudge =
  | { state: 'not-stalled' }
  | { state: 'already-nudged'; episodeStart: Date }
  | { state: 'no-pod'; episodeStart: Date }
  | { state: 'no-human'; episodeStart: Date; podId: string }
  | { state: 'failed'; episodeStart: Date; podId: string }
  | { state: 'nudged'; episodeStart: Date; podId: string; recipientUserId: string;
    nudge: { episodeStart: Date; nudgedAt: Date } };

const OPEN = new Set(['pending', 'claimed']);

/** The pod a stall nudge is written in, or null when the initiative names none. */
export const nudgePodId = (initiative: NudgeInitiative, tasks: NudgeTask[]): string | null => {
  const taskRefs = new Set(initiative.links.filter((l) => l.kind === 'task').map((l) => l.ref));
  const prRefs = new Set(initiative.links.filter((l) => l.kind === 'pr').map((l) => l.ref));
  const next = tasks
    .filter((t) => (taskRefs.has(String(t._id)) || Boolean(t.prUrl && prRefs.has(t.prUrl)))
      && OPEN.has(t.status) && t.podId)
    .sort((a, b) => (a.taskNum ?? Infinity) - (b.taskNum ?? Infinity))[0];
  if (next) return String(next.podId);
  const pod = initiative.links.find((l) => l.kind === 'pod');
  return pod ? pod.ref : null;
};

export const nudgeStalledInitiative = async (
  initiative: NudgeInitiative,
  derived: DerivedInitiativeStatus,
  tasks: NudgeTask[],
  options: { suppressEmail?: boolean } = {},
): Promise<StallNudge> => {
  // eslint-disable-next-line global-require
  const attention = require('./attentionItemService');
  if (derived.status !== 'stalled') {
    await attention.resolveInitiativeStalls(initiative._id);
    return { state: 'not-stalled' };
  }
  const episodeStart = derived.activity.since;
  await attention.resolveInitiativeStalls(
    initiative._id, attention.initiativeStallSourceId(initiative._id, episodeStart),
  );
  const seen = (initiative.nudges || [])
    .some((n) => new Date(n.episodeStart).getTime() === episodeStart.getTime());
  if (seen) return { state: 'already-nudged', episodeStart };

  const podId = nudgePodId(initiative, tasks);
  if (!podId) return { state: 'no-pod', episodeStart };
  const { recipientUserId, failed } = await attention.recordInitiativeStall({
    initiativeId: initiative._id,
    title: initiative.title,
    podId,
    episodeStart,
    ownerUserId: initiative.owner?.userId,
    ownerAgentUserId: initiative.owner?.agentUserId,
  }, options);
  if (failed) return { state: 'failed', episodeStart, podId };
  if (!recipientUserId) return { state: 'no-human', episodeStart, podId };
  return {
    state: 'nudged', episodeStart, podId, recipientUserId, nudge: { episodeStart, nudgedAt: new Date() },
  };
};
