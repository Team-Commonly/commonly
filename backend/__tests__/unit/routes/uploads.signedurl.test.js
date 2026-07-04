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

// findByFileName(...).lean() resolves whatever mockFileMeta holds (null =
// unknown/un-scoped file → public read).
let mockFileMeta = null;
jest.mock('../../../models/File', () => ({
  findByFileName: jest.fn(() => ({ lean: () => Promise.resolve(mockFileMeta) })),
}));

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
const mockVerifyToken = jest.fn();
jest.mock('../../../services/attachmentAccess', () => ({
  DEFAULT_TOKEN_TTL_SECONDS: 300,
  canReadAttachment: (...args) => mockCanRead(...args),
  signAttachmentToken: (...args) => mockSignToken(...args),
  verifyAttachmentToken: (...args) => mockVerifyToken(...args),
}));

const mockJwtVerify = jest.fn();
jest.mock('jsonwebtoken', () => ({ verify: (...args) => mockJwtVerify(...args) }));

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
    mockFileMeta = null; // un-scoped → public read path
    await request(app).get('/api/uploads/foo').expect(404);
    expect(mockCanRead).not.toHaveBeenCalled();
  });
});

describe('GET /api/uploads/:fileName pod-scoped authorization (ADR-002 Phase 1b flip / #IDOR)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/uploads', routes);
    mockFileMeta = null;
    mockCanRead.mockReset();
    mockVerifyToken.mockReset();
    mockJwtVerify.mockReset();
    mockStore.get.mockReset().mockResolvedValue({ mime: 'image/png', stream: { pipe: (res) => res.end('bytes') } });
    process.env.JWT_SECRET = 'test-secret';
  });

  it('serves an UN-SCOPED file publicly (no podId — e.g. an avatar)', async () => {
    mockFileMeta = { podId: null };
    await request(app).get('/api/uploads/avatar.png').expect(200);
  });

  it('403s a POD-SCOPED file with no token and no auth (the IDOR fix)', async () => {
    mockFileMeta = { podId: 'pod-1' };
    const res = await request(app).get('/api/uploads/secret.pdf').expect(403);
    expect(res.body.msg).toMatch(/not authorized/i);
  });

  it('serves a POD-SCOPED file with a valid ?t= token', async () => {
    mockFileMeta = { podId: 'pod-1' };
    mockVerifyToken.mockReturnValue({ userId: 'user-1' });
    await request(app).get('/api/uploads/secret.pdf?t=good-token').expect(200);
    expect(mockVerifyToken).toHaveBeenCalledWith('good-token', 'secret.pdf');
  });

  it('serves a POD-SCOPED file to a Bearer user who canReadAttachment', async () => {
    mockFileMeta = { podId: 'pod-1' };
    mockVerifyToken.mockReturnValue(null);
    mockJwtVerify.mockReturnValue({ id: 'member-1' });
    mockCanRead.mockResolvedValue(true);
    await request(app).get('/api/uploads/secret.pdf').set('Authorization', 'Bearer jwt').expect(200);
    expect(mockCanRead).toHaveBeenCalledWith('secret.pdf', 'member-1');
  });

  it('403s a POD-SCOPED file when the Bearer user cannot read it', async () => {
    mockFileMeta = { podId: 'pod-1' };
    mockVerifyToken.mockReturnValue(null);
    mockJwtVerify.mockReturnValue({ id: 'outsider' });
    mockCanRead.mockResolvedValue(false);
    await request(app).get('/api/uploads/secret.pdf').set('Authorization', 'Bearer jwt').expect(403);
  });
});
