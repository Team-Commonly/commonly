const mongoose = require('mongoose');
const PGPod = require('../../../models/pg/Pod');
const Pod = require('../../../models/Pod');
const { pool } = require('../../../config/db-pg');
const syncPods = require('../../../sync-pods');

describe('syncPods', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws error when MONGO_URI is missing', async () => {
    delete process.env.MONGO_URI;
    process.env.MONGO_URI = '';
    await syncPods();
    expect(console.error).toHaveBeenCalledWith('Error:', 'MONGO_URI environment variable is not set');
  });

  it('syncs no pods when mongo returns empty', async () => {
    process.env.MONGO_URI = 'mongo://test';
    jest.spyOn(mongoose, 'connect').mockResolvedValue();
    jest.spyOn(mongoose, 'disconnect').mockResolvedValue();
    jest.spyOn(PGPod, 'findById').mockResolvedValue(null);
    jest.spyOn(PGPod, 'addMember').mockResolvedValue();
    jest.spyOn(PGPod, 'removeMember').mockResolvedValue();
    jest.spyOn(Pod, 'find').mockResolvedValue([]);
    jest.spyOn(pool, 'query').mockResolvedValue({ rows: [] });
    jest.spyOn(pool, 'end').mockResolvedValue();
    await syncPods();
    expect(Pod.find).toHaveBeenCalled();
  });
});
