/** TASK-527: extends TASK-514's production createApp / real-HTTP harness.
 * Real Mongo 7 + Postgres in Tier 1. Only the external model provider is a
 * deterministic loopback HTTP fixture; auth, install, queue and writers are real.
 * The BYO fixture is an external CAP client, not a mocked event service.
 */
const http = require('http');
const request = require('supertest');
const { randomUUID } = require('crypto');
const { setupMongoDb, closeMongoDb, setupPgDb, closePgDb, waitFor } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentRun = require('../../models/AgentRun');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');

// Keep cold TypeScript compilation outside the asynchronous database hook.
// TASK-514's factory import starts no database connection or background worker.
const createApp = process.env.INTEGRATION_TEST === 'true' ? require('../../server').createApp : null;
const tier1 = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const LIMIT_MS = 15000;
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const messages = (response) => Array.isArray(response.body) ? response.body : response.body.messages;

tier1('commonly verify first-agent-reply — production HTTP routes', () => {
  let app;
  let provider;
  let providerRequests;
  const environment = ['LITELLM_BASE_URL', 'LITELLM_MASTER_KEY', 'REGISTRATION_INVITE_ONLY',
    'SMTP2GO_API_KEY', 'INSTANCE_ALLOWED_EMAILS'];
  let previous;

  beforeAll(async () => {
    previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
    delete process.env.SMTP2GO_API_KEY;
    delete process.env.INSTANCE_ALLOWED_EMAILS;
    process.env.REGISTRATION_INVITE_ONLY = 'false';
    providerRequests = [];
    provider = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/chat/completions') {
        providerRequests.push(body);
        const posted = body.messages.some((message) => message.role === 'tool');
        const message = posted ? { role: 'assistant', content: 'NO_REPLY' } : {
          role: 'assistant', content: null, tool_calls: [{ id: 'verify527-post', type: 'function',
            function: { name: 'commonly_post_message', arguments: JSON.stringify({ content: 'verify527-hosted-reply' }) } }],
        };
        res.end(JSON.stringify({ id: 'verify527-completion', choices: [{ index: 0,
          message, finish_reason: posted ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      } else if (req.url === '/guardrails/apply_guardrail') res.end('{}');
      else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    process.env.LITELLM_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
    process.env.LITELLM_MASTER_KEY = 'verify527-local-only';
    await setupMongoDb();
    await setupPgDb();
    app = createApp();
  }, 120000);

  afterAll(async () => {
    if (app) await new Promise((resolve) => app.locals.socketServer.close(resolve));
    if (provider) await new Promise((resolve) => provider.close(resolve));
    const { pool } = require('../../config/db-pg');
    if (pool) await pool.end();
    await closePgDb();
    await closeMongoDb();
    for (const key of environment) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });

  async function signup() {
    const name = `verify527-${randomUUID().slice(0, 8)}`;
    const email = `${name}@example.test`;
    await request(app).post('/api/auth/register').send({ username: name, email, password: 'Password527!' }).expect(201);
    const login = await request(app).post('/api/auth/login').send({ email, password: 'Password527!' }).expect(200);
    const token = login.body.token;
    expect(token).toBeTruthy();
    const userId = login.body.user.id;
    let pod;
    await waitFor(async () => {
      pod = await Pod.findOne({ createdBy: userId, name: 'My Workspace' }).lean();
      if (!pod) return false;
      const install = await AgentInstallation.findOne({ podId: pod._id, agentName: 'scout', status: 'active' }).lean();
      return install && await User.exists({ isBot: true, 'botMetadata.agentName': 'scout',
        'botMetadata.instanceId': install.instanceId });
    }, { timeout: LIMIT_MS });
    // Decoy fixture has the same owner, but no install or first-contact wake.
    const decoy = await Pod.create({ name: `${name}-decoy`, type: 'chat',
      joinPolicy: 'invite-only', createdBy: userId, members: [userId] });
    const decoyId = String(decoy._id);
    return { token, userId, podId: String(pod._id), decoyId };
  }

  async function awaitReply(person, expected, agentId) {
    const deadline = Date.now() + LIMIT_MS;
    while (Date.now() < deadline) {
      const target = await request(app).get(`/api/messages/${person.podId}`).set(auth(person.token)).timeout({ deadline: 5000 }).expect(200);
      const decoy = await request(app).get(`/api/messages/${person.decoyId}`).set(auth(person.token)).timeout({ deadline: 5000 }).expect(200);
      for (const row of [...messages(target), ...messages(decoy)]) {
        expect(String(row.content || '')).not.toMatch(/NO_REPLY|HEARTBEAT_OK/);
      }
      expect(messages(decoy).some((row) => row.content === expected)).toBe(false);
      const reply = messages(target).find((row) => row.content === expected);
      if (reply) {
        expect(String(reply.userId?._id || reply.user_id || reply.userId)).toBe(String(agentId));
        expect(String(reply.pod_id || reply.podId)).toBe(person.podId);
        return reply;
      }
      await pause();
    }
    throw new Error(`First agent reply did not arrive in target pod within ${LIMIT_MS}ms`);
  }

  test('new signup gets a hosted Scout reply to its first human message', async () => {
    const person = await signup();
    const scout = await AgentInstallation.findOne({ podId: person.podId, agentName: 'scout' }).lean();
    const agent = await User.findOne({ isBot: true, 'botMetadata.agentName': 'scout',
      'botMetadata.instanceId': scout.instanceId }).lean();
    expect(agent).toBeTruthy();
    const marker = `verify527-human-${randomUUID()}`;
    await request(app).post(`/api/messages/${person.podId}`).set(auth(person.token))
      .send({ content: marker }).expect(200);
    await awaitReply(person, 'verify527-hosted-reply', agent._id);
    await waitFor(() => AgentRun.exists({ podId: person.podId, agentName: 'scout', status: 'succeeded' }), { timeout: LIMIT_MS });
    // Re-read after the final NO_REPLY provider response has settled.
    await awaitReply(person, 'verify527-hosted-reply', agent._id);
    expect(providerRequests.some((body) => JSON.stringify(body.messages).includes(marker))).toBe(true);
  }, 45000);

  test('new signup installs BYO, receives its wake over CAP and gets its reply in the same pod', async () => {
    const person = await signup();
    const name = `verify527-byo-${randomUUID().slice(0, 8)}`;
    await request(app).post('/api/registry/install').set(auth(person.token)).send({ agentName: name,
      podId: person.podId, config: { runtime: { runtimeType: 'wrapper', host: 'byo' },
        wakeOnMessage: { enabled: true, humanOnly: true } }, scopes: ['context:read', 'messages:read', 'messages:write', 'events:read', 'events:ack'] }).expect(200);
    const issued = await request(app).post(`/api/registry/pods/${person.podId}/agents/${name}/runtime-tokens`)
      .set(auth(person.token)).send({}).expect(200);
    const token = issued.body.token;
    expect(token).toMatch(/^cm_agent_/);
    const marker = `verify527-human-${randomUUID()}`;
    await request(app).post(`/api/messages/${person.podId}`).set(auth(person.token))
      .send({ content: `@${name} ${marker}` }).expect(200);
    let event;
    const deadline = Date.now() + LIMIT_MS;
    while (!event && Date.now() < deadline) {
      const inbox = await request(app).get('/api/agents/runtime/events').set(auth(token)).expect(200);
      event = inbox.body.events.find((item) => JSON.stringify(item.payload).includes(marker));
      if (!event) await pause();
    }
    expect(event).toBeTruthy();
    expect(String(event.podId)).toBe(person.podId);
    const fallback = 'verify527-byo-reply';
    const sendDeadline = Date.now() + LIMIT_MS;
    let sent = false;
    while (!sent && Date.now() < sendDeadline) {
      const read = await request(app).get(`/api/agents/runtime/pods/${person.podId}/messages`).set(auth(token)).expect(200);
      expect(messages(read).some((row) => String(row.content).includes(marker))).toBe(true);
      const posted = await request(app).post(`/api/agents/runtime/pods/${person.podId}/messages`)
        .set(auth(token)).send({ content: fallback });
      if (posted.status === 409 && posted.body.code === 'unseen_messages') {
        await pause(); // Honour the fresh read after a concurrent Scout post.
      } else {
        expect({ status: posted.status, body: posted.body }).toMatchObject({ status: 200, body: { success: true } });
        sent = true;
      }
    }
    expect(sent).toBe(true);
    const agent = await User.findOne({ isBot: true, 'botMetadata.agentName': name }).lean();
    await awaitReply(person, fallback, agent._id);
    await request(app).post(`/api/agents/runtime/events/${event.id || event._id}/ack`)
      .set(auth(token)).send({ deliveryId: event.deliveryId, result: { outcome: 'replied' } }).expect(200);
    expect(await AgentEvent.findById(event.id || event._id).lean()).toMatchObject({ status: 'acked' });
    // Exercise sentinel suppression via the real HTTP writer as well. It must
    // never create a user-visible row, including when a real BYO emits silence.
    await request(app).post(`/api/agents/runtime/pods/${person.podId}/messages`)
      .set(auth(token)).send({ content: 'NO_REPLY' }).expect(200);
    await awaitReply(person, fallback, agent._id);
  }, 45000);
});
