// Two-worker limiter checks against the real backend image (run.sh). Uses the
// login limiter: 20 attempts per 15 minutes per end-user address, counted in
// SharedRateLimitStore and keyed on CF-Connecting-IP first.
//
//   shared   one address, alternating backend and backend-2 directly: the
//            21st attempt is refused, so both processes count in one window
//            (per-process counting would allow 40)
//   via-lb   through api-lb: one address is refused after 20, and a second
//            address is still allowed, so the limiter keys on the end user,
//            not on the proxy in between
import crypto from 'node:crypto';

const LIMIT = 20;
const attempt = async (base, ip) => {
  const email = `nobody-${crypto.randomBytes(6).toString('hex')}@loadtest.invalid`;
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password: 'not-the-password' }),
  });
  await res.text();
  return res.status;
};
const fail = (message) => { console.log(`FAIL: ${message}`); process.exit(1); };
const freshIp = () => `198.18.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;

const mode = process.argv[2];
if (mode === 'shared') {
  const ip = freshIp();
  const statuses = [];
  for (let i = 0; i < LIMIT + 4; i += 1) {
    statuses.push(await attempt(i % 2 ? 'http://backend-2:5000' : 'http://backend:5000', ip));
  }
  const first429 = statuses.indexOf(429);
  if (first429 !== LIMIT) fail(`expected the first refusal at attempt ${LIMIT + 1}, got ${first429 + 1}: ${statuses.join(',')}`);
  console.log(`ok: one address alternating backend and backend-2 was refused at attempt ${LIMIT + 1} (one shared window, not two)`);
} else if (mode === 'via-lb') {
  const lb = 'http://api-lb:5000';
  const first = freshIp();
  const statuses = [];
  for (let i = 0; i < LIMIT + 2; i += 1) statuses.push(await attempt(lb, first));
  if (statuses.indexOf(429) !== LIMIT) fail(`through api-lb, expected the first refusal at ${LIMIT + 1}: ${statuses.join(',')}`);
  const second = await attempt(lb, freshIp());
  if (second === 429) fail('a second end-user address was refused: the limiter keyed on the proxy, not the user');
  console.log(`ok: through api-lb one address was refused at attempt ${LIMIT + 1}, and another address still got ${second}`);
} else {
  fail(`unknown mode ${mode}`);
}
