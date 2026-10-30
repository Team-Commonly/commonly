// pickCanonical in backend/scripts/dedupe-agent-display-names (TASK-551). A
// group whose default instance belongs to a first-party agent ranks that
// instance first; every other group keeps the shortest-instanceId rule it has
// on main.
const { pickCanonical } = require('../../../scripts/dedupe-agent-display-names');

const claimant = (instanceId, agentName) => ({
  _id: `${agentName}-${instanceId}`,
  botMetadata: { displayName: 'x', instanceId, agentName },
});
const winner = (claims) => pickCanonical(
  claims.map(([instanceId, agentName]) => claimant(instanceId, agentName)),
).botMetadata.instanceId;

describe('pickCanonical', () => {
  it("ranks a first-party agent's default instance first, even against a shorter named peer", () => {
    expect(winner([['scout', 'scout'], ['default', 'scout']])).toBe('default');
  });

  it('keeps the shortest instanceId for a community agent, so a shorter named peer beats its default', () => {
    expect(winner([['default', 'helper'], ['bot', 'helper']])).toBe('bot');
  });

  it('does not let a community default outrank a shorter first-party peer on the same label', () => {
    expect(winner([['default', 'helper'], ['lab', 'scout']])).toBe('lab');
  });

  it('breaks shortest-instanceId ties alphabetically', () => {
    expect(winner([['pixel-b', 'pixel'], ['pixel-a', 'pixel']])).toBe('pixel-a');
  });
});
