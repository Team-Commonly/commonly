// The registry manifest is the only place a first-party app declares which
// driver runs it, and `routes/registry/install.ts` copies that declaration into
// an install whose caller omitted a runtimeType.
//
// TASK-043: the read was dead. `ManifestRuntimeSchema` had no `runtimeType`
// path and the subdocument is `strict: true`, so the field was dropped on every
// write — a native app installed from the Hub (which sends no runtimeType)
// landed with runtimeType unset, and events went to the external queue with no
// listener for an in-process agent. The route's test kept passing because its
// fixture was a hand-written object, not something the schema can produce.
//
// So this file holds the contract the route depends on: declaring the identity
// is (a) possible and (b) preserved. Break either and these fail here rather
// than in production.

const { AgentRegistry } = require('../../../models/AgentRegistry');

const buildDoc = (runtime) => new AgentRegistry({
  agentName: 't043-native-app',
  displayName: 'T043',
  description: 'x',
  manifest: { name: 't043-native-app', version: '1.0.0', runtime },
});

describe('AgentRegistry manifest runtime block', () => {
  it('preserves a declared driver identity through the schema', () => {
    const { runtime } = buildDoc({ runtimeType: 'native' }).toObject().manifest;
    expect(runtime.runtimeType).toBe('native');
  });

  it('still strips an undeclared field — the reason the schema path is load-bearing', () => {
    // Same document, one field the schema does not know. If this expectation
    // ever flips, strict mode is off and the bug class is gone; until then the
    // asymmetry above is the whole fix.
    const { runtime } = buildDoc({ runtimeType: 'native', notAField: 'x' }).toObject().manifest;
    expect(runtime).not.toHaveProperty('notAField');
  });

  it('keeps the driver identity out of the deployment-shape field', () => {
    // The seeder used to write `type: 'native'`, which is not a member of the
    // enum — stored anyway because findOneAndUpdate does not run validators by
    // default, so the row carried a value the schema forbids. Asserting the
    // enum still refuses it documents why the driver identity needs its own
    // field instead of overloading this one.
    const err = buildDoc({ type: 'native', runtimeType: 'native' }).validateSync();
    expect(err?.errors?.['manifest.runtime.type']).toBeDefined();
    // ...and the identity in the same document is unaffected by that refusal.
    expect(buildDoc({ type: 'native', runtimeType: 'native' }).toObject().manifest.runtime.runtimeType)
      .toBe('native');
  });

  it('defaults the deployment shape when the manifest declares only the driver', () => {
    // What buildRegistryManifest writes: identity only, shape left to the schema.
    const { runtime } = buildDoc({ runtimeType: 'native' }).toObject().manifest;
    expect(runtime.type).toBe('standalone');
  });
});

// The unit cases above prove the schema accepts and keeps the identity. This
// one proves it survives the path the seeder actually writes through — an
// upsert with `$set`, which casts against the schema exactly like a document
// does. Construction and update are separate code paths in Mongoose; the bug
// this task fixes was in the update path.
describe('the seeded manifest on a real row', () => {
  const mongoose = require('mongoose');
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const { buildRegistryManifest } = require('../../../scripts/seed-native-agents');

  let mongoServer;
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: '7.0.14', skipMD5: true },
      instance: { dbName: 't043-manifest-runtime-test' },
    });
    await mongoose.connect(mongoServer.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('keeps a declared driver identity on the row a findOneAndUpdate upsert writes', async () => {
    const manifest = buildRegistryManifest({
      agentName: 't043-seeded', displayName: 'T043', description: 'x',
    });
    await AgentRegistry.findOneAndUpdate(
      { agentName: 't043-seeded' },
      {
        $set: { displayName: 'T043', description: 'x', manifest, latestVersion: '1.0.0' },
        $setOnInsert: {
          stats: { installs: 0, weeklyInstalls: 0, rating: 0, ratingCount: 0 },
          versions: [],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const row = await AgentRegistry.findOne({ agentName: 't043-seeded' }).lean();
    expect(row.manifest.runtime.runtimeType).toBe('native');
  });
});
