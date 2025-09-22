const request = require('supertest');
const express = require('express');

jest.mock('../../../models/File', () => ({
  findByFileName: jest
    .fn()
    .mockResolvedValue({ data: Buffer.from('x'), contentType: 'text/plain' }),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const routes = require('../../../routes/uploads');
const File = require('../../../models/File');

describe('uploads routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', routes);

  it('GET /api/uploads/:file calls findByFileName', async () => {
    await request(app).get('/api/uploads/test').expect(200);
    expect(File.findByFileName).toHaveBeenCalledWith('test');
  });
  it('returns 404 when file not found', async () => {
    File.findByFileName.mockResolvedValue(null);
    await request(app).get('/api/uploads/missing').expect(404);
  });

  it('returns 500 on error', async () => {
    File.findByFileName.mockRejectedValue(new Error('fail'));
    await request(app).get('/api/uploads/oops').expect(500);
  });
});
