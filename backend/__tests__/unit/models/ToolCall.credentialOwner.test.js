// Plan §8 / §10 step 5: the trail records whose credential ran. The Connection's
// `createdBy` is COPIED onto every record — for every connection type — because
// removal ends by deleting the row, and the trail outlives it. Run on pg-mem's
// real adapter, like ToolCall.counts.test.js and ToolCall.superseded.test.js.
//
// The copy is what the first arm witnesses. The Connection row lives in Mongo
// and this database has no such table, so a read that answered the owner by
// joining the store it came from would fail here rather than quietly pass.
//
// The schema RETROFIT (an instance whose `tool_calls` predates the column) is not
// representable here: pg-mem throws on `CREATE TABLE IF NOT EXISTS` against an
// existing table, which is the statement that runs first in the same DDL. Its
// own file witnesses the statement instead — ToolCall.credentialOwnerRetrofit.
jest.mock('../../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return { pool: new Pool() };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../../models/ToolCall');

let seq = 0;
const row = (grantId, over) => {
  seq += 1;
  return {
    callId: `call-${seq}`,
    grantId,
    agentUserId: 'agent-a',
    tool: 'github.list_issues',
    argsDigest: 'a'.repeat(64),
    outcome: 'ok',
    at: new Date(Date.UTC(2026, 8, 29, 12, seq)),
    ...over,
  };
};

describe('the trail names the credential owner', () => {
  it('records it per row, on a database that has no connection store to join', async () => {
    await ToolCall.create(row('grant-owner', { credentialOwnerId: 'owner-1' }));
    await ToolCall.create(row('grant-owner'));

    const lines = await ToolCall.listForGrant('grant-owner');
    const withOwner = lines.find((line) => line.credentialOwnerId === 'owner-1');
    expect(withOwner).toBeDefined();
    // The agent's own identity is a different column; the owner is the Connection's.
    expect(withOwner.agentUserId).toBe('agent-a');
    // A row with no owner reads as absent, not as a missing property or a throw.
    const withoutOwner = lines.find((line) => line.callId !== withOwner.callId);
    expect(withoutOwner.credentialOwnerId).toBeUndefined();
  });
});
