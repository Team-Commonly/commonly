const request = require('supertest');
const express = require('express');

const mockRegisterMachine = jest.fn();
const mockListMachinesForOwner = jest.fn();
const mockGetMachineForDaemon = jest.fn();
const mockRecordMachineHeartbeat = jest.fn();
const mockRemoveMachine = jest.fn();
const mockFindMachine = jest.fn();
const mockMarkByoDaemonRegistered = jest.fn();
const mockRecordByoEvent = jest.fn();

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '0123456789abcdef01234567' };
  next();
});
jest.mock('../../../middleware/daemonAuth', () => ({
  __esModule: true,
  default: () => (req, _res, next) => {
    req.machine = {
      machineId: 'daemon-machine',
      ownerUserId: '0123456789abcdef01234567',
      scopes: ['machine:heartbeat', 'machine:read', 'agents:adopt'],
    };
    next();
  },
}));
jest.mock('../../../models/Machine', () => ({
  findOne: (...args) => mockFindMachine(...args),
}));
jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: jest.fn().mockResolvedValue({ role: 'user' }) }) })),
}));
jest.mock('../../../services/onboardingMarks', () => ({
  markByoDaemonRegistered: (...args) => mockMarkByoDaemonRegistered(...args),
}));
jest.mock('../../../services/byoTelemetry', () => ({
  ...jest.requireActual('../../../services/byoTelemetry'),
  recordByoEvent: (...args) => mockRecordByoEvent(...args),
}));
jest.mock('../../../services/machineService', () => ({
  registerMachine: (...args) => mockRegisterMachine(...args),
  listMachinesForOwner: (...args) => mockListMachinesForOwner(...args),
  getMachineForDaemon: (...args) => mockGetMachineForDaemon(...args),
  recordMachineHeartbeat: (...args) => mockRecordMachineHeartbeat(...args),
  removeMachine: (...args) => mockRemoveMachine(...args),
}));

const machinesRouter = require('../../../routes/machines');

const app = express();
app.use(express.json());
app.use('/api/machines', machinesRouter);

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMachine.mockResolvedValue({
    _id: '0123456789abcdef01234567',
    machineId: 'daemon-machine',
  });
});

describe('machine lifecycle routes', () => {
  it('returns the daemon bearer on registration only', async () => {
    mockRegisterMachine.mockResolvedValue({
      machine: { id: 'm1', name: 'Sam’s Mac', machineId: 'daemon-machine', status: 'online' },
      token: 'cm_daemon_once',
    });

    const res = await request(app).post('/api/machines').send({ name: 'Sam’s Mac' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ daemonToken: 'cm_daemon_once' }));
    expect(mockRegisterMachine).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sam’s Mac' }));
  });

  it('marks and records the daemon registration once per person (TASK-661)', async () => {
    mockRegisterMachine.mockResolvedValue({
      machine: {
        id: 'm1', name: 'Sam’s Mac', machineId: 'daemon-machine', status: 'online',
      },
      token: 'cm_daemon_once',
    });

    const res = await request(app).post('/api/machines').send({ name: 'Sam’s Mac' });

    expect(res.status).toBe(201);
    expect(mockMarkByoDaemonRegistered).toHaveBeenCalledWith('0123456789abcdef01234567');
    expect(mockRecordByoEvent).toHaveBeenCalledWith(
      '0123456789abcdef01234567',
      'daemon-registered',
      {},
      'daemon-registered:0123456789abcdef01234567',
    );
  });

  it('keys the registration row by person, so a second machine uses the same key', async () => {
    mockRegisterMachine.mockResolvedValue({
      machine: {
        id: 'm2', name: 'Work Mac', machineId: 'daemon-machine-2', status: 'online',
      },
      token: 'cm_daemon_two',
    });

    await request(app).post('/api/machines').send({ name: 'Work Mac' });
    await request(app).post('/api/machines').send({ name: 'Work Mac' });

    const keys = mockRecordByoEvent.mock.calls.map(([, , , key]) => key);
    expect(keys).toEqual([
      'daemon-registered:0123456789abcdef01234567',
      'daemon-registered:0123456789abcdef01234567',
    ]);
  });

  it('records nothing when registration fails', async () => {
    mockRegisterMachine.mockRejectedValue(new Error('Machine limit reached'));

    const res = await request(app).post('/api/machines').send({ name: 'Sam’s Mac' });

    expect(res.status).toBe(400);
    expect(mockMarkByoDaemonRegistered).not.toHaveBeenCalled();
    expect(mockRecordByoEvent).not.toHaveBeenCalled();
  });

  it('lists only the caller’s machine views', async () => {
    mockListMachinesForOwner.mockResolvedValue({
      machines: [{ id: 'm1', name: 'Sam’s Mac', status: 'online' }],
      offlineAfterMs: 90000,
    });

    const res = await request(app).get('/api/machines');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      machines: [{ id: 'm1', name: 'Sam’s Mac', status: 'online' }],
      offlineAfterMs: 90000,
    });
    expect(mockListMachinesForOwner).toHaveBeenCalledWith('0123456789abcdef01234567');
  });

  it('uses the daemon credential only for the matching heartbeat', async () => {
    mockRecordMachineHeartbeat.mockResolvedValue({ id: '0123456789abcdef01234567', status: 'online' });

    const agents = [{ agentName: 'wren-test', instanceId: 'default', state: 'running', restarts: 0 }];
    const res = await request(app)
      .post('/api/machines/0123456789abcdef01234567/heartbeat')
      .send({ agents });

    expect(res.status).toBe(200);
    // D5: the reported agent states ride the same heartbeat, verbatim — the
    // service owns validation.
    expect(mockRecordMachineHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'daemon-machine',
    }), agents, undefined);
    expect(mockFindMachine).toHaveBeenCalledWith({
      _id: '0123456789abcdef01234567',
      machineId: 'daemon-machine',
      ownerUserId: '0123456789abcdef01234567',
    });
  });

  it('returns only the credential-bound machine through daemon status', async () => {
    mockGetMachineForDaemon.mockResolvedValue({ id: 'm1', name: 'Sam’s Mac', status: 'online' });

    const res = await request(app).get('/api/machines/me');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ machine: { id: 'm1', name: 'Sam’s Mac', status: 'online' } });
    expect(mockGetMachineForDaemon).toHaveBeenCalledWith({
      machineId: 'daemon-machine',
      ownerUserId: '0123456789abcdef01234567',
    });
  });

  it('rejects a heartbeat path that is not the authenticated machine', async () => {
    mockFindMachine.mockResolvedValue(null);
    const res = await request(app).post('/api/machines/abcdefabcdefabcdefabcdef/heartbeat');

    expect(res.status).toBe(403);
    expect(mockRecordMachineHeartbeat).not.toHaveBeenCalled();
  });
});
