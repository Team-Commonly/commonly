// ADR-002 Phase 1b — token sign/verify + ACL fan-out.

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, JWT_SECRET: 'test-secret' };
  jest.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.resetAllMocks();
});

function load({ File, User, Post, Pod, pool } = {}) {
  jest.doMock('../../../models/File', () => File || { findByFileName: jest.fn().mockResolvedValue(null) });
  jest.doMock('../../../models/User', () => User || { findOne: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) }) });
  jest.doMock('../../../models/Post', () => Post || { findOne: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) }) });
  jest.doMock('../../../models/Pod', () => Pod || { findOne: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) }) });
  jest.doMock('../../../config/db-pg', () => ({
    pool: pool || { query: jest.fn().mockResolvedValue({ rows: [] }) },
  }));
  // eslint-disable-next-line global-require
  return require('../../../services/attachmentAccess');
}

function stubFound(doc) {
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
}

describe('signAttachmentToken / verifyAttachmentToken', () => {
  it('round-trips a valid token and returns the userId', () => {
    const svc = load();
    const token = svc.signAttachmentToken('pic.png', 'user-1');
    const result = svc.verifyAttachmentToken(token, 'pic.png');
    expect(result).toEqual({ userId: 'user-1' });
  });

  it('rejects a token minted for a different fileName', () => {
    const svc = load();
    const token = svc.signAttachmentToken('pic.png', 'user-1');
    expect(svc.verifyAttachmentToken(token, 'other.png')).toBeNull();
  });

  it('rejects a tampered token', () => {
    const svc = load();
    const token = svc.signAttachmentToken('pic.png', 'user-1');
    const tampered = token.slice(0, -3) + 'xxx';
    expect(svc.verifyAttachmentToken(tampered, 'pic.png')).toBeNull();
  });

  it('rejects an expired token', () => {
    const svc = load();
    const token = svc.signAttachmentToken('pic.png', 'user-1', -1);
    expect(svc.verifyAttachmentToken(token, 'pic.png')).toBeNull();
  });

  it('rejects a generic JWT without the upload purpose claim', () => {
    process.env.JWT_SECRET = 'test-secret';
    // eslint-disable-next-line global-require
    const jwt = require('jsonwebtoken');
    const svc = load();
    const rogue = jwt.sign({ id: 'user-1' }, 'test-secret', { expiresIn: 60 });
    expect(svc.verifyAttachmentToken(rogue, 'pic.png')).toBeNull();
  });
});

describe('canReadAttachment', () => {
  it('allows the uploader', async () => {
    const svc = load({
      File: { findByFileName: jest.fn().mockResolvedValue({ uploadedBy: 'user-1' }) },
    });
    await expect(svc.canReadAttachment('pic.png', 'user-1')).resolves.toBe(true);
  });

  it('allows any authed viewer when the file is someone\'s profile picture', async () => {
    const svc = load({
      User: { findOne: jest.fn().mockReturnValue(stubFound({ _id: 'any' })) },
    });
    await expect(svc.canReadAttachment('avatar.png', 'viewer')).resolves.toBe(true);
  });

  it('allows read when a public (no podId) post references the file', async () => {
    const svc = load({
      Post: { findOne: jest.fn().mockReturnValue(stubFound({ _id: 'p1', podId: null })) },
    });
    await expect(svc.canReadAttachment('inpost.png', 'viewer')).resolves.toBe(true);
  });

  it('allows read when a pod-scoped post references the file AND viewer is a member', async () => {
    const svc = load({
      Post: { findOne: jest.fn().mockReturnValue(stubFound({ _id: 'p1', podId: 'pod-A' })) },
      Pod: { findOne: jest.fn().mockReturnValue(stubFound({ _id: 'pod-A' })) },
    });
    await expect(svc.canReadAttachment('inpost.png', 'viewer')).resolves.toBe(true);
  });

  it('denies when a pod-scoped post references the file but viewer is NOT a member', async () => {
    const svc = load({
      Post: { findOne: jest.fn().mockReturnValue(stubFound({ _id: 'p1', podId: 'pod-A' })) },
      Pod: { findOne: jest.fn().mockReturnValue(stubFound(null)) },
    });
    await expect(svc.canReadAttachment('inpost.png', 'outsider')).resolves.toBe(false);
  });

  it('allows read when a PG message in a pod the viewer is a member of references the file', async () => {
    const svc = load({
      pool: { query: jest.fn().mockResolvedValue({ rows: [{ pod_id: 'pod-B' }] }) },
      Pod: { findOne: jest.fn().mockReturnValue(stubFound({ _id: 'pod-B' })) },
    });
    await expect(svc.canReadAttachment('inchat.png', 'viewer')).resolves.toBe(true);
  });

  it('denies when no surface references the file', async () => {
    const svc = load();
    await expect(svc.canReadAttachment('orphan.png', 'viewer')).resolves.toBe(false);
  });

  it('denies when inputs are empty', async () => {
    const svc = load();
    await expect(svc.canReadAttachment('', 'viewer')).resolves.toBe(false);
    await expect(svc.canReadAttachment('file.png', '')).resolves.toBe(false);
  });

  it('denies implausible fileNames without running DB queries (ReDoS guard)', async () => {
    const File = { findByFileName: jest.fn() };
    const svc = load({ File });
    // regex metachars → would otherwise go into Mongo $regex
    await expect(svc.canReadAttachment('(.*)+$', 'viewer')).resolves.toBe(false);
    // path traversal
    await expect(svc.canReadAttachment('../etc/passwd', 'viewer')).resolves.toBe(false);
    // excess length
    await expect(svc.canReadAttachment('a'.repeat(500), 'viewer')).resolves.toBe(false);
    expect(File.findByFileName).not.toHaveBeenCalled();
  });
});
