// F477. A hosted-MCP removal that stopped part-way leaves its row
// `disconnected` with `revokedAt` set. The page lists only connected rows, so
// the person has no Disconnect left to press, and nothing else re-runs it. The
// row's encrypted token stays behind, and the orphan sweep keeps it because
// removal leaves `isActive` alone on purpose. For a page-only entry, or a
// vendor revoke that failed, that copy is of a token still live at the vendor.
//
// finishIncompleteRemovals re-runs the removal for those rows, in the same
// order, so a failed vendor revoke is retried and the copy is swept. It must
// never touch a row a person is reconnecting, or a removal still in flight.
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');

const Integration = require('../../../models/Integration');
const ConnectorSecret = require('../../../models/ConnectorSecret');
const { put } = require('../../../services/connectorSecrets');
const { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } = require('../../../services/connectorSecretKinds');
const {
  finishIncompleteRemovals,
  markIncompleteRemovalDisconnected,
  INCOMPLETE_REMOVAL_GRACE_MS,
  PROVIDER_REVOKED_MARK,
} = require('../../../services/connectionRemovalService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const NOW = new Date('2026-11-13T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - INCOMPLETE_REMOVAL_GRACE_MS - 60000);
const JUST_NOW = new Date(NOW.getTime() - 60000);

const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;

beforeAll(async () => {
  await setupMongoDb();
  process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
});

afterAll(async () => {
  process.env.CONNECTOR_SECRET_KEYS = originalKeys;
  process.env.CONNECTOR_SECRET_ACTIVE_KEY = originalActiveKey;
  await closeMongoDb();
});

afterEach(async () => {
  await clearMongoDb();
});

/** A hosted row as a removal leaves it, holding its pair. */
const leftRow = async ({
  entryId = 'linear', status = 'disconnected', revokedAt = LONG_AGO, config = {}, secrets = true,
} = {}) => {
  const row = await Integration.create({
    type: 'hosted-mcp',
    scope: 'user',
    status,
    createdBy: new mongoose.Types.ObjectId(),
    ...(revokedAt ? { revokedAt } : {}),
    config: {
      entryId, clientId: 'commonly-client', authGeneration: 3, ...config, 
    },
  });
  if (secrets) {
    const credentialRef = await put(String(row._id), HOSTED_MCP_ACCESS_TOKEN, `access-${entryId}`);
    const refreshTokenRef = await put(String(row._id), HOSTED_MCP_REFRESH_TOKEN, `refresh-${entryId}`);
    await Integration.updateOne({ _id: row._id }, { $set: { 'config.credentialRef': credentialRef, 'config.refreshTokenRef': refreshTokenRef } });
  }
  return Integration.findById(row._id).lean();
};

const secretsOf = (row) => ConnectorSecret.countDocuments({ integrationId: row._id });

/** The vendor and the client lookup are the only stand-ins; the rows and secrets are real. */
const run = (over = {}) => {
  const revokeAtVendor = over.revokeAtVendor || jest.fn(async () => undefined);
  const revokeGrants = jest.fn(async () => 0);
  return {
    revokeAtVendor,
    revokeGrants,
    result: finishIncompleteRemovals({
      now: NOW,
      removedBy: 'system',
      revokeGrants,
      deps: {
        now: () => NOW,
        revokeAtVendor,
        clientIdFor: () => 'commonly-client',
        clientSecretFor: () => undefined,
      },
    }),
  };
};

