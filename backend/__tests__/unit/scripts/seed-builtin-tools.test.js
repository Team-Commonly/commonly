/**
 * Tools plan §2 follow-up (Vera 67821): the builtin seed upserts its own row
 * keyed on `{ installableId, source: 'builtin' }` and never claims a row another
 * source published under the same id. Real memory Mongo, because the unique
 * `installableId` index is part of what is under test.
 */
// testUtils pulls jsonwebtoken, which does not load under the local Node;
// the seed never signs anything, so the stub is exactly what seed-community-pods uses.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn().mockReturnValue('test-jwt-token'), verify: jest.fn() }));

const Installable = require('../../../models/Installable');
const { seedBuiltinTools } = require('../../../scripts/seed-builtin-tools');
const { buildGithubToolInstallable } = require('../../../services/installable/toolInstallables');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('seed-builtin-tools', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Installable.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.restoreAllMocks();
  });

  test('the seed creates the builtin row once and updates it in place', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await seedBuiltinTools();
    await seedBuiltinTools();
    const rows = await Installable.find({ installableId: 'github' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('builtin');
    expect(rows[0].components[0].enabledTools).toEqual(buildGithubToolInstallable().components[0].enabledTools);
  });

  test('the seed never claims a non-builtin row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const foreign = { ...buildGithubToolInstallable(), source: 'user', name: 'Someone else\'s GitHub' };
    foreign.components = [{ ...foreign.components[0], enabledTools: ['github.list_issues'] }];
    await Installable.create(foreign);

    await seedBuiltinTools();

    const rows = await Installable.find({ installableId: 'github' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('user');
    expect(rows[0].name).toBe('Someone else\'s GitHub');
    expect(rows[0].components[0].enabledTools).toEqual(['github.list_issues']);
    expect(await Installable.countDocuments({ source: 'builtin' })).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/held by a 'user' row/));
  });
});
