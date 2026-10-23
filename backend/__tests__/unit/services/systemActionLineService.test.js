const mockQuery = jest.fn();
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));

jest.mock('../../../config/db-pg', () => ({
  pool: { query: (...args) => mockQuery(...args) },
}));
jest.mock('../../../config/socket', () => ({
  getIO: () => ({ to: mockTo }),
}));

const { emitSystemActionLine } = require('../../../services/systemActionLineService');

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [{ id: 42, created_at: '2026-10-23T20:00:00.000Z' }] });
});

it('persists one structured system row and broadcasts the same line without a wake or pod touch', async () => {
  await emitSystemActionLine({
    podId: 'pod-1', actorUserId: 'user-1', actorName: 'Forge',
    action: 'task-claimed', taskId: 'TASK-406',
  });

  expect(mockQuery).toHaveBeenCalledTimes(1);
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain("'system'");
  expect(sql).not.toMatch(/UPDATE pods|attention|AgentEvent/i);
  expect(params.slice(0, 3)).toEqual(['pod-1', 'user-1', 'Forge claimed TASK-406']);
  expect(JSON.parse(params[3])).toEqual({
    kind: 'system-action', action: 'task-claimed', actorName: 'Forge', taskId: 'TASK-406',
  });
  expect(mockTo).toHaveBeenCalledWith('pod_pod-1');
  expect(mockEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({
    id: '42', messageType: 'system', pod_id: 'pod-1',
    payload: expect.objectContaining({ action: 'task-claimed', taskId: 'TASK-406' }),
  }));
});
