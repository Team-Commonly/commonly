const request = require('supertest');
const express = require('express');

const registerMachine = jest.fn();
const listMachinesForOwner = jest.fn();
const recordMachineHeartbeat = jest.fn();
const removeMachine = jest.fn();

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: '0123456789abcdef01234567' };
  next();
});
jest.mock('../../../middleware/daemonAuth', () => ({
  daemonAuth: () => (req, _res, next) => {
    req.machine = { _id: '0123456789abcdef01234567', machineId: 'daemon-machine' };
    next();
  },
}));
jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: jest.fn().mockResolvedValue({ role: 'user' }) }) })),
}));
jest.mock('../../../services/machineService', () => ({
  registerMachine: (...args) => registerMachine(...args),
  listMachinesForOwner: (...args) => listMachinesForOwner(...args),
  recordMachineHeartbeat: (...args) => recordMachineHeartbeat(...args),
  removeMachine: (...args) => removeMachine(...args),
}));

const machinesRouter = require('../../../routes/machines');

const app = express();
app.use(express.json());
app.use('/api/machines', machinesRouter);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('machine lifecycle routes', () => {
  it('returns the daemon bearer on registration only', async () => {
    registerMachine.mockResolvedValue({
      machine: { id: 'm1', name: 'Sam’s Mac', machineId: 'daemon-machine', status: 'online' },
      token: 'cm_daemon_once',
    });

    const res = await request(app).post('/api/machines').send({ name: 'Sam’s Mac' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ daemonToken: 'cm_daemon_once' }));
    expect(registerMachine).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sam’s Mac' }));
  });

  it('lists only the caller’s machine views', async () => {
    listMachinesForOwner.mockResolvedValue({
      machines: [{ id: 'm1', name: 'Sam’s Mac', status: 'online' }],
      offlineAfterMs: 90000,
    });

    const res = await request(app).get('/api/machines');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      machines: [{ id: 'm1', name: 'Sam’s Mac', status: 'online' }],
      offlineAfterMs: 90000,
    });
    expect(listMachinesForOwner).toHaveBeenCalledWith('0123456789abcdef01234567');
  });

  it('uses the daemon credential only for the matching heartbeat', async () => {
    recordMachineHeartbeat.mockResolvedValue({ id: '0123456789abcdef01234567', status: 'online' });

    const res = await request(app).post('/api/machines/0123456789abcdef01234567/heartbeat');

    expect(res.status).toBe(200);
    expect(recordMachineHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'daemon-machine',
    }));
  });

  it('rejects a heartbeat path that is not the authenticated machine', async () => {
    const res = await request(app).post('/api/machines/abcdefabcdefabcdefabcdef/heartbeat');

    expect(res.status).toBe(403);
    expect(recordMachineHeartbeat).not.toHaveBeenCalled();
  });
});
