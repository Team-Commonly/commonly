/**
 * Auth hot-path latency on one store, for the FerretDB CI leg
 * (.github/workflows/backend-ferretdb.yml, bench job). Not part of the suite:
 * jest.config.js ignores __tests__/bench/, and the bench job runs it on its own.
 *
 *   BENCH_URI=mongodb://localhost:27018 BENCH_LABEL=ferretdb \
 *     npx jest __tests__/bench --testPathIgnorePatterns=/node_modules/
 *
 * Seeds 5000 users and 2000 pods into a scratch database, then times the reads
 * and writes every signed-in request makes, and prints p50/p95/p99 in ms.
 */
const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { loadSessionAccount } = require('../../services/sessionAccountService');

const USERS = 5000;
const PODS = 2000;
const RUNS = 3000;
const WARM = 200;

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

jest.setTimeout(30 * 60 * 1000);

(process.env.BENCH_URI ? it : it.skip)('auth hot path', async () => {
  const db = `bench${Math.random().toString(16).slice(2, 10)}`;
  // autoIndex off, so Model.init() builds nothing in the background: it would
  // build main's collation index too, which collides with the unique one on
  // MongoDB and is refused by FerretDB, leaving the two stores on different
  // index sets. These are the indexes the timed reads use, built by hand, and
  // the set is printed with the numbers so the two runs compare like with like.
  await mongoose.connect(`${process.env.BENCH_URI}/${db}`, { autoIndex: false });
  await User.collection.createIndex({ username: 1 }, { unique: true });
  await User.collection.createIndex({ email: 1 }, { unique: true });
  await Pod.collection.createIndex({ members: 1 });
  const now = new Date();
  const users = Array.from({ length: USERS }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    username: `bench${i}`,
    email: `bench${i}@example.test`,
    password: 'x'.repeat(60),
    role: 'user',
    verified: true,
    createdAt: now,
    updatedAt: now,
  }));
  await User.collection.insertMany(users);
  await Pod.collection.insertMany(Array.from({ length: PODS }, (_, i) => ({
    _id: new mongoose.Types.ObjectId(),
    name: `pod${i}`,
    type: 'chat',
    createdBy: users[i % USERS]._id,
    members: Array.from({ length: 8 }, (__, k) => users[(i * 7 + k * 613) % USERS]._id),
    createdAt: now,
    updatedAt: now,
  })));

  const pick = (i) => users[(i * 7919) % USERS]._id;
  const time = async (label, fn) => {
    for (let i = 0; i < WARM; i += 1) await fn(i); // eslint-disable-line no-await-in-loop
    const samples = [];
    for (let i = 0; i < RUNS; i += 1) {
      const start = process.hrtime.bigint();
      await fn(i); // eslint-disable-line no-await-in-loop
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const ms = (p) => Number(percentile(samples, p).toFixed(2));
    return {
      label, p50: ms(50), p95: ms(95), p99: ms(99),
    };
  };

  const rows = [
    await time('session account read (auth middleware)', (i) => loadSessionAccount(String(pick(i)))),
    await time('lastActive write (auth middleware)', (i) => User.updateOne({ _id: pick(i) }, { lastActive: new Date() })),
    await time('pods for a member (pod list)', (i) => Pod.find({ members: pick(i) }).select('name type createdBy').lean()),
    await time('user by username (login)', (i) => User.findOne({ username: `bench${(i * 31) % USERS}` }).lean()),
  ];

  const indexes = {
    users: (await User.collection.indexes()).map((ix) => ix.name).sort(),
    pods: (await Pod.collection.indexes()).map((ix) => ix.name).sort(),
  };
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  const label = process.env.BENCH_LABEL || 'store';
  process.stderr.write(`BENCH-INDEXES ${label} ${JSON.stringify(indexes)}\n`);
  // At this size every row is in cache, so these measure the round trip, not a cold read.
  const table = [`### Auth hot path on ${label} (ms, ${RUNS} runs, ${USERS} users, all in cache)`, '', '| | p50 | p95 | p99 |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.label} | ${r.p50} | ${r.p95} | ${r.p99} |`), ''].join('\n');
  // stderr, not console: __tests__/setup.js silences console in every worker.
  process.stderr.write(`BENCH ${label} ${JSON.stringify(rows)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
  expect(rows).toHaveLength(4);
});
