// CI-only HTTP smoke against the unchanged backend and disposable services.
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:5000';
let token;
async function api(name, method, path, body, bearer = token, expected = [200, 201]) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await r.json();
  assert.ok(expected.includes(r.status), `${name}: HTTP ${r.status}: ${JSON.stringify(data)}`);
  console.log(`PASS ${name}: HTTP ${r.status}`);
  return data;
}
(async () => {
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(ready, 'backend readiness timed out; inspect backend.log');
  const email = `ferret-${Date.now()}@example.invalid`;
  const password = 'CiOnly-Bridge-Password42!';
  await api('sign up', 'POST', '/api/auth/register', { username: `ferret-${Date.now()}`, email, password });
  const login = await api('login', 'POST', '/api/auth/login', { email, password });
  token = login.token;
  assert.ok(token, 'login returned no token');
  const created = await api('create pod', 'POST', '/api/pods', { name: 'FerretDB CI smoke', type: 'chat' });
  const pod = (created.pod || created)._id;
  assert.ok(pod, 'create pod returned no id');
  await api('pod chat message', 'POST', `/api/messages/${pod}`, { content: 'human smoke message' });
  await api('install BYO agent', 'POST', '/api/registry/install', { agentName: 'ferret-ci', podId: pod, config: { runtime: { runtimeType: 'webhook', host: 'byo' } }, scopes: ['context:read', 'messages:write'] });
  const minted = await api('mint runtime token', 'POST', `/api/registry/pods/${pod}/agents/ferret-ci/runtime-tokens`, { label: 'CI only' });
  assert.ok(minted.token, 'runtime token missing');
  await api('runtime read', 'GET', `/api/agents/runtime/pods/${pod}/messages`, undefined, minted.token);
  await api('agent runtime post', 'POST', `/api/agents/runtime/pods/${pod}/messages`, { content: 'agent smoke message', continueAnyway: true }, minted.token);
  const result = await api('task board create', 'POST', `/api/v1/tasks/${pod}`, { title: 'Bridge smoke task' });
  const taskId = result.task?.taskId;
  assert.ok(taskId, 'task create returned no taskId');
  const patched = await api('task board patch', 'PATCH', `/api/v1/tasks/${pod}/${taskId}`, { title: 'Bridge smoke patched' });
  assert.equal(patched.task?.title, 'Bridge smoke patched');
  console.log('PASS all requested HTTP operations');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
