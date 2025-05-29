const request = require('supertest');
const express = require('express');

jest.mock('../../../models/File', () => {
  const saveMock = jest.fn();
  const File = jest.fn().mockImplementation((data) => ({ ...data, save: saveMock }));
  File.findByFileName = jest.fn();
  File.__saveMock = saveMock;
  return File;
});
const File = require('../../../models/File');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = 'user1';
  next();
});

const routes = require('../../../routes/uploads');

describe('uploads POST route', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/uploads', routes);
    File.__saveMock.mockReset();
    File.mockClear();
  });

  it('uploads image and saves file', async () => {
    await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), 'photo.png')
      .expect(200);
    expect(File).toHaveBeenCalled();
    expect(File.__saveMock).toHaveBeenCalled();
  });

  it('returns 400 when no file provided', async () => {
    const res = await request(app).post('/api/uploads').expect(400);
    expect(res.body.msg).toBe('No file uploaded');
  });

  it('rejects invalid file types', async () => {
    await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), 'text.txt')
      .expect(500);
  });
});
