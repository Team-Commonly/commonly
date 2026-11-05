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
const winnerId = (claims) => pickCanonical(
  claims.map(([instanceId, agentName]) => claimant(instanceId, agentName)),
)._id;

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

  it("ranks a first-party default above a community default on the same label, in either row order", () => {
    expect(winnerId([['default', 'helper'], ['default', 'scout']])).toBe('scout-default');
    expect(winnerId([['default', 'scout'], ['default', 'helper']])).toBe('scout-default');
  });

  it('breaks an instanceId tie by agentName, so row order never decides it', () => {
    expect(winnerId([['lab', 'helper'], ['lab', 'bot']])).toBe('bot-lab');
    expect(winnerId([['lab', 'bot'], ['lab', 'helper']])).toBe('bot-lab');
  });
});

// F183: the rename rewrites `botMetadata.displayName`, and PG `users.username`
// holds exactly that label for a bot (AgentIdentityService.chatUsernameFor). The
// script wrote Mongo only, so chat kept rendering the old, colliding name until
// something else re-synced the user. Each rename now re-syncs that user's PG row.
describe('dedupeAgentDisplayNames PG sync', () => {
  const { dedupeAgentDisplayNames } = require('../../../scripts/dedupe-agent-display-names');
  const AgentIdentityService = jest.requireActual('../../../services/agentIdentityService');

  const fakeUserModel = (rows) => {
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    return {
      find: () => ({ select: () => ({ lean: async () => rows.map((r) => ({ ...r })) }) }),
      updateOne: jest.fn(async ({ _id }, { $set }) => {
        const row = byId.get(String(_id));
        row.botMetadata = { ...row.botMetadata, displayName: $set['botMetadata.displayName'] };
      }),
      findById: jest.fn(async (id) => byId.get(String(id))),
    };
  };
  const id = (s) => ({ toString: () => s, equals: (o) => String(o) === s });

  it('re-syncs each renamed bot so PG users.username carries the new label', async () => {
    const rows = [
      { _id: id('a'), isBot: true, username: 'pixel', botMetadata: { displayName: 'Pixel', instanceId: 'pixel', agentName: 'openclaw' } },
      { _id: id('b'), isBot: true, username: 'pixel-demo', botMetadata: { displayName: 'Pixel', instanceId: 'pixel-demo', agentName: 'openclaw' } },
    ];
    const User = fakeUserModel(rows);
    const syncUser = jest.fn().mockResolvedValue(true);

    const result = await dedupeAgentDisplayNames({ User, syncUser, log: () => {} });

    expect(result.renamed).toBe(1);
    expect(syncUser).toHaveBeenCalledTimes(1);
    const synced = syncUser.mock.calls[0][0];
    expect(String(synced._id)).toBe('b');
    expect(AgentIdentityService.chatUsernameFor(synced)).toBe('Pixel (Pixel-Demo)');
  });

  it('counts a failed PG sync without undoing the Mongo rename', async () => {
    const rows = [
      { _id: id('a'), isBot: true, botMetadata: { displayName: 'Pixel', instanceId: 'pixel', agentName: 'openclaw' } },
      { _id: id('b'), isBot: true, botMetadata: { displayName: 'Pixel', instanceId: 'pixel-demo', agentName: 'openclaw' } },
    ];
    const User = fakeUserModel(rows);
    const result = await dedupeAgentDisplayNames({ User, syncUser: jest.fn().mockResolvedValue(false), log: () => {} });
    expect(result.renamed).toBe(1);
    expect(result.pgSyncFailed).toBe(1);
    expect(rows[1].botMetadata.displayName).toBe('Pixel (Pixel-Demo)');
  });
});
