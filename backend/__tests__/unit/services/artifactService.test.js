const mongoose = require('mongoose');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const File = require('../../../models/File');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const {
  kindOf, encodeCursor, decodeCursor, clampLimit, nameFilter, listArtifacts, ARTIFACT_SELECT,
} = require('../../../services/artifactService');

describe('artifactService', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });

  test('kind is derived from contentType: image/* → image, text/html only → page, everything else → doc', () => {
    expect(kindOf('image/png')).toBe('image');
    expect(kindOf('IMAGE/JPEG')).toBe('image');
    expect(kindOf('text/html')).toBe('page');
    expect(kindOf('text/html; charset=utf-8')).toBe('page');
    // 66376: markdown stays a doc — plan.md and adr-026-daemon.md file under doc.
    expect(kindOf('text/markdown')).toBe('doc');
    expect(kindOf('application/pdf')).toBe('doc');
    expect(kindOf(undefined)).toBe('doc');
  });

  test('the projection is metadata only — the file bytes never leave Mongo for a listing', async () => {
    expect(ARTIFACT_SELECT.split(/\s+/)).not.toContain('data');
    const select = jest.spyOn(File, 'find');
    await listArtifacts({ scopePodIds: [new mongoose.Types.ObjectId()] });
    const chain = select.mock.results[0]?.value;
    expect(chain).toBeDefined();
    select.mockRestore();
    // The chain is real (a Mongoose Query); assert the projection it carries.
    expect(chain.projection ? chain.projection() : chain._fields).toEqual(expect.objectContaining({ fileName: 1, originalName: 1 }));
    expect(chain.projection ? chain.projection() : chain._fields).not.toHaveProperty('data');
  });

  test('cursor round-trips and rejects garbage', () => {
    const cursor = { createdAt: '2026-09-08T10:00:00.000Z', id: '64b7f0c2e4b0a1a2b3c4d5e6' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('nope|zzz').toString('base64url'))).toBeNull();
  });

  test('limit clamps to 1..100 with a default of 50; q is a literal, case-insensitive name match', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit('0')).toBe(50);
    expect(clampLimit('7')).toBe(7);
    expect(clampLimit('500')).toBe(100);
    expect(nameFilter('  ')).toBeNull();
    expect(nameFilter('plan.(v2)').originalName.test('PLAN.(V2).md')).toBe(true);
    expect(nameFilter('plan.(v2)').originalName.test('planX(v2)')).toBe(false);
  });

  test('lists newest first within the scope, pages by cursor without repeats, and filters by pod, kind and name', async () => {
    const user = await new User({ username: 'lily', email: 'lily@example.com', password: 'Password123!' }).save();
    const bot = await new User({ username: 'ux-lead', email: 'ux@example.com', password: 'Password123!', botMetadata: { displayName: 'UX Lead' } }).save();
    const sharpen = await new Pod({ name: 'Sharpen — pod model', members: [user._id], createdBy: user._id }).save();
    const other = await new Pod({ name: 'Elsewhere', members: [bot._id], createdBy: bot._id }).save();
    const base = new Date('2026-09-08T09:00:00.000Z').getTime();
    const mk = (i, overrides) => new File({
      fileName: `f${i}`, originalName: `file-${i}.pdf`, contentType: 'application/pdf', size: 10 + i,
      uploadedBy: user._id, podId: sharpen._id, createdAt: new Date(base + i * 1000), ...overrides,
    }).save();
    await mk(1, {});
    await mk(2, { originalName: 'walk-1440.png', contentType: 'image/png', uploadedBy: bot._id });
    await mk(3, { originalName: 'workspace.html', contentType: 'text/html' });
    await mk(4, { originalName: 'plan.md', contentType: 'text/markdown' });
    await mk(5, { originalName: 'secret.pdf', podId: other._id, uploadedBy: bot._id });

    const scope = { scopePodIds: [sharpen._id] };
    const all = await listArtifacts({ ...scope, limit: 10 });
    expect(all.total).toBe(4);
    expect(all.items.map((i) => i.name)).toEqual(['plan.md', 'workspace.html', 'walk-1440.png', 'file-1.pdf']);
    expect(all.items.map((i) => i.kind)).toEqual(['doc', 'page', 'image', 'doc']);
    expect(all.items[2].sharedBy).toEqual({ id: String(bot._id), username: 'ux-lead', displayName: 'UX Lead' });
    expect(all.items[0].podName).toBe('Sharpen — pod model');
    expect(all.nextCursor).toBeNull();

    const first = await listArtifacts({ ...scope, limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await listArtifacts({ ...scope, limit: 3, after: first.nextCursor });
    expect(second.items.map((i) => i.name)).toEqual(['file-1.pdf']);
    expect(second.nextCursor).toBeNull();

    expect((await listArtifacts({ ...scope, kind: 'image' })).items.map((i) => i.name)).toEqual(['walk-1440.png']);
    expect((await listArtifacts({ ...scope, kind: 'page' })).items.map((i) => i.name)).toEqual(['workspace.html']);
    expect((await listArtifacts({ ...scope, kind: 'doc' })).items.map((i) => i.name)).toEqual(['plan.md', 'file-1.pdf']);
    expect((await listArtifacts({ ...scope, q: 'PLAN' })).items.map((i) => i.name)).toEqual(['plan.md']);
    // A podId outside the scope reads nothing, never the other pod's file.
    expect((await listArtifacts({ ...scope, podId: String(other._id) })).items).toEqual([]);
    expect((await listArtifacts({ scopePodIds: [] })).total).toBe(0);
  });
});
