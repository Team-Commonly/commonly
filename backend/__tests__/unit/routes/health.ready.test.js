const request = require('supertest');
const express = require('express');

const mockMongoose = {
  connection: {
    readyState: 1,
  },
};
// The probe checks out its own client so it can destroy one that stalls.
// `query` stands for that client's query; each checkout gets a fresh release.
const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
  releases: [],
  connect: jest.fn(async () => {
    const release = jest.fn();
    mockPool.releases.push(release);
    return { query: (q) => mockPool.query(q), release };
  }),
};
const mockCreateClient = jest.fn();
const mockIsDraining = jest.fn().mockReturnValue(false);
jest.mock('../../../services/agentEventService', () => ({ isInProcessDraining: () => mockIsDraining() }));

jest.mock('mongoose', () => mockMongoose);
jest.mock('redis', () => ({ createClient: mockCreateClient }));
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

// TASK-168: readiness asserts the PG mount from the route table. Default is
// mounted here so the three cases below stay about Mongo and the live probe;
// the mount gate has its own cases.
const mockPgRoutesAreMounted = jest.fn().mockReturnValue(true);
jest.mock('../../../services/pgBootService', () => ({
  pgRoutesAreMounted: (...args) => mockPgRoutesAreMounted(...args),
}));

const originalPgHost = process.env.PG_HOST;
const originalK8sMode = process.env.AGENT_PROVISIONER_K8S;
process.env.PG_HOST = process.env.PG_HOST || 'localhost-test';
process.env.AGENT_PROVISIONER_K8S = '1';

// The backend source is TypeScript, while this legacy ESLint resolver only
// discovers JavaScript module extensions.
// eslint-disable-next-line import/no-unresolved, import/extensions
const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
};

