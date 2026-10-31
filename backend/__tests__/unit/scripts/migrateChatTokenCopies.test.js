jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');
const path = require('path');
const { spawnSync } = require('child_process');
const ConnectorSecret = require('../../../models/ConnectorSecret');
const connectorSecrets = require('../../../services/connectorSecrets');
const { GROUPME_ACCESS_TOKEN } = require('../../../services/connectorSecretKinds');
const { readGroupmeAccessToken } = require('../../../services/chatConnectorTokens');
const { migrateChatTokenCopies, formatReport } = require('../../../scripts/migrate-chat-token-copies');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const rows = () => mongoose.connection.collection('integrations');
const key = (fill) => Buffer.alloc(32, fill).toString('base64');
const GM = 'groupme-plaintext-sentinel';
const GM_OLD = 'groupme-stale-copy-sentinel';
const SLACK = 'slack-plaintext-sentinel';
const REFRESH = 'refresh-plaintext-sentinel';

const seed = async () => {
  const ids = {
    move: new mongoose.Types.ObjectId(),
    hasRef: new mongoose.Types.ObjectId(),
    blank: new mongoose.Types.ObjectId(),
    clean: new mongoose.Types.ObjectId(),
    slack: new mongoose.Types.ObjectId(),
    slackBound: new mongoose.Types.ObjectId(),
    x: new mongoose.Types.ObjectId(),
  };
  const existingRef = await connectorSecrets.put(String(ids.hasRef), GROUPME_ACCESS_TOKEN, 'groupme-current-token');
  await rows().insertMany([
    {
      _id: ids.move,
      type: 'groupme',
      config: {
        botId: 'b1', groupId: 'g1', accessToken: GM, refreshToken: REFRESH, 
      }, 
    },
    { _id: ids.hasRef, type: 'groupme', config: { botId: 'b2', accessToken: GM_OLD, accessTokenRef: existingRef } },
    { _id: ids.blank, type: 'groupme', config: { botId: 'b3', accessToken: '', refreshToken: null } },
    { _id: ids.clean, type: 'groupme', config: { botId: 'b4' } },
    { _id: ids.slack, type: 'slack', config: { accessToken: SLACK, refreshToken: REFRESH, signingSecret: 'kept-signing' } },
    { _id: ids.slackBound, type: 'slack', config: { botTokenRef: 'slack-ref', botToken: 'kept-bot-token' } },
    { _id: ids.x, type: 'x', config: { accessToken: 'x-not-ours', feedAccessTokenRef: 'x-ref' } },
  ]);
  return { ids, existingRef };
};

const byId = async (id) => rows().findOne({ _id: id });

