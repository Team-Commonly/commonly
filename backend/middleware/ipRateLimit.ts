import type { Request } from 'express';
import { createHash } from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import { loginEmailOf } from '../utils/loginEmail';

const firstHeaderValue = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

/**
 * The rate-limit key for internet traffic.
 *
 * WHY THE HEADER AND NOT `req.ip`. nginx REPLACES X-Forwarded-For with its own
 * peer (`proxy_set_header X-Forwarded-For $remote_addr`) and parks the incoming
 * chain on X-Original-Forwarded-For, while `trust proxy` (server.ts:97) trusts
 * every in-cluster hop. So `req.ip` walks to the leftmost entry it was given,
 * which is a cloudflared pod address — one of two — for EVERY external caller:
 * keying the whole internet on two buckets. `cf-connecting-ip` is the client
 * address the Cloudflare edge records, and nginx passes it through untouched.
 *
 * TWO ASSUMPTIONS THIS RESTS ON. Neither is assertable in CI, because both are
 * properties of infrastructure this repo does not own. Re-check them — and
 * re-run the probe beside each — the day a second entrance appears.
 *   1. The tunnel is the sole entrance to nginx. Probe (read-only, 2026-09-23):
 *      `kubectl get svc -n ingress-nginx <controller>` → ClusterIP, no
 *      external IP, no nodePort; a cluster-wide sweep found no other way in.
 *   2. The edge rejects a client-supplied header rather than forwarding it.
 *      Probe: six requests carrying a forged `cf-connecting-ip` (two
 *      documentation addresses, HTTP/1.1 and HTTP/2, both letter cases) → 403
 *      `error code: 1000` from `server: cloudflare`, with the control bucket
 *      moving exactly one per header-free request, so none reached the origin.
 *
 * WHEN NEITHER HOLDS — a public controller with no tunnel — the header is
 * client-controlled, and the asymmetry is the point: honest callers send no
 * `cf-connecting-ip` at all, so they share the `req.ip` buckets, while a caller
 * who sends it leaves the shared bucket and can exhaust it for everyone else
 * without ever limiting itself. How far the shared side collapses is left
 * unstated on purpose — it depends on the LoadBalancer's `externalTrafficPolicy`,
 * which nobody has measured. The operator opt-out that fixes that deployment is
 * TASK-120 (default = trust the header, so a missed setting degrades to weaker
 * limiting for the attacker, never to a one-caller lockout).
 *
 * INTERNET-FACING ONLY — this is not a boundary. Every pod can reach
 * `backend.<ns>.svc.cluster.local:5000` (the tree carries no NetworkPolicy), so
 * an in-cluster caller can send the header itself and choose a bucket, or omit
 * it and share the `req.ip` one. Out of threat model by ruling — such a caller
 * already holds a runtime token and the network reach we deployed to it — and
 * tracked as TASK-119 rather than left silent.
 */
export const cloudflareIpRateLimitKeyGenerator = (req: Request): string => {
  const cfConnectingIp = firstHeaderValue(req.headers?.['cf-connecting-ip']);
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim().length > 0) {
    return ipKeyGenerator(cfConnectingIp.trim());
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

// Pre-auth traffic bound per presented secret, not per proxy or forwarding
// header. Anonymous requests share only the anonymous bucket, never a signed-in
// user's. Rotating invalid secrets can evade this coarse bound; the post-auth
// user quota is the durable account limit. Never retain plaintext credentials.
export const presentedCredentialRateLimitKeyGenerator = (req: Request): string => {
  const token = req.header('Authorization')?.replace('Bearer ', '') || req.header('x-auth-token');
  return token ? `credential:${createHash('sha256').update(token).digest('hex')}` : 'no-credential';
};

export const authenticatedUserRateLimitKeyGenerator = (req: Request & { userId?: unknown }): string => (
  req.userId ? `user:${String(req.userId)}` : 'unresolved-user'
);

// Failed sign-ins bound per submitted address, whatever IP sends them. The
// address comes from the helper login itself uses, so the limiter and login
// cannot disagree about which account a request is for. A body with no string
// email is skipped at the route, never bucketed here.
export const loginEmailRateLimitKeyGenerator = (req: Request): string => (
  `login-account:${loginEmailOf(req.body)}`
);

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  cloudflareIpRateLimitKeyGenerator,
  presentedCredentialRateLimitKeyGenerator,
  authenticatedUserRateLimitKeyGenerator,
  loginEmailRateLimitKeyGenerator,
};
