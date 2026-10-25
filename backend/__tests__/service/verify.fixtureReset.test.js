/** Claims have no message FK: a warm verification database must clear them
 * before RESTART IDENTITY gives a new conversation an old message ID.
 */
const { setupPgDb, clearPgDb, closePgDb } = require('../utils/testUtils');
const MessageClaimService = require('../../services/messageClaimService');

const tier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
tier1('verification fixture claim isolation — real PostgreSQL', () => {
  let pg;
  beforeAll(async () => { pg = await setupPgDb(); });
  afterEach(async () => { await pg.query('TRUNCATE TABLE message_claims'); });
  afterAll(async () => {
    await closePgDb();
    await require('../../config/db-pg').pool.end();
  });

  test.each(['clear', 'setup'])('%s reset admits a reused message ID after a completed claim', async (reset) => {
    const old = { messageId: '2', podId: 'old-pod', agentName: 'old-seat' };
    expect((await MessageClaimService.claim(old)).claimed).toBe(true);
    // Seed persisted state from a prior suite, including legacy tombstones.
    await pg.query("UPDATE message_claims SET state = 'completed', expires_at = NOW() + interval '1 hour' WHERE message_id = '2'");
    // Control: the tombstone really prevents the fresh seat from answering.
    const fresh = { messageId: '2', podId: 'new-pod', agentName: 'scout' };
    expect((await MessageClaimService.claim(fresh)).claimed).toBe(false);
    if (reset === 'clear') await clearPgDb();
    else {
      await closePgDb();
      pg = await setupPgDb();
    }
    expect((await pg.query('SELECT count(*)::int AS n FROM message_claims')).rows[0].n).toBe(0);
    expect((await MessageClaimService.claim(fresh)).claimed).toBe(true);
    await clearPgDb();
  });
});
