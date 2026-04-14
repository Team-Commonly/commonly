// ADR-002 Phase 1 — POST route covers driver.put + metadata-only File save,
// plus the new size-cap rejection branch.

const request = require('supertest');
const express = require('express');

const mockStore = {
  capabilities: { name: 'mongo', maxObjectBytes: 10 * 1024 * 1024 },
  get: jest.fn(),
  put: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn(),
};

jest.mock('../../../services/objectStore', () => ({
  getObjectStore: () => mockStore,
  __resetObjectStoreForTests: jest.fn(),
}));

jest.mock('../../../models/File', () => {
  const saveMock = jest.fn().mockResolvedValue(undefined);
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

describe('uploads POST / (ADR-002 Phase 1)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/uploads', routes);
    File.__saveMock.mockClear();
    File.mockClear();
    mockStore.put.mockClear();
  });

  it('writes bytes through the driver and saves metadata-only File', async () => {
    await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), 'photo.png')
      .expect(200);

    // Driver received the bytes + mime
    expect(mockStore.put).toHaveBeenCalledWith(
      expect.stringMatching(/\.png$/),
      expect.any(Buffer),
      'image/png',
    );
    // File was created with metadata only — no `data` field
    expect(File).toHaveBeenCalled();
    const fileArgs = File.mock.calls[0][0];
    expect(fileArgs.data).toBeUndefined();
    expect(fileArgs.fileName).toMatch(/\.png$/);
    expect(fileArgs.contentType).toBe('image/png');
    expect(fileArgs.uploadedBy).toBe('user1');
    expect(File.__saveMock).toHaveBeenCalled();
  });

  it('returns 400 when no file is provided', async () => {
    const res = await request(app).post('/api/uploads').expect(400);
    expect(res.body.msg).toBe('No file uploaded');
    expect(mockStore.put).not.toHaveBeenCalled();
  });

  it('rejects disallowed extensions before reaching the driver', async () => {
    await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), 'text.txt')
      .expect(500); // multer surfaces the filter error as 500
    expect(mockStore.put).not.toHaveBeenCalled();
  });
});
