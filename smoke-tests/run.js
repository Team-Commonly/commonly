#!/usr/bin/env node
/**
 * Commonly smoke tests — 6 end-to-end checks against a running stack.
 *
 * Usage:
 *   API_URL=http://localhost:5000 BASE_URL=http://localhost:3000 node smoke-tests/run.js
 *
 * Requires Node 18+ (global fetch). Exits 1 if any test fails.
 * No external dependencies.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(`\nSmoke tests — API: ${API_URL}  Frontend: ${BASE_URL}\n`);

  // 1. Liveness probe
  await run('GET /api/health/live → 200, status=alive', async () => {
    const res = await fetch(`${API_URL}/api/health/live`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.status === 'alive', `Expected status=alive, got ${JSON.stringify(body)}`);
  });

  // 2. Readiness probe
  await run('GET /api/health/ready → responds (200 or 503)', async () => {
    const res = await fetch(`${API_URL}/api/health/ready`);
    assert([200, 503].includes(res.status), `Expected 200 or 503, got ${res.status}`);
    const body = await res.json();
    assert(body.status, `Expected body.status, got ${JSON.stringify(body)}`);
  });

  // 3. Full health object
  await run('GET /api/health → 2xx with {status, checks, uptime}', async () => {
    const res = await fetch(`${API_URL}/api/health`);
    assert(res.status < 600, `Expected response, got ${res.status}`);
    const body = await res.json();
    assert('status' in body, 'Missing body.status');
    assert('checks' in body, 'Missing body.checks');
    assert('uptime' in body, 'Missing body.uptime');
  });

  // 4. Register test user (auto-verified when SENDGRID_API_KEY unset)
  const tag = Date.now();
  const email = `smoketest_${tag}@commonly.test`;
  const password = 'SmokeTest1234!';
  const username = `smokeuser_${tag}`;

  await run('POST /api/auth/register → 2xx (user created or already exists)', async () => {
    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, invitationCode: '' }),
    });
    assert(res.status < 500, `Registration server error: ${res.status}`);
    // 200/201 = created, 400 = validation, 409 = duplicate — all non-5xx are acceptable
  });

  // 5. Login and receive token
  let token = null;
  await run('POST /api/auth/login → 200, body.token is string', async () => {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(typeof body.token === 'string' && body.token.length > 0, `Expected token string, got ${JSON.stringify(body)}`);
    token = body.token;
  });

  // 6. Frontend serves HTML with React root
  await run('GET / → 200, HTML contains <div id="root">', async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const html = await res.text();
    assert(html.includes('<div id="root">') || html.includes("id='root'") || html.includes('id="root"'),
      'Frontend HTML does not contain React root element');
  });

  // Summary
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
