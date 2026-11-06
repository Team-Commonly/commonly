/**
 * Fail-closed classification of PG `pod_members` mirror rows against Mongo.
 *
 * Shared by scripts/cleanup-ghost-pod-members.ts (the operator sweep) and
 * services/pgMirrorRepairService.ts (the nightly repair, F183):
 *
 *   legitimate : the pod exists in Mongo AND lists the user
 *   ghost      : the pod exists in Mongo, the user is not listed
 *   orphan     : Mongo has no pod with that id (or the id cannot name one)
 *   unreadable : the pod could not be read for any other reason
 *
 * A caller that deletes must refuse when `unreadable > 0`.
 */
import MongoPod from '../models/Pod';
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { isListedPodMember } = require('../utils/isPodMember');

export interface MemberRow {
  podId: string;
  userId: string;
}

export interface MemberClassification {
  legitimate: number;
  /** Pod exists in Mongo and does not list the user. */
  ghostRows: MemberRow[];
  /** Mongo has no pod with that id (or the id cannot name one). */
  orphanRows: MemberRow[];
  /** Rows whose pod could not be read for a reason that is not "not found". */
  unreadable: number;
  unreadablePodIds: string[];
  examples: { legitimate: MemberRow | null; ghost: MemberRow | null; orphan: MemberRow | null };
}

type PodMembersReader = (podId: string) => Promise<{ members?: unknown[] } | null>;

const readPodMembers: PodMembersReader = async (podId) => (
  (await MongoPod.findById(podId).select('members').lean()) as { members?: unknown[] } | null
);

/**
 * The fail-closed classifier, shared with the nightly mirror repair
 * (services/pgMirrorRepairService.ts, F183). It reads Mongo per pod and sorts
 * every row into legitimate / ghost / orphan / unreadable. A caller that
 * deletes must refuse when `unreadable > 0`: "cannot read this pod" is never
 * "this pod does not exist".
 */
export async function classifyMemberRows(
  rows: MemberRow[],
  readPod: PodMembersReader = readPodMembers,
): Promise<MemberClassification> {
  const out: MemberClassification = {
    legitimate: 0,
    ghostRows: [],
    orphanRows: [],
    unreadable: 0,
    unreadablePodIds: [],
    examples: { legitimate: null, ghost: null, orphan: null },
  };

  const rowsByPod = new Map<string, MemberRow[]>();
  for (const row of rows) {
    const bucket = rowsByPod.get(row.podId);
    if (bucket) bucket.push(row);
    else rowsByPod.set(row.podId, [row]);
  }

  for (const [podId, podRows] of rowsByPod) {
    let doc: { members?: unknown[] } | null = null;
    try {
      doc = await readPod(podId);
    } catch (err) {
      // Fail closed. "Cannot read this pod" is not "this pod does not exist":
      // the second reading authorises a delete, so a transient failure must
      // never be allowed to take on that meaning.
      if ((err as { name?: string })?.name === 'CastError') {
        // A pod id Mongo cannot even parse cannot name a pod. Same class as
        // an id Mongo does not have, and not a failure to read.
        out.orphanRows.push(...podRows);
        if (!out.examples.orphan) out.examples.orphan = podRows[0];
        continue;
      }
      out.unreadable += podRows.length;
      out.unreadablePodIds.push(podId);
      continue;
    }

    if (doc === null) {
      out.orphanRows.push(...podRows);
      if (!out.examples.orphan) out.examples.orphan = podRows[0];
      continue;
    }

    for (const row of podRows) {
      if (isListedPodMember(doc, row.userId)) {
        out.legitimate += 1;
        if (!out.examples.legitimate) out.examples.legitimate = row;
      } else {
        out.ghostRows.push(row);
        if (!out.examples.ghost) out.examples.ghost = row;
      }
    }
  }
  return out;
}

