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

  it('rejects disallowed extensions with a 400 (not a 500)', async () => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), 'malware.exe')
      .expect(400);
    expect(res.body.msg).toMatch(/not allowed/i);
    expect(mockStore.put).not.toHaveBeenCalled();
  });

  it.each([
    ['brief.pdf', 'document'],
    ['notes.md', 'document'],
    ['notes.txt', 'document'],
    ['data.csv', 'data'],
    ['payload.json', 'data'],
    ['photo.png', 'image'],
    ['report.docx', 'office'],
    ['legacy-report.doc', 'office'],
    ['cap-table.xlsx', 'office'],
    ['legacy-budget.xls', 'office'],
    ['deck.pptx', 'office'],
    ['legacy-deck.ppt', 'office'],
    ['notes.odt', 'office'],
    ['data.ods', 'office'],
    ['slides.odp', 'office'],
    ['logs.zip', 'archive'],
  ])('accepts %s and reports kind=%s', async (filename, expectedKind) => {
    const res = await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), filename)
      .expect(200);
    expect(res.body.kind).toBe(expectedKind);
    expect(res.body.originalName).toBe(filename);
    expect(mockStore.put).toHaveBeenCalled();
  });

  it('persists podId on the File row when supplied', async () => {
    await request(app)
      .post('/api/uploads')
      .field('podId', 'pod-123')
      .attach('image', Buffer.from('data'), 'brief.pdf')
      .expect(200);
    const fileArgs = File.mock.calls[File.mock.calls.length - 1][0];
    expect(fileArgs.podId).toBe('pod-123');
  });

  it('leaves podId null when not supplied', async () => {
    await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), 'photo.png')
      .expect(200);
    const fileArgs = File.mock.calls[File.mock.calls.length - 1][0];
    expect(fileArgs.podId).toBeNull();
  });
});
