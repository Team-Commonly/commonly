/**
 * The agent computer waker (D244 pilot 2). The broker calls
 * `POST /v1/users/{userId}/wake` with `Authorization: Bearer <token>` before it
 * opens a person's Steel browser (agentComputerBroker.ts `wakeSteel`). This
 * service makes sure that person's `steel-{userId}` Deployment has a replica
 * and answers only once it is Ready.
 *
 * It runs under its own service account, whose Role names only the
 * `steel-{userId}` Deployments the chart rendered (templates/agent-computer/),
 * so the wake path needs nothing from the backend's account. The Deployment
 * name is built here from a validated id that must also be on the configured
 * user list; nothing the caller sends reaches the Kubernetes API as a name.
 *
 * Runs from the backend image: `node dist/services/agentComputerWaker.js`.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

const USER_ID = /^[a-f\d]{24}$/;
const WAKE_PATH = /^\/v1\/users\/([^/]+)\/wake$/;
// The broker gives up on the wake after 20 s (SESSION_TIMEOUT_MS). The budget
// starts when the request is accepted, and a cluster call can take 5 s more
// than it, so 14 s keeps the answer inside the broker's window.
const DEFAULT_READY_TIMEOUT_MS = 14_000;
const POLL_MS = 500;
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export type KubeCall = (
  method: 'GET' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
) => Promise<{ status: number; json: any }>;

export type WakerConfig = {
  token: string;
  namespace: string;
  users: ReadonlySet<string>;
  kube: KubeCall;
  readyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type WakeResult = { status: number; body: Record<string, unknown> };

export const parseUsers = (raw: string | undefined): Set<string> => new Set(
  String(raw || '').split(',').map((id) => id.trim()).filter((id) => USER_ID.test(id)),
);

export const tokenMatches = (header: string | undefined, token: string): boolean => {
  if (!token) return false;
  const match = /^Bearer (.+)$/.exec(String(header || ''));
  if (!match) return false;
  // Compare digests, so neither the content nor the length of the token leaks.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
};

export const steelDeploymentName = (userId: string): string => {
  if (!USER_ID.test(userId)) throw new Error('invalid user id');
  return `steel-${userId}`;
};

const sleepFor = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export const wakeUser = async (
  method: string | undefined,
  url: string | undefined,
  authorization: string | undefined,
  config: WakerConfig,
): Promise<WakeResult> => {
  const path = new URL(String(url || '/'), 'http://waker').pathname;
  const match = WAKE_PATH.exec(path);
  if (!match) return { status: 404, body: { error: 'not_found' } };
  if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const userId = match[1];
  // Validate before anything else touches the id, the token check included.
  if (!USER_ID.test(userId)) return { status: 400, body: { error: 'invalid_user' } };
  if (!tokenMatches(authorization, config.token)) return { status: 401, body: { error: 'unauthorized' } };
  if (!config.users.has(userId)) return { status: 404, body: { error: 'no_computer' } };
  const deadline = Date.now() + (config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

  const name = steelDeploymentName(userId);
  const base = `/apis/apps/v1/namespaces/${encodeURIComponent(config.namespace)}/deployments/${name}`;
  const scale = await config.kube('GET', `${base}/scale`);
  if (scale.status !== 200) return { status: 502, body: { error: 'scale_read_failed' } };
  if (!(Number(scale.json?.spec?.replicas) >= 1)) {
    const patched = await config.kube('PATCH', `${base}/scale`, { spec: { replicas: 1 } });
    if (patched.status !== 200) return { status: 502, body: { error: 'scale_failed' } };
  }

  const sleep = config.sleep || sleepFor;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const deployment = await config.kube('GET', base);
    if (deployment.status === 200 && Number(deployment.json?.status?.readyReplicas) >= 1) {
      return { status: 200, body: { ready: true } };
    }
    if (Date.now() >= deadline) return { status: 504, body: { error: 'not_ready' } };
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_MS);
  }
};

/** Calls the API server with the pod's own service account. */
export const inClusterKube = (): KubeCall => {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || '443';
  if (!host) throw new Error('not running in a cluster');
  const ca = fs.readFileSync(`${SA_DIR}/ca.crt`);
  return (method, path, body) => new Promise((resolve, reject) => {
    // Read per call: the kubelet rotates projected tokens.
    const saToken = fs.readFileSync(`${SA_DIR}/token`, 'utf8').trim();
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      host,
      port,
      path,
      method,
      ca,
      headers: {
        Authorization: `Bearer ${saToken}`,
        Accept: 'application/json',
        ...(payload ? {
          'Content-Type': 'application/merge-patch+json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
      timeout: 5_000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('kube request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
};

export const createWakerServer = (config: WakerConfig): http.Server => http.createServer((req, res) => {
  const send = ({ status, body }: WakeResult) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/healthz') {
    send({ status: 200, body: { ok: true } });
    return;
  }
  wakeUser(req.method, req.url, req.headers.authorization, config)
    .then(send)
    .catch(() => send({ status: 502, body: { error: 'wake_failed' } }));
});

if (require.main === module) {
  const token = String(process.env.AGENT_COMPUTER_WAKER_TOKEN || '');
  const namespace = String(process.env.WAKER_NAMESPACE || '');
  if (!token || !namespace) {
    console.error('[agent-computer-waker] AGENT_COMPUTER_WAKER_TOKEN and WAKER_NAMESPACE are required');
    process.exit(1);
  }
  const users = parseUsers(process.env.AGENT_COMPUTER_WAKER_USERS);
  const port = Number(process.env.PORT || 8080);
  createWakerServer({ token, namespace, users, kube: inClusterKube() }).listen(port, () => {
    console.log(`[agent-computer-waker] listening on ${port} for ${users.size} user(s)`);
  });
}
