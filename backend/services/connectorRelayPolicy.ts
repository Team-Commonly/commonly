// Shared, deterministic interruption policy for connector bridges. Keeping it
// outside a provider means Telegram and Slack cannot silently diverge about
// which pod messages are allowed to interrupt a person's attention surface.

export interface RelayPolicyIntegration {
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

module.exports = { shouldEscalate };
