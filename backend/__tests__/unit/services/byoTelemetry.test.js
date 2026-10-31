const mockInsertOne = jest.fn();
let mockWarn;

jest.mock('mongoose', () => ({
  connection: { db: { collection: () => ({ insertOne: (...args) => mockInsertOne(...args) }) } },
}));

const { recordByoEvent, seatRegisteredKey } = require('../../../services/byoTelemetry');

describe('recordByoEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockInsertOne.mockResolvedValue({ acknowledged: true });
  });

  it('writes the fixed step with the user, the extra fields and server time', async () => {
    await recordByoEvent('human-1', 'seat-registered', { commandType: 'cli' });

    expect(mockInsertOne).toHaveBeenCalledWith({
      userId: 'human-1',
      step: 'seat-registered',
      commandType: 'cli',
      at: expect.any(Date),
    });
  });

  it('never throws when the write fails, so the caller flow continues', async () => {
    mockInsertOne.mockRejectedValue(new Error('db down'));

    await expect(recordByoEvent('human-1', 'seat-registered')).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('[byo-telemetry] write failed:', 'db down');
  });

  it('keys a once-per-seat row by a hash of the token, never the token itself', () => {
    const key = seatRegisteredKey('token-record-hash');

    expect(key).toMatch(/^seat-registered:[0-9a-f]{64}$/);
    expect(key).not.toContain('token-record-hash');
    expect(seatRegisteredKey('token-record-hash')).toBe(key);
  });

  it('writes the keyed row with _id set, so a racing second write is a no-op', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    mockInsertOne.mockResolvedValueOnce({ acknowledged: true }).mockRejectedValueOnce(dup);
    const key = seatRegisteredKey('token-record-hash');

    await recordByoEvent('human-1', 'seat-registered', {}, key);
    await expect(recordByoEvent('human-1', 'seat-registered', {}, key)).resolves.toBeUndefined();

    expect(mockInsertOne).toHaveBeenNthCalledWith(1, expect.objectContaining({ _id: key, step: 'seat-registered' }));
    expect(mockInsertOne).toHaveBeenNthCalledWith(2, expect.objectContaining({ _id: key, step: 'seat-registered' }));
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
