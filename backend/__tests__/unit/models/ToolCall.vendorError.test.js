jest.mock('../../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return { pool: new Pool() };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../../models/ToolCall');

it('persists only the bounded vendor status and error line on a failed ToolCall', async () => {
  await ToolCall.create({
    callId: 'vendor-400', grantId: 'grant-1', agentUserId: 'agent-a',
    tool: 'atlassian.get_accessible_atlassian_resources', argsDigest: 'a'.repeat(64),
    outcome: 'failed', reason: 'provider_error', vendorStatus: 400,
    vendorError: 'session required',
  });
  const [line] = await ToolCall.listForGrant('grant-1');
  expect(line).toMatchObject({
    outcome: 'failed', reason: 'provider_error', vendorStatus: 400,
    vendorError: 'session required',
  });
});