describe('migrate GroupMe and Slack token copies', () => {
  const saved = {
    keys: process.env.CONNECTOR_SECRET_KEYS,
    activeKey: process.env.CONNECTOR_SECRET_ACTIVE_KEY,
  };

  beforeAll(async () => {
    await setupMongoDb();
    await ConnectorSecret.syncIndexes();
  });
  afterAll(async () => {
    await closeMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = saved.keys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = saved.activeKey;
  });
  beforeEach(async () => {
    await clearMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = `k1:${key(9)}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
  });

  it('defaults to dry run: counts every field by type, writes nothing, prints no value', async () => {
    const { existingRef } = await seed();
    const before = await rows().find().toArray();
    const secretsBefore = await ConnectorSecret.countDocuments();
    const report = await migrateChatTokenCopies();
    expect(report).toEqual({
      groupme: {
        candidates: 3,
        accessFields: 3,
        refreshFields: 2,
        toMove: 1,
        moved: 0,
        cleared: 0,
        remaining: 3,
        inventory: { botToken: 0, signingSecret: 0, appToken: 0 },
      },
      slack: {
        candidates: 1,
        accessFields: 1,
        refreshFields: 1,
        toMove: 0,
        moved: 0,
        cleared: 0,
        remaining: 1,
        inventory: { botToken: 1, signingSecret: 1, appToken: 0 },
      },
    });
    expect(await rows().find().toArray()).toEqual(before);
    expect(await ConnectorSecret.countDocuments()).toBe(secretsBefore);
    const output = formatReport(report, false).join('\n');
    expect(output).toContain('DRY-RUN');
    [GM, GM_OLD, SLACK, REFRESH, existingRef, 'kept-bot-token'].forEach((value) => (
      expect(output).not.toContain(value)
    ));
  });

  it('moves a GroupMe token into connectorSecrets, keeps an existing ref, and scrubs both types', async () => {
    const { ids, existingRef } = await seed();
    const before = await rows().find().toArray();
    const report = await migrateChatTokenCopies({ apply: true });
    expect(report.groupme).toMatchObject({
      toMove: 1, moved: 1, cleared: 3, remaining: 0, 
    });
    expect(report.slack).toMatchObject({ cleared: 1, remaining: 0 });

    const moved = await byId(ids.move);
    expect(moved.config).toEqual({ botId: 'b1', groupId: 'g1', accessTokenRef: expect.any(String) });
    expect(await readGroupmeAccessToken(moved.config)).toBe(GM);

    // The ref is authoritative: an older plaintext copy never replaces it.
    const kept = await byId(ids.hasRef);
    expect(kept.config).toEqual({ botId: 'b2', accessTokenRef: existingRef });
    expect(await readGroupmeAccessToken(kept.config)).toBe('groupme-current-token');

    expect((await byId(ids.blank)).config).toEqual({ botId: 'b3' });
    expect((await byId(ids.slack)).config).toEqual({ signingSecret: 'kept-signing' });

    // Rows with nothing to do, and other types, are untouched.
    const untouched = await Promise.all([ids.clean, ids.slackBound, ids.x].map(byId));
    untouched.forEach((row) => expect(row).toEqual(before.find((entry) => entry._id.equals(row._id))));
    const output = formatReport(report, true).join('\n');
    [GM, GM_OLD, SLACK, REFRESH, existingRef].forEach((value) => expect(output).not.toContain(value));
  });

  it('is idempotent after apply', async () => {
    await seed();
    await migrateChatTokenCopies({ apply: true });
    const once = await rows().find().toArray();
    const secrets = await ConnectorSecret.countDocuments();
    const report = await migrateChatTokenCopies({ apply: true });
    expect(report.groupme).toMatchObject({
      candidates: 0, toMove: 0, moved: 0, cleared: 0, remaining: 0, 
    });
    expect(report.slack).toMatchObject({ candidates: 0, cleared: 0, remaining: 0 });
    expect(await rows().find().toArray()).toEqual(once);
    expect(await ConnectorSecret.countDocuments()).toBe(secrets);
  });

  it('keeps a token a live edit stored after the read, instead of writing the older copy over it', async () => {
    const id = new mongoose.Types.ObjectId();
    await rows().insertOne({ _id: id, type: 'groupme', config: { botId: 'b5', accessToken: GM_OLD } });
    // A PATCH has stored its new token but not yet set the row's ref.
    const liveRef = await connectorSecrets.put(String(id), GROUPME_ACCESS_TOKEN, 'groupme-live-edit');
    const report = await migrateChatTokenCopies({ apply: true });
    expect(report.groupme).toMatchObject({
      toMove: 1, moved: 0, cleared: 1, remaining: 0, 
    });
    const row = await byId(id);
    expect(row.config).toEqual({ botId: 'b5', accessTokenRef: liveRef });
    expect(await readGroupmeAccessToken(row.config)).toBe('groupme-live-edit');
  });

  it('stops before unsetting a GroupMe token it could not encrypt', async () => {
    const { ids } = await seed();
    delete process.env.CONNECTOR_SECRET_KEYS;
    delete process.env.CONNECTOR_SECRET_ACTIVE_KEY;
    await expect(migrateChatTokenCopies({ apply: true })).rejects.toThrow();
    const row = await byId(ids.move);
    expect(row.config.accessToken).toBe(GM);
    expect(row.config.accessTokenRef).toBeUndefined();
  });
});

describe('migrate CLI failure output', () => {
  it.each([{ args: [] }, { args: ['--unexpected-sensitive-argument'] }])('fails closed without echoing sensitive input ($args)', ({ args }) => {
    const secretUri = 'invalid-secret-uri-sentinel';
    const result = spawnSync(process.execPath, [
      '-r', require.resolve('ts-node/register'),
      path.resolve(__dirname, '../../../scripts/migrate-chat-token-copies.ts'),
      ...args,
    ], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, MONGO_URI: secretUri, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' ') },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('[migrate-chat-token-copies] Failed. No values logged; rerun dry-run to inspect counts.\n');
    expect(result.stderr).not.toContain(secretUri);
    expect(result.stderr).not.toContain('unexpected-sensitive-argument');
  });
});