describe('GET /api/health/ready', () => {
  beforeEach(() => {
    mockIsDraining.mockReturnValue(false);
    mockMongoose.connection.readyState = 1;
    mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
    mockPool.releases = [];
    mockPgRoutesAreMounted.mockReturnValue(true);
  });

  afterAll(() => {
    if (originalPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = originalPgHost;

    if (originalK8sMode === undefined) delete process.env.AGENT_PROVISIONER_K8S;
    else process.env.AGENT_PROVISIONER_K8S = originalK8sMode;
  });

  it('refuses readiness while hosted turns drain', async () => {
    mockIsDraining.mockReturnValue(true);
    const res = await request(buildApp()).get('/api/health/ready').expect(503);
    expect(res.body.reason).toBe('hosted runtime draining');
  });

  it('returns ready when MongoDB and PostgreSQL are available without probing Redis', async () => {
    const res = await request(buildApp()).get('/api/health/ready').expect(200);

    expect(res.body.status).toBe('ready');
    expect(res.body.degraded).toBeUndefined();
    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('returns not ready while MongoDB is disconnected', async () => {
    mockMongoose.connection.readyState = 0;

    const res = await request(buildApp()).get('/api/health/ready').expect(503);

    expect(res.body).toEqual({ status: 'not_ready', reason: 'MongoDB not connected' });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('stays ready with PostgreSQL marked degraded when the query fails', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp()).get('/api/health/ready').expect(200);

    expect(res.body).toEqual(expect.objectContaining({
      status: 'ready',
      degraded: ['postgresql'],
    }));
    expect(console.warn).toHaveBeenCalledWith(
      'health: PostgreSQL readiness check failed; continuing in Mongo fallback mode:',
      'connection refused',
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('answers degraded-ready before the probe timeout when PostgreSQL does not answer', async () => {
    // 11-02/11-03 readiness flaps: under a burst of agent long-polls the probe's
    // SELECT 1 waited on the pool past the probe's 3s timeout, and the kubelet
    // logged "context deadline exceeded" with no warning from this handler.
    // A slow answer is treated like a failed one: ready, degraded, and said.
    let settle;
    mockPool.query.mockReturnValue(new Promise((resolve) => { settle = resolve; }));

    const started = Date.now();
    const res = await request(buildApp()).get('/api/health/ready').timeout(2500).expect(200);

    expect(Date.now() - started).toBeLessThan(2500);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'ready',
      degraded: ['postgresql'],
    }));
    expect(console.warn).toHaveBeenCalledWith(
      'health: PostgreSQL readiness check failed; continuing in Mongo fallback mode:',
      expect.stringMatching(/did not answer within \d+ms/),
    );
    // The handler keeps one probe in flight per pod; let it settle so the
    // next case starts a fresh one.
    settle({ rows: [{ ok: 1 }] });
    await new Promise((resolve) => { setImmediate(resolve); });
  });

  it('keeps one PostgreSQL probe in flight while it is still pending', async () => {
    // The losing SELECT 1 is not cancelled, so a probe every 5s against a
    // stalled database would otherwise add one waiting query per probe.
    let settle;
    mockPool.query.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const app = buildApp();

    await request(app).get('/api/health/ready').timeout(2500).expect(200);
    await request(app).get('/api/health/ready').timeout(2500).expect(200);
    expect(mockPool.query).toHaveBeenCalledTimes(1);

    // Once it settles, the next probe asks again.
    settle({ rows: [{ ok: 1 }] });
    await new Promise((resolve) => { setImmediate(resolve); });
    mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
    const res = await request(app).get('/api/health/ready').expect(200);
    expect(res.body.degraded).toBeUndefined();
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('destroys a stalled probe client at its deadline, so the next probe asks afresh', async () => {
    // Reuse alone would let one query that never settles keep every later
    // probe degraded and hold its client for good.
    const saved = process.env.READY_PG_PROBE_DEADLINE_MS;
    process.env.READY_PG_PROBE_DEADLINE_MS = '200';
    try {
      mockPool.query.mockReturnValueOnce(new Promise(() => {}));
      const app = buildApp();
      await request(app).get('/api/health/ready').timeout(2500).expect(200);
      await new Promise((resolve) => { setTimeout(resolve, 250); });

      expect(mockPool.releases[0]).toHaveBeenCalledWith(expect.any(Error));
      const res = await request(app).get('/api/health/ready').timeout(2500).expect(200);
      expect(res.body.degraded).toBeUndefined();
      expect(mockPool.connect).toHaveBeenCalledTimes(2);
      expect(mockPool.releases[1]).toHaveBeenCalledWith(undefined);
    } finally {
      if (saved === undefined) delete process.env.READY_PG_PROBE_DEADLINE_MS;
      else process.env.READY_PG_PROBE_DEADLINE_MS = saved;
    }
  });

  it.each(['-1', '0', 'soon'])('ignores an unusable probe deadline (%s) and stays healthy', async (value) => {
    const saved = process.env.READY_PG_PROBE_DEADLINE_MS;
    process.env.READY_PG_PROBE_DEADLINE_MS = value;
    try {
      mockPool.query.mockReturnValueOnce(new Promise((resolve) => { setTimeout(() => resolve({ rows: [] }), 20); }));
      const res = await request(buildApp()).get('/api/health/ready').timeout(2500).expect(200);
      expect(res.body.degraded).toBeUndefined();
      expect(mockPool.releases[0]).toHaveBeenCalledWith(undefined);
    } finally {
      if (saved === undefined) delete process.env.READY_PG_PROBE_DEADLINE_MS;
      else process.env.READY_PG_PROBE_DEADLINE_MS = saved;
    }
  });

  it('returns not ready while the PostgreSQL routes are not mounted (TASK-168)', async () => {
    // The 2026-09-25 production defect: the boot connect timed out, the PG
    // routes were never mounted, chat history 404'd — and this handler answered
    // 200 because it only asked whether a live PG query worked, which the
    // lazily-created pool said yes to the moment the transient passed.
    mockPgRoutesAreMounted.mockReturnValue(false);

    const res = await request(buildApp()).get('/api/health/ready').expect(503);

    expect(res.body).toEqual(expect.objectContaining({
      status: 'not_ready',
      reason: 'PostgreSQL routes are not mounted on this pod',
    }));
    // The mount is the whole answer, and it is taken before any live probe:
    // asking PG how it is feeling is what made this miss the outage.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('goes ready once the mount lands, with no restart (TASK-168)', async () => {
    // The retry mounts the routes in-place, so the same pod must flip ready
    // without being restarted — the half that made the incident need a human.
    mockPgRoutesAreMounted.mockReturnValue(false);
    await request(buildApp()).get('/api/health/ready').expect(503);

    mockPgRoutesAreMounted.mockReturnValue(true);
    const res = await request(buildApp()).get('/api/health/ready').expect(200);

    expect(res.body.status).toBe('ready');
    expect(mockPgRoutesAreMounted).toHaveBeenCalledTimes(2);
  });

  it('ignores the mount gate when PostgreSQL is not configured', async () => {
    // PG_HOST unset is a supported configuration, not a degraded pod: there is
    // no PG contract to have failed, so the gate must not apply.
    const saved = process.env.PG_HOST;
    delete process.env.PG_HOST;
    mockPgRoutesAreMounted.mockReturnValue(false);
    try {
      const res = await request(buildApp()).get('/api/health/ready').expect(200);
      expect(res.body.status).toBe('ready');
    } finally {
      process.env.PG_HOST = saved;
    }
  });
});
