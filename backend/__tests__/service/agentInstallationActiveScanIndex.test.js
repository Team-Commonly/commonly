process.env.PG_HOST = '';

const mongoose = require('mongoose');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// TASK-175's seam (services/seatGrantConfinement.ts) decides whether a calling
// seat may spend a grant by reading every ACTIVE installation and matching the
// seat's identity key in JS. It cannot filter in the query: seatEnvironmentKey
// normalises BOTH parts, because the schema lowercases `agentName` but NOT
// `instanceId`, so an identity filter would be a narrower — fail-open — read.
// What remains is an identity-free read of the whole active set, on the broker
// hot path (`callTool` and `tools/list`). This test is the instrument for the
// index that keeps that read off a collection scan, and it asserts the PLAN
// against a real mongod, because the declaration alone proves nothing about
// which access path the planner takes.
const SEAM_PROJECTION = { agentName: 1, instanceId: 1, installedBy: 1 };
const ACTIVE = 288;
const TOTAL = 502;

// The live shape, so the plan under test is the plan the instance gets: a seat
// per row, an opaque config map on each (the payload a collection scan drags
// through the fetch), and the non-active majority that the read must not touch.
const seed = async () => {
  const owners = Array.from({ length: 40 }, () => new mongoose.Types.ObjectId());
  const docs = [];
  for (let i = 0; i < TOTAL; i += 1) {
    docs.push({
      agentName: 'openclaw',
      instanceId: `seat${i}`,
      podId: new mongoose.Types.ObjectId(),
      installedBy: owners[i % owners.length],
      version: '1.0.0',
      status: i < ACTIVE ? 'active' : 'uninstalled',
      config: {
        environment: { mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }] },
        padding: 'x'.repeat(400),
      },
    });
  }
  await AgentInstallation.insertMany(docs);
};

const stagesOf = (plan) => {
  const stages = [];
  let node = plan;
  while (node) {
    stages.push(node.stage);
    node = node.inputStage || (node.inputStages && node.inputStages[0]) || null;
  }
  return stages;
};

const explain = async (filter) => {
  const raw = await AgentInstallation.collection
    .find(filter, { projection: SEAM_PROJECTION })
    .explain('executionStats');
  return { stages: stagesOf(raw.queryPlanner.winningPlan), ...raw.executionStats };
};

describe('AgentInstallation — the active-set read on the grant-broker path', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  test('the declared index serves the seam\'s read as a covered index scan', async () => {
    await seed();
    await AgentInstallation.createIndexes();

    const plan = await explain({ status: 'active' });

    expect(plan.stages).toContain('IXSCAN');
    expect(plan.stages).not.toContain('COLLSCAN');
    // Covered: no document is fetched, so the opaque `config` map never moves.
    expect(plan.totalDocsExamined).toBe(0);
    // Exactly the active rows are read — the other 214 are not even keyscanned.
    expect(plan.totalKeysExamined).toBe(ACTIVE);
    expect(plan.nReturned).toBe(ACTIVE);
  });

  test('positive control: the same instrument sees a collection scan', async () => {
    // A filter no key of this index can serve, so `not.toContain('COLLSCAN')`
    // above cannot pass because the plan walker is broken. (Measured: a filter
    // on a NON-LEADING key is not such a filter — `{ agentName }` is served by
    // this same index as `IXSCAN`, which is the second reason to spend a query
    // on the control rather than reason about it.)
    const plan = await explain({ displayName: 'no-such-seat' });

    expect(plan.stages).toContain('COLLSCAN');
    expect(plan.totalDocsExamined).toBe(TOTAL);
    expect(plan.nReturned).toBe(0);
  });

  test('the index is declared in the schema, in the key order the plan needs', () => {
    const declared = AgentInstallation.schema.indexes().map(([keys]) => keys);

    expect(declared).toContainEqual({
      status: 1, agentName: 1, instanceId: 1, installedBy: 1, _id: 1,
    });
  });
});
