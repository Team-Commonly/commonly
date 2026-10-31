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

jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ _id: 'user1' }) }) })),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = /^Bearer quota-test-/.test(req.get('Authorization') || '') ? 'quota-user' : 'user1';
  next();
});

jest.mock('../../../services/podMembershipService', () => ({
  requirePodMember: jest.fn(),
}));
const { requirePodMember } = require('../../../services/podMembershipService');

const POD = 'aaaaaaaaaaaaaaaaaaaaaaaa';

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
    requirePodMember.mockReset();
    requirePodMember.mockResolvedValue({ pod: { _id: POD }, canWrite: true });
  });

  it('writes bytes through the driver and saves metadata-only File', async () => {
    const res = await request(app)
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
    expect(res.body.url).toMatch(/^\/api\/uploads\/[^/]+\.png$/);
    expect(res.body.url).not.toMatch(/^https?:\/\//);
  });

  it('limits one user despite forged forwarding headers and rotating sessions', async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await request(app).post('/api/uploads')
        .set('Authorization', `Bearer quota-test-${attempt % 2}`)
        .set('cf-connecting-ip', `198.51.100.${attempt}`)
        .set('X-Forwarded-For', `203.0.113.${attempt}`).expect(400);
    }
    await request(app).post('/api/uploads').set('Authorization', 'Bearer quota-test-new')
      .set('cf-connecting-ip', '192.0.2.1').expect(429);
    await request(app).post('/api/uploads').expect(400);
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

  it('persists podId on the File row when the uploader can write to the pod', async () => {
    await request(app)
      .post('/api/uploads')
      .field('podId', POD)
      .attach('image', Buffer.from('data'), 'brief.pdf')
      .expect(200);
    expect(requirePodMember).toHaveBeenCalledWith(POD, 'user1', { write: true });
    const fileArgs = File.mock.calls[File.mock.calls.length - 1][0];
    expect(fileArgs.podId).toBe(POD);
  });

  it.each([
    ['a non-member', { error: 'Write access denied', status: 403 }],
    ['a viewer', { error: 'Write access denied', status: 403 }],
    ['an unknown pod', { error: 'Pod not found', status: 404 }],
  ])('refuses %s with 403 and stores nothing', async (_who, refusal) => {
    requirePodMember.mockResolvedValue(refusal);
    const res = await request(app)
      .post('/api/uploads')
      .field('podId', POD)
      .attach('image', Buffer.from('data'), 'brief.pdf')
      .expect(403);
    expect(res.body.msg).toBe('You cannot add files to this pod');
    expect(mockStore.put).not.toHaveBeenCalled();
    expect(File).not.toHaveBeenCalled();
  });

  it('refuses a malformed podId with the same 403, without a lookup', async () => {
    await request(app)
      .post('/api/uploads')
      .field('podId', 'pod-123')
      .attach('image', Buffer.from('data'), 'brief.pdf')
      .expect(403);
    expect(requirePodMember).not.toHaveBeenCalled();
    expect(mockStore.put).not.toHaveBeenCalled();
  });

  it('refuses with 403 when the membership lookup throws', async () => {
    requirePodMember.mockRejectedValue(new Error('db down'));
    await request(app)
      .post('/api/uploads')
      .field('podId', POD)
      .attach('image', Buffer.from('data'), 'brief.pdf')
      .expect(403);
    expect(mockStore.put).not.toHaveBeenCalled();
  });

  it('leaves podId null when not supplied, with no membership check', async () => {
    await request(app)
      .post('/api/uploads')
      .attach('image', Buffer.from('data'), 'photo.png')
      .expect(200);
    expect(requirePodMember).not.toHaveBeenCalled();
    const fileArgs = File.mock.calls[File.mock.calls.length - 1][0];
    expect(fileArgs.podId).toBeNull();
  });
});
