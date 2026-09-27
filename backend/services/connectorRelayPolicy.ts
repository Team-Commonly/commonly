// Shared, deterministic interruption and target policy for connector bridges.
// Keeping it outside a provider means Telegram and Slack cannot silently diverge
// about which pod messages are allowed to interrupt a person's attention surface,
// or about which pods a connector may address at all.

// The strict membership rule, re-exported here so every connector site reads one
// definition through this module. It is also the only rule its home module exports
// any more: as of TASK-170 `utils/isPodMember` carries no creator-inclusive
// export, because that permissive predicate — membership *or* `createdBy` — is
// what let a departed creator keep relaying (TASK-161). The creator clause it
// carried is covered where the pod is created (`Pod`'s pre-save hook lists
// `createdBy`), not by a second predicate, so nothing sits beside
// `isListedPodMember` now.
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { isListedPodMember } = require('../utils/isPodMember');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { isHiddenFromDefaultListing } = require('./podListing');

export interface RelayPolicyIntegration {
  scope?: string;
  podId?: unknown;
  config?: {
    relayAllAgentMessages?: boolean;
    leadAgentUsername?: string;
    gates?: Record<string, {
      enabled?: boolean;
      mode?: 'attention' | 'mirror';
      lead?: string;
    }>;
  };
}

const ESCALATION_MARKERS = /\[(BLOCKED|ESCALATE|DECISION|NEEDS[-_ ]?HUMAN|APPROVAL)\]/i;
const QUESTION_AT_HUMAN = /@[a-z0-9_.-]+[^\n]{0,200}\?/i;

export const shouldEscalate = (opts: {
  content: string;
  agentUsername: string;
  integration: RelayPolicyIntegration;
  podId?: string;
}): boolean => {
  const {
    content, agentUsername, integration, podId,
  } = opts;
  const cfg = integration.config || {};
  const gate = podId ? cfg.gates?.[String(podId)] : undefined;
  const relayAllAgentMessages = gate?.mode === 'mirror'
    ? true
    : gate?.mode === 'attention'
      ? false
      : cfg.relayAllAgentMessages;
  const leadAgentUsername = gate?.lead ?? cfg.leadAgentUsername;
  if (relayAllAgentMessages) return true;
  if (leadAgentUsername
    && agentUsername.toLowerCase() === String(leadAgentUsername).toLowerCase()) {
    return true;
  }
  return ESCALATION_MARKERS.test(content) || QUESTION_AT_HUMAN.test(content);
};

// One reading of `config.gates`, shared by every consumer that asks whether a pod
// is still a target of a connector: both bridges' outbound relay, decision-card
// delivery, and the routed-quote-reply check below. It was three copies of the
// same ternary before TASK-156, which is how the list and the call drift apart.
//
// Scope is the connector's, not the pod's: a `user`-scoped connector holds one
// private chat and subscribes to N pods through its gates, while a pod-scoped one
// speaks for exactly its own pod.
export const isGatedPodTarget = (
  integration: RelayPolicyIntegration,
  podId: string,
): boolean => (
  integration.scope === 'user'
    ? integration.config?.gates?.[String(podId)]?.enabled === true
    : String(integration.podId) === String(podId)
);

// Every connector TARGET write runs this: the install verb, the connector's
// creation, the pod it makes active, and each gate key. Two halves, both the
// server's reading of the same question — may this person point a channel at
// this pod?
//
//   1. Listed membership (`isListedPodMember`, membership and nothing else).
//   2. Not a type the default listing hides. `agent-admin` is the legacy
//      multi-admin debug channel: it has no gate UI, so a gate written for one
//      is a switch its owner never sees (V2ConnectorsPage drops gate keys
//      outside the offered list on the next toggle) and — at 2-3 members per
//      pod — it is other admins' words leaving the instance because a
//      co-member flipped something in an API call (Wren's ruling, TASK-171).
//
// Reading one constant with the listing is the point: the rule the page relies
// on is "the list shows exactly what the server would accept", and two lists
// that agree today is how the gate key came to accept a type the list hid.
//
// This is a TARGET check, not a READ check. Authorisation on an EXISTING row
// (`canDeleteIntegration`, the listener and delete paths) stays membership-only,
// so an owner who is a member can still list and remove a connector that points
// somewhere they may no longer target; and the ACTIVE pod relay path in each
// bridge is unchanged.
export const isConnectorTargetPod = (pod: any, userId: unknown): boolean => (
  isListedPodMember(pod, userId) && !isHiddenFromDefaultListing(pod)
);

// May this connector address `pod` on behalf of `userId`? Gate and membership in
// one predicate, because a caller that holds one half and not the other is the
// failure this exists for: the gate says the connector is still subscribed, the
// membership says the person it speaks for is still in the room.
//
// The second half is `isConnectorTargetPod`: listed membership — `pod.members`
// only, the check the pod's own write path runs — so a connector can never write
// where its owner would be refused, plus the pod-type rule the write verbs run
// (TASK-171). Before TASK-161 this read the permissive `isPodMember`, and a pod's
// creator who had left the pod still relayed in both directions.
//
// KNOWN WINDOW, accepted: this is check-then-act. A gate switched off between
// this call and the write still lets that one message through. Closing it means
// making the write itself carry the condition (a conditional update or a
// transaction) rather than a preceding read; not worth it for a one-message
// window on a subscription toggle the owner is the only one who can flip.
//
// The ACTIVE pod is deliberately exempt from the gate and never passes through
// here — see isInboundRelayableIntegration in each bridge. A pruned outbound gate
// must not disconnect the owner's own private chat, so the gate bounds the N
// subscribed pods and never the active one.
export const isRoutedPodTarget = (opts: {
  integration: RelayPolicyIntegration;
  pod: any;
  podId: string;
  userId: unknown;
}): boolean => {
  const {
    integration, pod, podId, userId,
  } = opts;
  // No separate user-id guard: the predicate fails closed on a falsy id itself
  // (measured — a guard here changed no arm, so it was removed rather than kept
  // unwitnessed).
  // The same target predicate the write verbs run, so what a connector may be
  // POINTED at and what a ROUTED reply may address cannot drift apart. This is
  // the only relay path that reads the type half: the bridges' outbound fan-out
  // and decision-card delivery still ask `isGatedPodTarget` + membership alone
  // (measured, Vera 74749), and nothing can create such a row any more, because
  // the write verbs refuse one.
  return isGatedPodTarget(integration, podId)
    && isConnectorTargetPod(pod, userId);
};

module.exports = {
  shouldEscalate,
  isGatedPodTarget,
  isRoutedPodTarget,
  isConnectorTargetPod,
  isListedPodMember,
};
