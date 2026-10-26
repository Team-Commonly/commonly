/**
 * Where grant and broker writes meet the record (TASK-560, ADR-033 §4).
 * Each function runs after its source write commits, picks the lines from
 * brokerRecordLines, and emits them to the grant's pod chain. Never throws.
 *
 * Pod-target grants only. A seat grant's target is a seat and its approval
 * card lives in a DM, so neither names a pod the call belongs to; those calls
 * stay unrecorded until a pod is ruled for them, rather than being given one.
 * No grant carries a task binding yet (TASK-288), so every line here is
 * taskless and lands on the pod chain.
 */
import {
  agentActor, emitRecord, humanActor, isRecordEnabled, SERVER_ACTOR, type RecordActor,
} from './recordService';
import {
  executedCallLines, expiredCallLines, grantIssuedLine, grantRevokedLine, parkedCallLines,
  refusedCallLines, resolvedCallLines, toolUpdate, type GrantShape,
} from './brokerRecordLines';

/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const lazyUser = () => require('../models/User');
const lazyRoomGrant = () => require('../models/RoomGrant').default;
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

type GrantLike = { grantId?: unknown; target?: { kind?: unknown; id?: unknown } | null } | Record<string, unknown> | null | undefined;

/** The pod a grant belongs to, or null for a seat grant (or no grant). */
export const podOfGrant = (grant: GrantLike): string | null => {
  const target = (grant as { target?: { kind?: unknown; id?: unknown } } | null)?.target;
  return target?.kind === 'pod' && target.id ? String(target.id) : null;
};

/** The calling agent, with its owner, from its user id. Unknown stays null. */
const agentById = async (agentUserId: unknown): Promise<RecordActor | null> => {
  if (!agentUserId) return null;
  const user = await lazyUser().findById(String(agentUserId)).select('_id isBot botMetadata.ownerUserId').lean();
  return agentActor(user || { _id: agentUserId });
};

export type BrokerTrailRow = {
  grant: GrantLike;
  callId: string;
  grantId: string;
  agentUserId: string;
  tool: string;
  outcome: 'ok' | 'refused' | 'failed' | 'pending_approval';
  approvalId?: string;
  credentialOwnerId?: string;
};

/**
 * B1, B2 and B5, from the broker's own trail row. A row that carries an
 * approval id and is not the park itself is the outcome of an approved call;
 * the approval resolver records that, so it is skipped here and never doubles.
 */
export const recordBrokerCall = (row: BrokerTrailRow): void => {
  const podId = podOfGrant(row.grant);
  if (!podId || !isRecordEnabled(podId)) return;
  if (row.approvalId && row.outcome !== 'pending_approval') return;
  emitRecord({ podId }, `tool_call/${row.callId}`, async () => {
    const call = { toolCallId: row.callId, tool: row.tool, grantId: row.grantId, agent: await agentById(row.agentUserId) };
    if (row.outcome === 'refused') return refusedCallLines(call);
    if (row.outcome === 'pending_approval') {
      // Asked of the credential owner, who is the only one who may decide (D5).
      return row.credentialOwnerId ? parkedCallLines(call, String(row.credentialOwnerId), row.approvalId) : [];
    }
    return executedCallLines(call, row.outcome === 'ok');
  });
};

type ParkedCall = { grantId?: unknown; callId?: unknown; tool?: unknown } | null | undefined;
type ApprovalRow = {
  _id?: unknown;
  podId?: unknown;
  agentUserId?: unknown;
  toolCallEnding?: string | null;
};

/**
 * B3 and B4, after the approval row's terminal write. The card's pod is the
 * grant's own pod only for a pod grant; a seat grant's card sits in a DM, so
 * the grant is read to tell them apart.
 */
export const recordApprovalOutcome = (
  row: ApprovalRow,
  parkedCall: ParkedCall,
  outcome: { kind: 'approved' | 'declined'; resolvedBy: string } | { kind: 'expired' },
): void => {
  const cardPodId = row?.podId ? String(row.podId) : '';
  if (!parkedCall?.callId || !parkedCall.grantId || !cardPodId || !isRecordEnabled(cardPodId)) return;
  const approvalId = row._id ? String(row._id) : undefined;
  void (async () => {
    const grant = await lazyRoomGrant().findOne({ grantId: String(parkedCall.grantId) }).select('target').lean();
    if (podOfGrant(grant) !== cardPodId) return;
    emitRecord({ podId: cardPodId }, `approval/${approvalId || parkedCall.callId}/${outcome.kind}`, async () => {
      const call = {
        toolCallId: String(parkedCall.callId),
        tool: String(parkedCall.tool || ''),
        grantId: String(parkedCall.grantId),
        agent: await agentById(row.agentUserId),
      };
      if (outcome.kind === 'expired') return expiredCallLines(call, approvalId);
      const lines = resolvedCallLines(call, outcome.kind === 'approved', outcome.resolvedBy, approvalId);
      if (outcome.kind !== 'approved') return lines;
      return [...lines, toolUpdate(call, row.toolCallEnding === 'ran' ? 'completed' : 'failed')];
    });
  })().catch((error: Error) => console.warn('[record] approval outcome skipped:', error.name, String(error.message || '').slice(0, 160)));
};

/** grant.issued, once the grant row exists and survived the mint race. */
export const recordGrantIssued = (grant: GrantShape & GrantLike, issuer: RecordActor | null): void => {
  const podId = podOfGrant(grant);
  if (!podId || !grant?.grantId) return;
  emitRecord({ podId }, `grant.issued/${grant.grantId}`, [grantIssuedLine(grant, issuer)]);
};

/**
 * grant.revoked for the grants one revoke moved, per pod. The revoked grant
 * comes first; `manual` when it was the only one, `cascade` when descendants
 * went with it (record-v1 §2).
 */
export const recordGrantsRevoked = (
  rootGrantId: string,
  moved: Array<GrantLike>,
  revokedBy: unknown,
): void => {
  const byPod = new Map<string, string[]>();
  for (const grant of moved) {
    const podId = podOfGrant(grant);
    const grantId = (grant as { grantId?: unknown })?.grantId;
    if (!podId || !grantId) continue;
    byPod.set(podId, [...(byPod.get(podId) || []), String(grantId)]);
  }
  const actor = humanActor(revokedBy);
  for (const [podId, ids] of byPod) {
    const grantIds = [rootGrantId, ...ids.filter((id) => id !== rootGrantId)];
    const reason = grantIds.length === 1 ? 'manual' : 'cascade';
    emitRecord({ podId }, `grant.revoked/${rootGrantId}/${[...ids].sort().join(',')}`, [grantRevokedLine(grantIds, reason, actor)]);
  }
};

/**
 * grant.revoked {reason: expired}, written the first time the server sees an
 * expired grant: the broker checks expiry at use, and nothing sweeps it. A
 * grant nobody tries to use again gets no line; R2 says an absent line is an
 * audit gap, never proof the grant is usable.
 */
export const recordGrantExpired = (grant: GrantLike): void => {
  const podId = podOfGrant(grant);
  const grantId = (grant as { grantId?: unknown })?.grantId;
  if (!podId || !grantId) return;
  emitRecord({ podId }, `grant.expired/${grantId}`, [grantRevokedLine([String(grantId)], 'expired', SERVER_ACTOR)]);
};
