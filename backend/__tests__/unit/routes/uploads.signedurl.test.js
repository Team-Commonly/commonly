// ADR-002 Phase 1b — signed-URL mint endpoint.

const request = require('supertest');
const express = require('express');

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

jest.mock('../../../models/File', () => ({ findByFileName: jest.fn() }));

// Auth middleware stub — writes userId if the header is present.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const header = req.header ? req.header('authorization') : null;
  if (header && header.startsWith('Bearer ')) {
    req.userId = header.slice(7);
    return next();
  }
  return res.status(401).json({ msg: 'unauth' });
});

const mockCanRead = jest.fn();
const mockSignToken = jest.fn().mockReturnValue('signed-token');
jest.mock('../../../services/attachmentAccess', () => ({
  DEFAULT_TOKEN_TTL_SECONDS: 300,
  canReadAttachment: (...args) => mockCanRead(...args),
  signAttachmentToken: (...args) => mockSignToken(...args),
}));

const mockLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/auditService', () => ({
  logAttachmentTokenMint: (...args) => mockLog(...args),
  ACTION_ATTACHMENT_TOKEN_MINT: 'attachment.token.mint',
}));

const routes = require('../../../routes/uploads');

describe('GET /api/uploads/:fileName/url (ADR-002 Phase 1b mint)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/uploads', routes);
    mockCanRead.mockReset();
    mockSignToken.mockClear().mockReturnValue('signed-token');
    mockLog.mockClear();
  });

  it('401s when no auth header is present', async () => {
    const res = await request(app).get('/api/uploads/pic.png/url').expect(401);
    expect(res.body.msg).toBe('unauth');
    expect(mockCanRead).not.toHaveBeenCalled();
  });

  it('403s when the ACL denies the viewer', async () => {
    mockCanRead.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/uploads/pic.png/url')
      .set('Authorization', 'Bearer user-1')
      .expect(403);
    expect(res.body.msg).toMatch(/no access/);
    expect(mockSignToken).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it('mints a token, returns a signed URL, and writes an audit log when allowed', async () => {
    mockCanRead.mockResolvedValue(true);
    const res = await request(app)
      .get('/api/uploads/pic.png/url')
      .set('Authorization', 'Bearer user-1')
      .expect(200);

    expect(res.body).toEqual({
      url: '/api/uploads/pic.png?t=signed-token',
      expiresIn: 300,
    });
    expect(mockCanRead).toHaveBeenCalledWith('pic.png', 'user-1');
    expect(mockSignToken).toHaveBeenCalledWith('pic.png', 'user-1');
    // Audit fire-and-forget — wait a tick for the microtask.
    await new Promise((r) => setImmediate(r));
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'pic.png', userId: 'user-1' }),
    );
  });

  it('500s when the ACL check throws', async () => {
    mockCanRead.mockRejectedValue(new Error('db down'));
    await request(app)
      .get('/api/uploads/pic.png/url')
      .set('Authorization', 'Bearer user-1')
      .expect(500);
  });

  it('does not shadow the bare GET — `/api/uploads/foo` still routes to the fetcher', async () => {
    mockStore.get.mockResolvedValue(null);
    const File = require('../../../models/File');
    File.findByFileName.mockResolvedValue(null);
    await request(app).get('/api/uploads/foo').expect(404);
    expect(mockCanRead).not.toHaveBeenCalled();
  });
});
