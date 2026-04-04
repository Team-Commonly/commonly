/* eslint-disable global-require */
const request = require('supertest');
const express = require('express');

jest.mock('../../config/db', () => jest.fn());
jest.mock('../../models/Pod', () => ({
  findById: jest.fn(),
}));

const mockConnectPG = jest.fn().mockResolvedValue(null);
jest.mock('../../config/db-pg', () => ({ connectPG: mockConnectPG }));
const mockInitPGDB = jest.fn();
jest.mock('../../config/init-pg-db', () => mockInitPGDB);

// Replace pg routes with simple routers
jest.mock('../../routes/pg-status', () => {
  const ex = require('express');
  const r = ex.Router();
  r.get('/', (req, res) => res.json({ available: true }));
  return r;
});
jest.mock('../../routes/pg-pods', () => {
  const ex = require('express');
  return ex.Router();
});
jest.mock('../../routes/pg-messages', () => {
  const ex = require('express');
  return ex.Router();
});

describe('server pg status route', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.PG_HOST;
  });

  it('returns available:false when PG not configured', async () => {
    delete process.env.PG_HOST;
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });

  it('returns available:true when PG initialized', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue({});
    mockInitPGDB.mockResolvedValue(true);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    // wait for async initialization
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: true });
  });

  it('returns available:false when PG connection fails', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue(null);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });

  it('returns available:false when PG init fails', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue({});
    mockInitPGDB.mockResolvedValue(false);
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });

  it('returns available:false when PG init throws', async () => {
    process.env.PG_HOST = 'x';
    mockConnectPG.mockResolvedValue({});
    mockInitPGDB.mockRejectedValue(new Error('fail'));
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { app } = require('../../server');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const res = await request(app).get('/api/pg/status');
    expect(res.body).toEqual({ available: false });
  });
});

describe('server websocket authorization helpers', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('treats string and ObjectId-like members as valid pod members', () => {
    jest.resetModules();
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { isPodMember } = require('../../server');

    expect(
      isPodMember(
        {
          members: [
            { toString: () => 'user-1' },
            { toString: () => 'user-2' },
          ],
        },
        'user-2',
      ),
    ).toBe(true);
  });

  it('rejects socket pod joins for non-members', async () => {
    jest.resetModules();
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const Pod = require('../../models/Pod');
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { authorizeSocketPodAccess } = require('../../server');
    Pod.findById.mockResolvedValue({
      _id: 'pod-1',
      members: [{ toString: () => 'user-2' }],
    });
    const socket = {
      userId: 'user-1',
      emit: jest.fn(),
    };

    const result = await authorizeSocketPodAccess(socket, 'pod-1', 'join');

    expect(result).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      message: 'Not authorized to join for this pod',
    });
  });

  it('allows socket pod access for members', async () => {
    jest.resetModules();
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const Pod = require('../../models/Pod');
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { authorizeSocketPodAccess } = require('../../server');
    const pod = {
      _id: 'pod-1',
      members: [{ toString: () => 'user-1' }],
    };
    Pod.findById.mockResolvedValue(pod);
    const socket = {
      userId: 'user-1',
      emit: jest.fn(),
    };

    const result = await authorizeSocketPodAccess(socket, 'pod-1', 'post');

    expect(result).toBe(pod);
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
