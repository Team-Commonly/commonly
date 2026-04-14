// ADR-002 Phase 1 — GET route covers both the driver-hit path and the
// legacy File.data fallback for pre-ADR-002 records.

const request = require('supertest');
const express = require('express');
const { Readable } = require('stream');

const mockStore = {
  capabilities: { name: 'mongo', maxObjectBytes: 10 * 1024 * 1024 },
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock('../../../services/objectStore', () => ({
  getObjectStore: () => mockStore,
  __resetObjectStoreForTests: jest.fn(),
}));

jest.mock('../../../models/File', () => ({
  findByFileName: jest.fn(),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => next());

const File = require('../../../models/File');
const routes = require('../../../routes/uploads');

describe('uploads GET /:fileName (ADR-002 Phase 1)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', routes);

  beforeEach(() => {
    mockStore.get.mockReset();
    mockStore.put.mockReset();
    mockStore.delete.mockReset();
    File.findByFileName.mockReset();
  });

  it('streams bytes from the driver when the key is present', async () => {
    mockStore.get.mockResolvedValue({
      stream: Readable.from(Buffer.from('hello')),
      mime: 'image/png',
      size: 5,
    });

    const res = await request(app)
      .get('/api/uploads/new.png')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body)).toEqual(
      Buffer.from('hello'),
    );
    expect(mockStore.get).toHaveBeenCalledWith('new.png');
    expect(File.findByFileName).not.toHaveBeenCalled();
  });

  it('falls back to legacy File.data when the driver returns null', async () => {
    mockStore.get.mockResolvedValue(null);
    File.findByFileName.mockResolvedValue({
      data: Buffer.from('legacy-bytes'),
      contentType: 'image/jpeg',
    });

    const res = await request(app).get('/api/uploads/legacy.jpg').expect(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    expect(res.body.toString()).toBe('legacy-bytes');
    expect(File.findByFileName).toHaveBeenCalledWith('legacy.jpg');
  });

  it('returns 404 when neither driver nor legacy store has the key', async () => {
    mockStore.get.mockResolvedValue(null);
    File.findByFileName.mockResolvedValue(null);
    await request(app).get('/api/uploads/missing').expect(404);
  });

  it('returns 404 when the legacy record exists but has no data (metadata-only)', async () => {
    mockStore.get.mockResolvedValue(null);
    File.findByFileName.mockResolvedValue({ data: Buffer.alloc(0), contentType: 'image/png' });
    await request(app).get('/api/uploads/empty.png').expect(404);
  });

  it('returns 500 when the driver throws', async () => {
    mockStore.get.mockRejectedValue(new Error('boom'));
    await request(app).get('/api/uploads/explode').expect(500);
  });
});