describe('finishIncompleteRemovals (F477)', () => {
  it('finishes a row whose vendor revoke took but whose sweep failed, without calling the vendor again', async () => {
    const row = await leftRow({ config: { [PROVIDER_REVOKED_MARK]: LONG_AGO.toISOString() } });
    const { revokeAtVendor, result } = run();

    expect(await result).toMatchObject({ finished: 1, unfinished: 0 });
    expect(revokeAtVendor).not.toHaveBeenCalled();
    expect(await Integration.findById(row._id)).toBeNull();
    expect(await secretsOf(row)).toBe(0);
  });

  it('retries a failed vendor revoke with the token it still holds, then sweeps the copy', async () => {
    const row = await leftRow();
    const { revokeAtVendor, result } = run();

    expect(await result).toMatchObject({ finished: 1, unfinished: 0 });
    expect(revokeAtVendor).toHaveBeenCalledTimes(1);
    expect(revokeAtVendor.mock.calls[0][0]).toMatchObject({ token: 'refresh-linear', tokenTypeHint: 'refresh_token' });
    expect(await Integration.findById(row._id)).toBeNull();
    expect(await secretsOf(row)).toBe(0);
  });

  it('keeps the row and its token when the vendor still refuses, for the next pass', async () => {
    const row = await leftRow();
    const { result } = run({ revokeAtVendor: jest.fn(async () => { throw new Error('vendor 503'); }) });

    expect(await result).toMatchObject({ finished: 0, unfinished: 1 });
    expect(await Integration.findById(row._id)).not.toBeNull();
    expect(await secretsOf(row)).toBe(2);
  });

  it('sweeps a page-only entry\'s copy without calling the vendor', async () => {
    const row = await leftRow({ entryId: 'atlassian' });
    const { revokeAtVendor, result } = run();

    expect(await result).toMatchObject({ finished: 1, unfinished: 0 });
    expect(revokeAtVendor).not.toHaveBeenCalled();
    expect(await Integration.findById(row._id)).toBeNull();
    expect(await secretsOf(row)).toBe(0);
  });

  it('finishes a row whose secrets are already gone (the shape found on prod)', async () => {
    const row = await leftRow({ entryId: 'notion', secrets: false, config: { credentialRef: new mongoose.Types.ObjectId().toString() } });
    const { revokeAtVendor, result } = run();

    expect(await result).toMatchObject({ finished: 1, unfinished: 0 });
    expect(revokeAtVendor).not.toHaveBeenCalled();
    expect(await Integration.findById(row._id)).toBeNull();
  });

  it('leaves a removal that started inside the grace window to finish on its own', async () => {
    const row = await leftRow({ revokedAt: JUST_NOW });
    const { revokeAtVendor, result } = run();

    expect(await result).toMatchObject({ finished: 0, unfinished: 0 });
    expect(revokeAtVendor).not.toHaveBeenCalled();
    expect(await secretsOf(row)).toBe(2);
  });

  it('never touches a row a person is reconnecting', async () => {
    const pendingAuth = {
      state: 's',
      codeVerifier: 'v',
      browserNonce: 'n',
      clientId: 'commonly-client',
      expiresAt: new Date(NOW.getTime() + 5 * 60000),
    };
    const row = await leftRow({ config: { pendingAuth } });
    const { revokeAtVendor, result } = run();

    expect(await result).toMatchObject({ finished: 0, unfinished: 0 });
    expect(revokeAtVendor).not.toHaveBeenCalled();
    const after = await Integration.findById(row._id).lean();
    expect(after.config.pendingAuth?.state).toBe('s');
    expect(after.config.authGeneration).toBe(3);
    expect(await secretsOf(row)).toBe(2);
  });

  it('finishes a row whose reconnect lapsed unfinished', async () => {
    const pendingAuth = {
      state: 's',
      codeVerifier: 'v',
      browserNonce: 'n',
      clientId: 'commonly-client',
      expiresAt: new Date(NOW.getTime() - 60000),
    };
    const row = await leftRow({ entryId: 'atlassian', config: { pendingAuth } });
    const { result } = run();

    expect(await result).toMatchObject({ finished: 1 });
    expect(await Integration.findById(row._id)).toBeNull();
  });

  it('leaves connected rows, and disconnected rows no removal wrote, alone', async () => {
    const connected = await leftRow({ status: 'connected', revokedAt: null });
    const otherDisconnect = await leftRow({ revokedAt: null });
    const { revokeAtVendor, result } = run();

    expect(await result).toMatchObject({ finished: 0, unfinished: 0 });
    expect(revokeAtVendor).not.toHaveBeenCalled();
    expect(await secretsOf(connected)).toBe(2);
    expect(await secretsOf(otherDisconnect)).toBe(2);
  });

  // The read and the write are separate, so a reconnect can start between
  // them. The pass's own disconnect write refuses then, and the reconnect's
  // pending authorization and generation survive.
  it('loses to a reconnect that starts between its read and its write', async () => {
    const row = await leftRow({ entryId: 'atlassian' });
    // The reconnect's /start lands after the pass read the row.
    await Integration.updateOne(
      { _id: row._id },
      {
        $set: {
          'config.pendingAuth': {
            state: 'raced',
            codeVerifier: 'v',
            browserNonce: 'n',
            clientId: 'commonly-client',
            expiresAt: new Date(NOW.getTime() + 5 * 60000),
          },
        },
        $inc: { 'config.authGeneration': 1 },
      },
    );
    expect(await markIncompleteRemovalDisconnected(row._id, NOW)).toBeNull();

    const after = await Integration.findById(row._id).lean();
    expect(after.config.pendingAuth?.state).toBe('raced');
    expect(after.config.authGeneration).toBe(4);
    expect(await secretsOf(row)).toBe(2);
  });

  it('the guarded write keeps the removal\'s first revokedAt and fences a lapsed reconnect', async () => {
    const row = await leftRow({
      entryId: 'atlassian',
      config: {
        pendingAuth: {
          state: 'old',
          codeVerifier: 'v',
          browserNonce: 'n',
          clientId: 'commonly-client',
          expiresAt: new Date(NOW.getTime() - 60000),
        },
      },
    });
    const written = await markIncompleteRemovalDisconnected(row._id, NOW);

    expect(written).toMatchObject({ status: 'disconnected' });
    expect(new Date(written.revokedAt).getTime()).toBe(LONG_AGO.getTime());
    expect(written.config.pendingAuth).toBeUndefined();
    expect(written.config.authGeneration).toBe(4);
  });
});
