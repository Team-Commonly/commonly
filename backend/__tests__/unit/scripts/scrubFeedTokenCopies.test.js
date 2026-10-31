jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');
const path = require('path');
const { spawnSync } = require('child_process');
const { scrubFeedTokenCopies, formatReport } = require('../../../scripts/scrub-feed-token-copies');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const rows = () => mongoose.connection.collection('integrations');
const ACCESS = 'legacy-access-sentinel';
const REFRESH = 'legacy-refresh-sentinel';

const seed = async () => {
  const records = [
    { type: 'x', active: true, config: { accessToken: ACCESS, refreshToken: REFRESH, feedAccessTokenRef: 'encrypted-access-ref', feedRefreshTokenRef: 'encrypted-refresh-ref', username: 'keep-account' } },
    { type: 'x', active: false, config: { accessToken: '', refreshToken: null } },
    { type: 'instagram', config: { accessToken: ACCESS, refreshToken: { old: REFRESH }, feedAccessTokenRef: 'ig-ref' } },
    { type: 'instagram', config: { username: 'no-credential' } },
    { type: 'groupme', config: { accessToken: ACCESS, refreshToken: REFRESH } },
    { type: 'slack', config: { accessToken: ACCESS } },
  ];
  await rows().insertMany(records);
  return records;
};

describe('scrub legacy feed token copies', () => {
  beforeAll(async () => setupMongoDb());
  afterAll(async () => closeMongoDb());
  beforeEach(async () => clearMongoDb());

  it('defaults to dry run, counting fields by type without changing any row', async () => {
    await seed();
    const before = await rows().find().toArray();
    const report = await scrubFeedTokenCopies();
    expect(report).toEqual({
      x: { candidates: 2, accessFields: 2, refreshFields: 2, cleared: 0, remaining: 2 },
      instagram: { candidates: 1, accessFields: 1, refreshFields: 1, cleared: 0, remaining: 1 },
    });
    expect(await rows().find().toArray()).toEqual(before);
    const output = formatReport(report, false).join('\n');
    expect(output).toContain('DRY-RUN');
    expect(output).not.toContain(ACCESS);
    expect(output).not.toContain(REFRESH);
    expect(output).not.toContain('encrypted-access-ref');
  });

  it('unsets both legacy fields, preserving refs, other config and non-feed rows', async () => {
    const records = await seed();
    const before = await rows().find().toArray();
    const report = await scrubFeedTokenCopies({ apply: true });
    expect(report.x).toMatchObject({ cleared: 2, remaining: 0 });
    expect(report.instagram).toMatchObject({ cleared: 1, remaining: 0 });
    const after = await rows().find().toArray();
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < records.length; i += 1) {
      const expected = { ...before[i], config: { ...before[i].config } };
      if (['x', 'instagram'].includes(expected.type)) {
        delete expected.config.accessToken;
        delete expected.config.refreshToken;
      }
      expect(after.find((row) => row._id.equals(expected._id))).toEqual(expected);
    }
    const output = formatReport(report, true).join('\n');
    expect(output).not.toContain(ACCESS);
    expect(output).not.toContain(REFRESH);
  });

  it.each([{ args: [], apply: false }, { args: ['--apply'], apply: true }])(
    'runs successful CLI with apply=$apply against the seeded Mongo database',
    async ({ args, apply }) => {
      await seed();
      const before = await rows().find().toArray();
      const uri = process.env.INTEGRATION_TEST === 'true'
        ? process.env.MONGO_URI
        : `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`;
      const result = spawnSync(process.execPath, [
        '-r', require.resolve('ts-node/register'),
        path.resolve(__dirname, '../../../scripts/scrub-feed-token-copies.ts'),
        ...args,
      ], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env, MONGO_URI: uri, NODE_OPTIONS: '--no-deprecation' },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(apply ? '[scrub-feed-token-copies] APPLY' : '[scrub-feed-token-copies] DRY-RUN');
      expect(result.stdout).not.toContain(ACCESS);
      expect(result.stdout).not.toContain(REFRESH);
      expect(result.stdout).not.toContain(uri);
      const after = await rows().find().toArray();
      expect(after).toHaveLength(before.length);
      for (const row of before) {
        const expected = { ...row, config: { ...row.config } };
        if (apply && ['x', 'instagram'].includes(row.type)) {
          delete expected.config.accessToken;
          delete expected.config.refreshToken;
        }
        expect(after.find((entry) => entry._id.equals(row._id))).toEqual(expected);
      }
    },
  );

  it('is idempotent after apply, including access-only and refresh-only rows', async () => {
    await rows().insertMany([
      { type: 'x', config: { refreshToken: REFRESH } },
      { type: 'instagram', config: { accessToken: ACCESS } },
    ]);
    await scrubFeedTokenCopies({ apply: true });
    const once = await rows().find().toArray();
    const report = await scrubFeedTokenCopies({ apply: true });
    for (const counts of Object.values(report)) {
      expect(counts).toEqual({ candidates: 0, accessFields: 0, refreshFields: 0, cleared: 0, remaining: 0 });
    }
    expect(await rows().find().toArray()).toEqual(once);
  });
});

describe('scrub CLI failure output', () => {
  it.each([{ args: [] }, { args: ['--unexpected-sensitive-argument'] }])('fails closed without echoing sensitive input ($args)', ({ args }) => {
    const secretUri = 'invalid-secret-uri-sentinel';
    const result = spawnSync(process.execPath, [
      '-r', require.resolve('ts-node/register'),
      path.resolve(__dirname, '../../../scripts/scrub-feed-token-copies.ts'),
      ...args,
    ], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, MONGO_URI: secretUri, NODE_OPTIONS: '--no-deprecation' },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('[scrub-feed-token-copies] Failed. No values logged; rerun dry-run to inspect counts.\n');
    expect(result.stderr).not.toContain(secretUri);
    expect(result.stderr).not.toContain('unexpected-sensitive-argument');
  });
});
