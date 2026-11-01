/**
 * Record lines for room grants and brokered connector calls: ADR-033 §4, the
 * B1–B5 table, field for field. Pure: callers decide when a source write has
 * committed and which chain the lines belong to.
 *
 * No line carries argsDigest. The CTO's launch rule (ADR-033 §8 q9) omits it
 * from every server line until a keyed-digest decision is accepted; the
 * broker's internal tool_calls.args_digest is unchanged and never copied here.
 */
import type { RecordActor, RecordLineInput } from './recordService';

/** The two answers an approval card offers, as ACP option kinds. */
export const OPTS = Object.freeze([
  Object.freeze({ optionId: 'approve', kind: 'allow_once' }),
  Object.freeze({ optionId: 'decline', kind: 'reject_once' }),
]);

export type BrokerCall = {
  /** tool_calls.call_id, ApprovalAction.toolCall.callId. */
  toolCallId: string;
  /** The exact tool name. The broker holds no agent-written title, so it is also the title and question. */
  tool: string;
  grantId: string;
  /** The calling agent; null when it cannot be resolved (never guessed). */
  agent: RecordActor | null;
};

const policyAsk = (grantId: string) => ({ id: `grant:${grantId}`, role: 'policy' });

const toolCall = (call: BrokerCall): RecordLineInput => ({
  kind: 'tool.call',
  actor: call.agent,
  data: { toolCallId: call.toolCallId, title: call.tool, name: call.tool, surface: 'connector' },
});

const requested = (call: BrokerCall, askedOf: { id: string; role: string }, decisionCardId?: string): RecordLineInput => ({
  kind: 'permission.requested',
  actor: call.agent,
  data: {
    toolCallId: call.toolCallId,
    options: OPTS.map((option) => ({ ...option })),
    question: call.tool,
    askedOf,
    grantId: call.grantId,
    ...(decisionCardId ? { decisionCardId } : {}),
  },
});

type Decision = {
  approve: boolean;
  list: 'allow' | 'deny' | 'ask';
  approval?: 'approved' | 'rejected' | 'timed_out';
  decidedBy: string;
  decidedByRole: 'policy' | 'credential-owner';
  decisionCardId?: string;
};

// permission.decided takes the spec's default actor: the policy
// (grant:<grantId>) or the human decider, derived from decidedBy.
const decided = (call: BrokerCall, decision: Decision): RecordLineInput => ({
  kind: 'permission.decided',
  data: {
    outcome: 'selected',
    optionId: decision.approve ? 'approve' : 'decline',
    kind: decision.approve ? 'allow_once' : 'reject_once',
    toolCallId: call.toolCallId,
    rule: { list: decision.list, pattern: null },
    ...(decision.approval ? { approval: decision.approval } : {}),
    decidedBy: decision.decidedBy,
    decidedByRole: decision.decidedByRole,
    grantId: call.grantId,
    ...(decision.decisionCardId ? { decisionCardId: decision.decisionCardId } : {}),
  },
});

export const toolUpdate = (call: Pick<BrokerCall, 'toolCallId' | 'agent'>, status: 'completed' | 'failed'): RecordLineInput => ({
  kind: 'tool.update',
  actor: call.agent,
  data: { toolCallId: call.toolCallId, status },
});

/** B1: the broker refused before reaching the vendor. */
export const refusedCallLines = (call: BrokerCall): RecordLineInput[] => [
  toolCall(call),
  requested(call, policyAsk(call.grantId)),
  decided(call, { approve: false, list: 'deny', decidedBy: 'policy', decidedByRole: 'policy' }),
  toolUpdate(call, 'failed'),
];

/** B2: a write parked for the credential owner's approval. No decision yet. */
export const parkedCallLines = (call: BrokerCall, ownerUserId: string, decisionCardId?: string): RecordLineInput[] => [
  toolCall(call),
  requested(call, { id: ownerUserId, role: 'credential-owner' }, decisionCardId),
];

