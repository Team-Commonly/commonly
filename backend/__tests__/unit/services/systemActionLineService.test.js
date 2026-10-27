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
    actorUsername: 'forge-agent', actorAvatarUrl: '/avatars/forge.png', actorIsBot: true,
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
    user: expect.objectContaining({ username: 'forge-agent', profile_picture: '/avatars/forge.png', isBot: true }),
  }));
});

it('executes the INSERT and reads the table-generated identity, timestamp and JSON payload back', async () => {
  const { newDb } = require('pg-mem');
  const db = newDb();
  db.public.none(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY, pod_id TEXT NOT NULL, user_id TEXT NOT NULL,
    content TEXT NOT NULL, message_type TEXT NOT NULL, payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  mockQuery.mockImplementation((sql, params) => pool.query(sql, params));
  try {
    await emitSystemActionLine({ podId: 'pod-1', actorUserId: 'user-1', actorName: 'Persisted Forge', action: 'task-claimed', taskId: 'TASK-406' });
    const { rows: [row] } = await pool.query('SELECT * FROM messages');
    expect(row.id).toBe(1);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.message_type).toBe('system');
    expect(row.payload).toEqual({ kind: 'system-action', action: 'task-claimed', actorName: 'Persisted Forge', taskId: 'TASK-406' });
    expect(mockEmit).toHaveBeenCalledWith('newMessage', expect.objectContaining({ id: String(row.id), created_at: row.created_at, payload: row.payload }));
  } finally {
    mockQuery.mockReset();
    await pool.end();
  }
});
