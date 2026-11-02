/**
 * ADR-034 D6: boot says how much chat is still only in MongoDB. Those rows do
 * not show in chat (reads come from PostgreSQL alone), so an instance that
 * skipped the backfill is visible in its own log.
 */
const mockCount = jest.fn();
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../../../models/Message', () => ({ updateOne: jest.fn(), countDocuments: (...args) => mockCount(...args) }));

const { logMongoOnlyMessages } = require('../../../services/legacyMessageCopy');

describe('logMongoOnlyMessages', () => {
  let log;
  let warn;
  beforeEach(() => {
    mockCount.mockReset();
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('logs the count of uncopied messages and the command that reports on them', async () => {
    mockCount.mockResolvedValue(3);
    await expect(logMongoOnlyMessages()).resolves.toBe(3);
    expect(mockCount).toHaveBeenCalledWith({ reconciledAt: { $exists: false } });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/3 chat messages are only in MongoDB/);
    expect(log.mock.calls[0][0]).toMatch(/npm run backfill:local-messages/);
  });

  it('says nothing when every message has been copied', async () => {
    mockCount.mockResolvedValue(0);
    await expect(logMongoOnlyMessages()).resolves.toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('never fails boot: an unreadable count is a warning', async () => {
    mockCount.mockRejectedValue(new Error('mongo down'));
    await expect(logMongoOnlyMessages()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not count/), 'mongo down');
  });
});
