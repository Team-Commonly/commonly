// F616: a pod's vector index runs one rebuild at a time. A reset that lands
// in the middle of a running rebuild wipes half of it, and each rebuild spends
// embedding calls. The guard is in-process (the backend runs one replica).
const express = require('express');
const request = require('supertest');

const USER = '6a0000000000000000000001';
const OTHER = '6a0000000000000000000002';
const POD_A = '6a00000000000000000000a1';
const POD_B = '6a00000000000000000000b2';

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  const id = req.headers['x-user'] || '6a0000000000000000000001';
  req.user = { id, _id: id };
  req.userId = id;
  next();
});
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({}));
jest.mock('../../../models/User', () => ({}));
jest.mock('../../../services/contextAssemblerService', () => ({}));
jest.mock('../../../services/vectorSearchService', () => ({
  resetIndex: jest.fn(),
  rebuildIndex: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const VectorSearchService = require('../../../services/vectorSearchService');

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
// The next rebuildIndex call blocks until `release()`; `entered.promise` settles
// once that call is actually inside the mock.
const holdNextRebuild = () => {
  const entered = deferred();
  const hold = deferred();
  VectorSearchService.rebuildIndex.mockImplementationOnce(() => { entered.resolve(); return hold.promise; });
  return { entered, release: () => hold.resolve({ indexed: 1, errors: 0, total: 1 }) };
};
const counts = () => [
  VectorSearchService.resetIndex.mock.calls.length,
  VectorSearchService.rebuildIndex.mock.calls.length,
];

const app = express();
app.use(express.json());
const router = require('../../../routes/contextApi');
app.use('/api/v1', router.default || router);

const podDoc = (id, createdBy = USER) => ({ _id: id, createdBy, members: [createdBy] });
const lean = (v) => ({ lean: () => Promise.resolve(v) });
const single = (podId, user) => {
  const r = request(app).post(`/api/v1/pods/${podId}/index/rebuild`).send({ reset: true });
  return user ? r.set('x-user', user) : r;
};
const all = () => request(app).post('/api/v1/index/rebuild-all').send({ reset: true });
const IN_PROGRESS = { code: 'index_rebuild_in_progress' };

beforeEach(() => {
  jest.resetAllMocks();
  const pods = { [POD_A]: podDoc(POD_A), [POD_B]: podDoc(POD_B) };
  Pod.findById.mockImplementation((id) => lean(pods[id] || null));
  Pod.find.mockImplementation(() => lean([pods[POD_A], pods[POD_B]]));
  VectorSearchService.resetIndex.mockResolvedValue(undefined);
  VectorSearchService.rebuildIndex.mockResolvedValue({ indexed: 1, errors: 0, total: 1 });
});

describe('index rebuild guard (F616)', () => {
  it('a second rebuild of a pod already rebuilding gets 409', async () => {
    const h = holdNextRebuild();
    const first = single(POD_A).then((r) => r);
    await h.entered.promise;
    const before = counts();
    const second = await single(POD_A);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ ...IN_PROGRESS, error: 'An index rebuild is already running for this pod.' });
    expect(counts()).toEqual(before);
    expect(before).toEqual([1, 1]);
    h.release();
    expect((await first).status).toBe(200);
  });

  it('a second rebuild-all from the same user gets 409', async () => {
    const h = holdNextRebuild();
    const first = all().then((r) => r);
    await h.entered.promise;
    const before = counts();
    const second = await all();
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject(IN_PROGRESS);
    expect(counts()).toEqual(before);
    h.release();
    expect((await first).status).toBe(200);
  });

  it('rebuild-all skips a pod whose single rebuild is running and counts it', async () => {
    const h = holdNextRebuild();
    const first = single(POD_A).then((r) => r);
    await h.entered.promise;
    const res = await all();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pods: 2, skipped: 1, indexed: 1, errors: 0, total: 1, reset: true });
    expect(VectorSearchService.rebuildIndex).toHaveBeenCalledTimes(2);
    expect(VectorSearchService.rebuildIndex).toHaveBeenLastCalledWith(POD_B);
    h.release();
    expect((await first).status).toBe(200);
  });

  it('a single rebuild of a pod the same user\'s rebuild-all holds gets 409', async () => {
    const h = holdNextRebuild();
    const first = all().then((r) => r);
    await h.entered.promise;
    const before = counts();
    const res = await single(POD_A);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject(IN_PROGRESS);
    expect(counts()).toEqual(before);
    h.release();
    expect((await first).status).toBe(200);
  });

  it('releases the guard after a finish and after a throw', async () => {
    expect((await single(POD_A)).status).toBe(200);
    expect((await single(POD_A)).status).toBe(200);
    VectorSearchService.rebuildIndex.mockRejectedValueOnce(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await single(POD_A)).status).toBe(500);
    expect((await single(POD_A)).status).toBe(200);
    VectorSearchService.resetIndex.mockRejectedValueOnce(new Error('boom'));
    expect((await all()).status).toBe(500);
    expect((await all()).status).toBe(200);
    expect((await single(POD_B)).status).toBe(200);
  });

  it('a non-creator gets 403, not 409, while the pod is locked', async () => {
    Pod.findById.mockImplementation((id) => lean({ _id: id, createdBy: USER, members: [USER, OTHER] }));
    const h = holdNextRebuild();
    const first = single(POD_A).then((r) => r);
    await h.entered.promise;
    const before = counts();
    expect((await single(POD_A, OTHER)).status).toBe(403);
    expect(counts()).toEqual(before);
    h.release();
    expect((await first).status).toBe(200);
  });

  it('rebuilds of two different pods run at the same time', async () => {
    const entered = { [POD_A]: deferred(), [POD_B]: deferred() };
    const hold = deferred();
    VectorSearchService.rebuildIndex.mockImplementation((id) => {
      entered[id].resolve();
      return hold.promise;
    });
    const a = single(POD_A).then((r) => r);
    const b = single(POD_B).then((r) => r);
    // Both are inside the mock before either is released.
    await Promise.all([entered[POD_A].promise, entered[POD_B].promise]);
    expect(VectorSearchService.rebuildIndex).toHaveBeenCalledTimes(2);
    hold.resolve({ indexed: 0, errors: 0, total: 0 });
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });
});
