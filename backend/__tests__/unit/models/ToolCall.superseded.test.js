// C4-11: a parked row (`pending_approval`) is the REQUEST, not the call. When
// the approval resolves, the resolution is recorded as its own row carrying the
// same approval_id (the executed call, or the declined/expired refusal), and
// the parked row stayed `pending_approval` forever — so the trail counted
// resolved approvals as "awaiting a person" and a request that already ran sat
// in the list claiming a person was still being waited on.
//
// The derivation is read-side (one of the two fixes the row sanctioned):
// nothing about the write path or the CHECK-constrained storage vocabulary
// changes, and a parked row someone is genuinely still waiting on keeps
// counting. Run on pg-mem's real adapter, like ToolCall.counts.test.js.
// Each case uses its own grant id: the module-scoped pool is shared by every
// test in this file.
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
    tool: 'github.create_issue',
    argsDigest: 'a'.repeat(64),
    outcome: 'ok',
    at: new Date(Date.UTC(2026, 8, 18, 12, seq)),
    ...over,
  };
};

const NONE = { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 };
const byCallId = (rows) => rows.reduce((acc, r) => ({ ...acc, [r.callId]: r.outcome }), {});

describe('a parked call whose approval resolved is no longer awaiting', () => {
  it('reports the parked row as superseded and counts the call once (approved → ok)', async () => {
    const g = 'grant-approved';
    const parked = row(g, { outcome: 'pending_approval', approvalId: 'appr-ok' });
    const executed = row(g, { outcome: 'ok', approvalId: 'appr-ok' });
    await ToolCall.create(parked);
    await ToolCall.create(executed);

    await expect(ToolCall.countsForGrant(g)).resolves.toEqual({
      ...NONE, total: 1, ok: 1,
    });

    const listed = await ToolCall.listForGrant(g);
    expect(byCallId(listed)).toEqual({
      [parked.callId]: 'superseded',
      [executed.callId]: 'ok',
    });
  });

  it('treats a declined approval the same way (parked + refused sibling, one call)', async () => {
    const g = 'grant-declined';
    const parked = row(g, { outcome: 'pending_approval', approvalId: 'appr-no' });
    await ToolCall.create(parked);
    await ToolCall.create(row(g, { outcome: 'refused', reason: 'approval_declined', approvalId: 'appr-no' }));

    await expect(ToolCall.countsForGrant(g)).resolves.toEqual({
      ...NONE, total: 1, refused: 1,
    });
    expect(byCallId(await ToolCall.listForGrant(g))[parked.callId]).toBe('superseded');
  });

  it('treats an approval that resolved and then failed the same way', async () => {
    const g = 'grant-failed';
    await ToolCall.create(row(g, { outcome: 'pending_approval', approvalId: 'appr-fail' }));
    await ToolCall.create(row(g, { outcome: 'failed', reason: 'provider_error', approvalId: 'appr-fail' }));

    await expect(ToolCall.countsForGrant(g)).resolves.toEqual({
      ...NONE, total: 1, failed: 1,
    });
  });

  it('keeps counting a parked call nobody has answered', async () => {
    const g = 'grant-open';
    await ToolCall.create(row(g, { outcome: 'pending_approval', approvalId: 'appr-open' }));
    await expect(ToolCall.countsForGrant(g)).resolves.toEqual({
      ...NONE, total: 1, pending_approval: 1,
    });
  });

  it('does not let two parked rows with no approval id supersede each other', async () => {
    // The join is on approval_id equality, so NULLs must not match. A parked row
    // with no approval (the proposal was never minted) is still awaiting.
    const g = 'grant-null';
    await ToolCall.create(row(g, { outcome: 'pending_approval' }));
    await ToolCall.create(row(g, { outcome: 'pending_approval' }));
    await expect(ToolCall.countsForGrant(g)).resolves.toEqual({
      ...NONE, total: 2, pending_approval: 2,
    });
    const listed = await ToolCall.listForGrant(g);
    expect(listed.every((r) => r.outcome === 'pending_approval')).toBe(true);
  });

  it('scopes the sibling to the same grant', async () => {
    // A resolution in another grant must not silence this grant's parked row.
    const parked = row('grant-scoped', { outcome: 'pending_approval', approvalId: 'appr-shared' });
    await ToolCall.create(parked);
    await ToolCall.create(row('grant-other', { outcome: 'ok', approvalId: 'appr-shared' }));

    await expect(ToolCall.countsForGrant('grant-scoped')).resolves.toEqual({
      ...NONE, total: 1, pending_approval: 1,
    });
    expect((await ToolCall.listForGrant('grant-scoped'))[0].outcome).toBe('pending_approval');
  });

  it('leaves a stored outcome untouched when a grant has no parked rows at all', async () => {
    const g = 'grant-plain';
    await ToolCall.create(row(g, { outcome: 'ok' }));
    await ToolCall.create(row(g, { outcome: 'refused', reason: 'not_in_audience' }));
    await ToolCall.create(row(g, { outcome: 'failed', reason: 'provider_error' }));
    await expect(ToolCall.countsForGrant(g)).resolves.toEqual({
      ...NONE, total: 3, ok: 1, refused: 1, failed: 1,
    });
    const listed = await ToolCall.listForGrant(g);
    expect(Object.values(byCallId(listed)).sort()).toEqual(['failed', 'ok', 'refused']);
  });
});
