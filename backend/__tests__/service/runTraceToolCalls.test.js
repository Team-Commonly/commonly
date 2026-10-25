/** Read joins must execute against real PostgreSQL, not only pg-mem. */
const ToolCall = require('../../models/ToolCall');
const { pool } = require('../../config/db-pg');
const run = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const grantId = `lark-trace-${Date.now()}`;
const podId = `${grantId}-pod`;
run('run trace attribution on real PostgreSQL', () => {
  afterAll(async () => { await pool.query('DELETE FROM tool_calls WHERE grant_id = $1', [grantId]); });
  it('reads only referenced calls in the authorized pod, with current approval outcome', async () => {
    const record = (id, over = {}) => ({ callId: `${grantId}-${id}`, grantId, podId,
      agentUserId: 'agent', credentialOwnerId: 'credential-owner', tool: 'vendor.read',
      argsDigest: 'a'.repeat(64), outcome: 'ok', ...over });
    await ToolCall.create(record('ok'));
    await ToolCall.create(record('pending', { outcome: 'pending_approval', approvalId: 'approval' }));
    await ToolCall.create(record('resolved', { outcome: 'failed', approvalId: 'approval' }));
    await ToolCall.create(record('foreign', { podId: 'another-pod' }));
    const ids = ['ok', 'pending', 'foreign'].map((id) => `${grantId}-${id}`);
    const rows = await ToolCall.listRunReferences(podId, ids);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.callId.endsWith('-ok'))).toMatchObject({ grantId, credentialOwnerId: 'credential-owner', outcome: 'ok' });
    expect(rows.find((r) => r.callId.endsWith('-pending')).outcome).toBe('superseded');
    expect(await ToolCall.listRunReferences(podId, [])).toEqual([]);
  });
});
