// Shared, deterministic interruption and target policy for connector bridges.
// Keeping it outside a provider means Telegram and Slack cannot silently diverge
// about which pod messages are allowed to interrupt a person's attention surface,
// or about which pods a connector may address at all.

const isPodMember = require('../utils/isPodMember');

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

// May this connector address `pod` on behalf of `userId`? Gate and membership in
// one predicate, because a caller that holds one half and not the other is the
// failure this exists for: the gate says the connector is still subscribed, the
// membership says the person it speaks for is still in the room.
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
  // No separate user-id guard: `isPodMember` fails closed on a falsy id itself
  // (measured — a guard here changed no arm, so it was removed rather than kept
  // unwitnessed).
  return isGatedPodTarget(integration, podId)
    && isPodMember(pod, userId);
};

module.exports = { shouldEscalate, isGatedPodTarget, isRoutedPodTarget };
