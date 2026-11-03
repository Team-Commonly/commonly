/**
 * A file's name is stored as the person typed it, in any script.
 *
 * Browsers send a multipart filename as raw UTF-8 with no charset parameter.
 * multer 2 decodes such a parameter as latin1 unless told otherwise, so
 * "2025年报告.png" was stored as "2025å¹´æ\u008a¥å\u0091\u008a.png" and shown that
 * way on the Artifacts page and in the pod inspector's Files list.
 */

const express = require('express');
const request = require('supertest');

const { setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken } = require('../utils/testUtils');

const mockPgPool = { query: jest.fn() };
jest.mock('../../config/db-pg', () => ({ pool: mockPgPool }));

const User = require('../../models/User');
const File = require('../../models/File');

const uploadsRoutes = require('../../routes/uploads');

// Smallest valid PNG (1x1), so content sniffing sees a real image.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

describe('uploads keep non-ASCII file names intact', () => {
  let app;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-upload-charset';
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/uploads', uploadsRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    mockPgPool.query.mockReset();
    mockPgPool.query.mockResolvedValue({ rows: [] });
  });

  it.each([
    ['Chinese', '2025年报告.png'],
    ['accented Latin', 'résumé-café.png'],
    ['emoji', 'launch 🚀.png'],
    ['plain ASCII', 'sheet-390-light.png'],
  ])('stores a %s name as sent', async (_label, name) => {
    const user = await User.create({
      username: `u-${Math.random().toString(36).slice(2, 10)}`,
      email: `${Math.random().toString(36).slice(2, 10)}@test.com`,
      password: 'Password123!',
    });
    const res = await request(app)
      .post('/api/uploads')
      .set('Authorization', `Bearer ${generateTestToken(user._id)}`)
      .attach('image', PNG, { filename: name, contentType: 'image/png' });

    expect(res.status).toBeLessThan(300);
    const saved = await File.findOne({ uploadedBy: user._id }).lean();
    expect(saved.originalName).toBe(name);
  });
});
