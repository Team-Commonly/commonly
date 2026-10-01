const { backfillHostedMcpClientIds } = require('../../../services/hostedMcpClientIdBackfill');

const ENTRY = { id: 'linear', client: 'cimd' };

const legacyRows = () => [
  { _id: 'access-only', config: { entryId: 'linear', credentialRef: 'access-ref' } },
  { _id: 'refresh-only', config: { entryId: 'linear', refreshTokenRef: 'refresh-ref' } },
  { _id: 'pending', config: { entryId: 'linear' } },
];

const harness = (rows = legacyRows()) => {
  const writes = [];
  const deps = {
    findLegacyRows: async () => rows,
    entryFor: (entryId) => (entryId === 'linear' ? ENTRY : undefined),
    clientIdFor: () => 'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/client-metadata',
    updateIfMissing: async (row, clientId) => {
      writes.push({ id: row._id, clientId });
      if (row.config.clientId) return 0;
      row.config.clientId = clientId;
      return 1;
    },
  };
  return { deps, writes, rows };
};

describe('hosted-MCP OAuth client-id backfill', () => {
  test('dry run counts legacy token-bearing rows without writing pending rows', async () => {
    const h = harness();

    await expect(backfillHostedMcpClientIds(h.deps)).resolves.toEqual({
      scanned: 3,
      candidates: 2,
      updated: 0,
    });
    expect(h.writes).toEqual([]);
    expect(h.rows[2].config.clientId).toBeUndefined();
  });

  test('apply stamps the current Linear client id and is idempotent', async () => {
    const h = harness();
    const first = await backfillHostedMcpClientIds(h.deps, true);
    const second = await backfillHostedMcpClientIds(h.deps, true);

    expect(first).toEqual({ scanned: 3, candidates: 2, updated: 2 });
    expect(second).toEqual({ scanned: 3, candidates: 0, updated: 0 });
    expect(h.writes).toHaveLength(2);
    expect(h.rows.slice(0, 2).map((row) => row.config.clientId)).toEqual([
      'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/client-metadata',
      'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/client-metadata',
    ]);
  });

  test('an unknown entry refuses the whole backfill before any row is written', async () => {
    const rows = [
      legacyRows()[0],
      { _id: 'unknown', config: { entryId: 'removed-entry', credentialRef: 'secret-ref' } },
    ];
    const h = harness(rows);

    await expect(backfillHostedMcpClientIds(h.deps, true))
      .rejects.toThrow('hosted-mcp row unknown names unknown entry removed-entry');
    expect(h.writes).toEqual([]);
  });

  test('a client id written by a callback after the scan is not overwritten', async () => {
    const rows = [legacyRows()[0]];
    const h = harness(rows);
    h.deps.updateIfMissing = async (row) => {
      row.config.clientId = 'callback-won-client';
      return 0;
    };

    await expect(backfillHostedMcpClientIds(h.deps, true)).resolves.toEqual({
      scanned: 1,
      candidates: 1,
      updated: 0,
    });
    expect(rows[0].config.clientId).toBe('callback-won-client');
  });
});
