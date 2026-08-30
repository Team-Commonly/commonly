const request = require('supertest');
const express = require('express');

const mockRegisterMachine = jest.fn();
const mockListMachinesForOwner = jest.fn();
const mockGetMachineForDaemon = jest.fn();
const mockRecordMachineHeartbeat = jest.fn();
const mockRemoveMachine = jest.fn();
const mockFindMachine = jest.fn();

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

    const res = await request(app).post('/api/machines/0123456789abcdef01234567/heartbeat');

    expect(res.status).toBe(200);
    expect(mockRecordMachineHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'daemon-machine',
    }));
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
