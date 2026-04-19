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

function stubFindOne(doc) {
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
}
function stubFindMany(docs) {
  return { select: () => ({ limit: () => ({ lean: () => Promise.resolve(docs) }) }) };
}

function load({ File, User, Post, Pod, pool } = {}) {
  jest.doMock('../../../models/File', () => File || { findByFileName: jest.fn().mockResolvedValue(null) });
  jest.doMock('../../../models/User', () => User || { findOne: jest.fn().mockReturnValue(stubFindOne(null)) });
  jest.doMock('../../../models/Post', () => Post || { find: jest.fn().mockReturnValue(stubFindMany([])) });
  jest.doMock('../../../models/Pod', () => Pod || { findOne: jest.fn().mockReturnValue(stubFindOne(null)) });
  jest.doMock('../../../config/db-pg', () => ({
    pool: pool || { query: jest.fn().mockResolvedValue({ rows: [] }) },
  }));
  // eslint-disable-next-line global-require
  return require('../../../services/attachmentAccess');
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

  it("allows any authed viewer when the file is someone's profile picture (relative URL)", async () => {
    const svc = load({
      User: { findOne: jest.fn().mockReturnValue(stubFindOne({ _id: 'any' })) },
    });
    await expect(svc.canReadAttachment('avatar.png', 'viewer')).resolves.toBe(true);
  });

  it('matches profile pictures stored as absolute URLs (substring regex)', async () => {
    const findOne = jest.fn().mockReturnValue(stubFindOne({ _id: 'any' }));
    const svc = load({ User: { findOne } });
    await expect(svc.canReadAttachment('avatar.png', 'viewer')).resolves.toBe(true);
    // The query is a substring regex over profilePicture — this allows both
    // `/api/uploads/avatar.png` and `https://api-dev.commonly.me/api/uploads/avatar.png`
    // to match. We assert the query shape, not the regex contents.
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({
      profilePicture: expect.objectContaining({ $regex: expect.any(String) }),
    }));
  });

  it('allows read when a public (no podId) post references the file', async () => {
    const svc = load({
      Post: { find: jest.fn().mockReturnValue(stubFindMany([{ _id: 'p1', podId: null }])) },
    });
    await expect(svc.canReadAttachment('inpost.png', 'viewer')).resolves.toBe(true);
  });

  it('allows read when any referencing pod-scoped post is in a pod the viewer is a member of', async () => {
    const svc = load({
      Post: {
        find: jest.fn().mockReturnValue(stubFindMany([
          { _id: 'p1', podId: 'pod-A' },
          { _id: 'p2', podId: 'pod-B' },
        ])),
      },
      Pod: { findOne: jest.fn().mockReturnValue(stubFindOne({ _id: 'pod-B' })) },
    });
    await expect(svc.canReadAttachment('inpost.png', 'viewer')).resolves.toBe(true);
  });

  it('allows read when the file is referenced in BOTH a hidden pod AND a public post (fan-out)', async () => {
    // Regression for fix #2: `findOne` would have picked one arbitrarily;
    // if it picked pod-A (viewer not a member), this branch would fall
    // through and potentially deny access even though a public post grants it.
    const svc = load({
      Post: {
        find: jest.fn().mockReturnValue(stubFindMany([
          { _id: 'p1', podId: 'pod-A' }, // viewer not a member
          { _id: 'p2', podId: null }, // public — always grants access
        ])),
      },
      Pod: { findOne: jest.fn().mockReturnValue(stubFindOne(null)) },
    });
    await expect(svc.canReadAttachment('inpost.png', 'viewer')).resolves.toBe(true);
  });

  it('denies when every referencing post is pod-scoped and viewer is in none of them', async () => {
    const svc = load({
      Post: {
        find: jest.fn().mockReturnValue(stubFindMany([{ _id: 'p1', podId: 'pod-A' }])),
      },
      Pod: { findOne: jest.fn().mockReturnValue(stubFindOne(null)) },
    });
    await expect(svc.canReadAttachment('inpost.png', 'outsider')).resolves.toBe(false);
  });

  it('allows read across multiple referencing pods when viewer is a member of any (PG fan-out)', async () => {
    // Regression for fix #3: LIMIT 1 on PG previously returned an arbitrary
    // pod; a viewer in pod-B but not pod-A would have been denied.
    const svc = load({
      pool: {
        query: jest.fn().mockResolvedValue({
          rows: [{ pod_id: 'pod-A' }, { pod_id: 'pod-B' }],
        }),
      },
      Pod: { findOne: jest.fn().mockReturnValue(stubFindOne({ _id: 'pod-B' })) },
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
    await expect(svc.canReadAttachment('(.*)+$', 'viewer')).resolves.toBe(false);
    await expect(svc.canReadAttachment('../etc/passwd', 'viewer')).resolves.toBe(false);
    await expect(svc.canReadAttachment('a'.repeat(500), 'viewer')).resolves.toBe(false);
    expect(File.findByFileName).not.toHaveBeenCalled();
  });
});
