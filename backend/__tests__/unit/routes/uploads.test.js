const request = require('supertest');
const express = require('express');

jest.mock('../../../models/File', () => ({
  findByFileName: jest.fn().mockResolvedValue({ data: Buffer.from('x'), contentType: 'text/plain' }),
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
});