/** B3: the credential owner approved or declined the parked call. */
export const resolvedCallLines = (
  call: BrokerCall,
  approved: boolean,
  resolvedBy: string,
  decisionCardId?: string,
): RecordLineInput[] => [
  decided(call, {
    approve: approved,
    list: 'ask',
    approval: approved ? 'approved' : 'rejected',
    decidedBy: resolvedBy,
    decidedByRole: 'credential-owner',
    decisionCardId,
  }),
  // An approved call's outcome arrives with its execution (toolUpdate).
  ...(approved ? [] : [toolUpdate(call, 'failed')]),
];

/** B4: nobody answered in time; the policy declines. */
export const expiredCallLines = (call: BrokerCall, decisionCardId?: string): RecordLineInput[] => [
  decided(call, {
    approve: false,
    list: 'ask',
    approval: 'timed_out',
    decidedBy: 'policy',
    decidedByRole: 'policy',
    decisionCardId,
  }),
  toolUpdate(call, 'failed'),
];

/** B5: executed under the grant with no ask. */
export const executedCallLines = (call: BrokerCall, ok: boolean): RecordLineInput[] => [
  toolCall(call),
  requested(call, policyAsk(call.grantId)),
  decided(call, { approve: true, list: 'allow', decidedBy: 'policy', decidedByRole: 'policy' }),
  toolUpdate(call, ok ? 'completed' : 'failed'),
];

export type GrantShape = {
  grantId: string;
  parentGrantId?: string | null;
  connectionId?: string | null;
  tools?: string[];
  writeMode?: string;
  budget?: { calls?: number; windowMs?: number } | null;
  audience?: unknown[];
  target?: { kind?: string; id?: unknown } | null;
  expiresAt?: Date | null;
};

/**
 * grant.issued. `issuedBy` is the user who minted it: the connection owner
 * for a grant, the attenuating agent for a child. An agent issuer is named as
 * an agent actor, since the format's default would call it a human.
 */
export const grantIssuedLine = (grant: GrantShape, issuer: RecordActor | null): RecordLineInput => {
  const budget = grant.budget && (grant.budget.calls !== undefined || grant.budget.windowMs !== undefined)
    ? {
      ...(grant.budget.calls !== undefined ? { calls: grant.budget.calls } : {}),
      ...(grant.budget.windowMs !== undefined ? { windowMs: grant.budget.windowMs } : {}),
    }
    : undefined;
  return {
    kind: 'grant.issued',
    actor: issuer,
    data: {
      grantId: grant.grantId,
      ...(grant.parentGrantId ? { parentGrantId: grant.parentGrantId } : {}),
      scope: {
        ...(grant.connectionId ? { connectionId: String(grant.connectionId) } : {}),
        tools: [...(grant.tools || [])],
        ...(grant.writeMode ? { writeMode: grant.writeMode } : {}),
        ...(budget ? { budget } : {}),
        audience: (grant.audience || []).map(String),
      },
      ...(grant.target?.kind && grant.target.id ? { target: { kind: grant.target.kind, id: String(grant.target.id) } } : {}),
      ...(issuer ? { issuedBy: issuer.id } : {}),
      ...(grant.expiresAt instanceof Date ? { expiresAt: grant.expiresAt.toISOString() } : {}),
    },
  };
};

/**
 * grant.revoked. `cascade` puts the revoked ancestor first and its
 * descendants after it; `manual` names exactly the grants a person or policy
 * ended; `expired` names one grant whose expiresAt passed; `task.done` names
 * the grants bound to a task the board just closed (written after task.done).
 */
export const grantRevokedLine = (
  grantIds: string[],
  reason: 'cascade' | 'manual' | 'expired' | 'task.done',
  actor: RecordActor | null,
): RecordLineInput => ({
  kind: 'grant.revoked',
  actor,
  data: { grantIds: [...grantIds], reason },
});
