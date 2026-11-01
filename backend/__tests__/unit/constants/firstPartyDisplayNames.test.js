// isFirstPartyAgentName decides which agents take the default-first collision
// rule (TASK-551). It must match every curated agentName and nothing else.
const { isFirstPartyAgentName, FIRST_PARTY_DISPLAY_NAMES } = require('../../../constants/firstPartyDisplayNames');

describe('isFirstPartyAgentName', () => {
  it('matches every curated first-party agentName, ignoring case and surrounding space', () => {
    FIRST_PARTY_DISPLAY_NAMES.forEach((_label, agentName) => {
      expect(isFirstPartyAgentName(agentName)).toBe(true);
      expect(isFirstPartyAgentName(`  ${agentName.toUpperCase()} `)).toBe(true);
    });
  });

  it('does not match a community agentName, a label, or a blank one', () => {
    expect(isFirstPartyAgentName('helper')).toBe(false);
    expect(isFirstPartyAgentName('scout-demo')).toBe(false);
    expect(isFirstPartyAgentName('Scout (Default)')).toBe(false);
    expect(isFirstPartyAgentName('')).toBe(false);
    expect(isFirstPartyAgentName(undefined)).toBe(false);
  });
});
