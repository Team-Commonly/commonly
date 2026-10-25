jest.mock('../../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
const { pool } = require('../../../../config/db-pg');
const Message = require('../../../../models/pg/Message');
beforeEach(() => { pool.query.mockReset(); pool.query.mockResolvedValue({ rows: [] }); });
test('activity exclusion is an SQL predicate before LIMIT', async () => {
  await Message.findByPodId('pod-1', 1, null, null, { excludeSystemActions: true });
  const [sql, params] = pool.query.mock.calls[0];
  expect(sql).toContain("NOT (m.message_type = 'system' AND COALESCE(m.payload->>'kind', '') = 'system-action')");
  expect(sql.indexOf("= 'system-action'")).toBeLessThan(sql.indexOf('LIMIT'));
  expect(params).toEqual(['pod-1', 1]);
});
test('ordinary pod history still includes system action rows', async () => {
  await Message.findByPodId('pod-1', 1);
  expect(pool.query.mock.calls[0][0]).not.toContain("= 'system-action'");
});
