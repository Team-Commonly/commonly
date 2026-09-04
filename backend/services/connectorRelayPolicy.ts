// Shared, deterministic interruption policy for connector bridges. Keeping it
// outside a provider means Telegram and Slack cannot silently diverge about
// which pod messages are allowed to interrupt a person's attention surface.

export interface RelayPolicyIntegration {
  config?: {
    relayAllAgentMessages?: boolean;
    leadAgentUsername?: string;
  };
}

const ESCALATION_MARKERS = /\[(BLOCKED|ESCALATE|DECISION|NEEDS[-_ ]?HUMAN|APPROVAL)\]/i;
const QUESTION_AT_HUMAN = /@[a-z0-9_.-]+[^\n]{0,200}\?/i;

export const shouldEscalate = (opts: {
  content: string;
  agentUsername: string;
  integration: RelayPolicyIntegration;
}): boolean => {
  const { content, agentUsername, integration } = opts;
  const cfg = integration.config || {};
  if (cfg.relayAllAgentMessages) return true;
  if (cfg.leadAgentUsername
    && agentUsername.toLowerCase() === String(cfg.leadAgentUsername).toLowerCase()) {
    return true;
  }
  return ESCALATION_MARKERS.test(content) || QUESTION_AT_HUMAN.test(content);
};

module.exports = { shouldEscalate };
