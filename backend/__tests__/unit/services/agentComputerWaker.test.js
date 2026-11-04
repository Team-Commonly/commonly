const {
  wakeUser, tokenMatches, parseUsers, steelDeploymentName, createWakerServer,
} = require('../../../services/agentComputerWaker');

const USER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = 'waker-token-for-tests';
const AUTH = `Bearer ${TOKEN}`;
const BASE = `/apis/apps/v1/namespaces/commonly-dev/deployments/steel-${USER}`;

const kubeStub = ({
  replicas = 1, readyAfter = 0, scaleStatus = 200, patchStatus = 200,
} = {}) => {
  let reads = 0;
  const calls = [];
  const kube = jest.fn(async (method, path, body) => {
    calls.push([method, path, body]);
    if (path.endsWith('/scale')) {
      if (method === 'GET') return { status: scaleStatus, json: { spec: { replicas } } };
      return { status: patchStatus, json: { spec: { replicas: 1 } } };
    }
    reads += 1;
    return { status: 200, json: { status: { readyReplicas: reads > readyAfter ? 1 : 0 } } };
  });
  return { kube, calls };
};

const config = (kube, extra = {}) => ({
  token: TOKEN,
  namespace: 'commonly-dev',
  users: new Set([USER]),
  kube,
  readyTimeoutMs: 1000,
  sleep: async () => {},
  ...extra,
});

describe('agentComputerWaker', () => {
  test('answers once the running Steel Deployment is Ready, without scaling it', async () => {
    const { kube, calls } = kubeStub({ replicas: 1 });
    const result = await wakeUser('POST', `/v1/users/${USER}/wake`, AUTH, config(kube));
    expect(result).toEqual({ status: 200, body: { ready: true } });
    expect(calls.map(([method, path]) => [method, path])).toEqual([
      ['GET', `${BASE}/scale`],
      ['GET', BASE],
    ]);
  });

  test('scales a stopped Deployment to one replica and waits for Ready', async () => {
    const { kube, calls } = kubeStub({ replicas: 0, readyAfter: 2 });
    const result = await wakeUser('POST', `/v1/users/${USER}/wake`, AUTH, config(kube));
    expect(result.status).toBe(200);
    expect(calls).toContainEqual(['PATCH', `${BASE}/scale`, { spec: { replicas: 1 } }]);
    expect(calls.filter(([, path]) => path === BASE)).toHaveLength(3);
  });

  test('times out with 504 when the pod never becomes Ready', async () => {
    const { kube } = kubeStub({ readyAfter: Infinity });
    let now = 0;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const result = await wakeUser('POST', `/v1/users/${USER}/wake`, AUTH, config(kube, {
      sleep: async () => { now += 400; },
    }));
    spy.mockRestore();
    expect(result).toEqual({ status: 504, body: { error: 'not_ready' } });
  });

  test('refuses a malformed id before checking the token or touching the cluster', async () => {
    const { kube } = kubeStub();
    const bad = ['AAAAAAAAAAAAAAAAAAAAAAAA', 'aaaa', `${USER}0`, '..%2f..', 'steel-x'];
    const results = await Promise.all(bad.map((id) => wakeUser('POST', `/v1/users/${id}/wake`, 'Bearer wrong', config(kube))));
    expect(results.map(({ status }) => status)).toEqual(bad.map(() => 400));
    expect(kube).not.toHaveBeenCalled();
  });

  test('refuses a missing or wrong token with 401 and never calls the cluster', async () => {
    const { kube } = kubeStub();
    const headers = [undefined, '', TOKEN, 'Bearer wrong', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`];
    const results = await Promise.all(headers.map((header) => wakeUser('POST', `/v1/users/${USER}/wake`, header, config(kube))));
    expect(results.map(({ status }) => status)).toEqual(headers.map(() => 401));
    expect(kube).not.toHaveBeenCalled();
  });

  test('a valid id that is not on the user list gets no computer', async () => {
    const { kube } = kubeStub();
    const result = await wakeUser('POST', `/v1/users/${OTHER}/wake`, AUTH, config(kube));
    expect(result).toEqual({ status: 404, body: { error: 'no_computer' } });
    expect(kube).not.toHaveBeenCalled();
  });

  test('only POST to the wake path is served', async () => {
    const { kube } = kubeStub();
    expect((await wakeUser('GET', `/v1/users/${USER}/wake`, AUTH, config(kube))).status).toBe(405);
    expect((await wakeUser('POST', `/v1/users/${USER}/sleep`, AUTH, config(kube))).status).toBe(404);
    expect((await wakeUser('POST', '/', AUTH, config(kube))).status).toBe(404);
    expect(kube).not.toHaveBeenCalled();
  });

  test('a failed scale read or patch is a 502, not a wake', async () => {
    const wake = (stub) => wakeUser('POST', `/v1/users/${USER}/wake`, AUTH, config(stub.kube));
    expect(await wake(kubeStub({ scaleStatus: 403 }))).toEqual({ status: 502, body: { error: 'scale_read_failed' } });
    expect(await wake(kubeStub({ replicas: 0, patchStatus: 403 }))).toEqual({ status: 502, body: { error: 'scale_failed' } });
  });

  test('the HTTP server serves health and the wake contract the broker calls', async () => {
    const { kube } = kubeStub({ replicas: 0 });
    const server = createWakerServer(config(kube));
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const denied = await fetch(`${base}/v1/users/${USER}/wake`, { method: 'POST' });
      expect(denied.status).toBe(401);
      const woke = await fetch(`${base}/v1/users/${USER}/wake`, { method: 'POST', headers: { Authorization: AUTH } });
      expect(woke.status).toBe(200);
      expect(await woke.json()).toEqual({ ready: true });
      expect(woke.headers.get('cache-control')).toBe('no-store');
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  test('a cluster call that throws is a 502 from the server, never a crash', async () => {
    const server = createWakerServer(config(jest.fn(async () => { throw new Error('boom'); })));
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/users/${USER}/wake`, {
        method: 'POST', headers: { Authorization: AUTH },
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'wake_failed' });
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });

  test('helpers: token compare, user list and name', () => {
    expect(tokenMatches(AUTH, TOKEN)).toBe(true);
    expect(tokenMatches(AUTH, '')).toBe(false);
    expect([...parseUsers(` ${USER}, nope ,${OTHER},`)]).toEqual([USER, OTHER]);
    expect(steelDeploymentName(USER)).toBe(`steel-${USER}`);
    expect(() => steelDeploymentName('x')).toThrow();
  });
});
