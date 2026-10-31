const mockInsertOne = jest.fn();
let mockWarn;

jest.mock('mongoose', () => ({
  connection: { db: { collection: () => ({ insertOne: (...args) => mockInsertOne(...args) }) } },
}));

const { recordByoEvent } = require('../../../services/byoTelemetry');

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
});
