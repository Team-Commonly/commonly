// Use an in-memory pool that enforces the same conditional semantics so this
// test exercises the single INSERT ... ON CONFLICT write used in production.
jest.mock('../../../config/db-pg', () => {
  let callsUsed = 0;
  return {
    pool: {
      query: async (sql, params = []) => {
        if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { rows: [] };
        if (sql.includes('ON CONFLICT') && sql.includes('tool_call_budgets')) {
          const limit = Number(params[1]);
          if (callsUsed >= limit) return { rows: [] };
          callsUsed += 1;
          return { rows: [{ calls_used: callsUsed }] };
        }
        return { rows: [] };
      },
    },
  };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const { reserveBudget } = require('../../../models/ToolCall');

describe('tool-call budget ledger', () => {
  it('spends a finite lifetime budget atomically under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveBudget('concurrent-grant', 3)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(results.filter((value) => !value)).toHaveLength(17);
  });
});
