/**
 * ADR-003 Phase 3 §Deliverable 3 — two-driver memory cross-check.
 *
 * Proves that memory is kernel-shaped, not driver-shaped:
 *   - One agent installed as a CLI-wrapper driver (sourceRuntime: 'local-cli')
 *   - One agent installed as a webhook-SDK driver (sourceRuntime: 'webhook-sdk-py')
 *   - Both live in the same pod
 *   - Each writes its own memory envelope via POST /memory/sync
 *   - Each reads back ONLY its own data (isolation by agentName/instanceId)
 *   - Server stamps (byteSize, updatedAt, schemaVersion) are applied identically
 *     regardless of driver
 *
 * This is the end-to-end proof that memory is a kernel primitive — the same
 * API, the same schema, the same invariants, regardless of whether the agent
 * is a local subprocess or a remote webhook process.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentMemory = require('../../models/AgentMemory');
const AgentProfile = require('../../models/AgentProfile');

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const JWT_SECRET = 'test-jwt-secret-cross-check';

jest.setTimeout(60000);

describe('ADR-003 Phase 3 — two-driver memory cross-check', () => {
  let app;
  let user;
  let authToken;
  let pod;
  let cliToken;
  let webhookToken;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    user = await User.create({
      username: 'crosscheck-admin',
      email: 'crosscheck@test.com',
      password: 'password123',
    });
    authToken = jwt.sign({ id: user._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Cross-Check Pod',
      type: 'chat',
      createdBy: user._id,
      members: [user._id],
    });

    // --- Agent 1: CLI-wrapper driver (like ADR-005 `commonly agent run`) ---
    await AgentRegistry.create({
      agentName: 'cli-wrapper-agent',
      displayName: 'CLI Wrapper Agent',
      description: 'Simulates a local-CLI driver agent',
      registry: 'commonly-community',
      manifest: {
        name: 'cli-wrapper-agent',
        version: '1.0.0',
        capabilities: [],
        context: { required: ['context:read'] },
        runtime: { type: 'standalone', connection: 'rest' },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', publishedAt: new Date() }],
    });

  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await AgentMemory.deleteMany({});
    await AgentProfile.deleteMany({});
    await AgentRegistry.deleteMany({ ephemeral: true });
    // Reset runtime tokens between tests — bot User rows survive (identity continuity)
    // but issued tokens are revoked so each test gets a fresh auth context.
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });

    // Agent 1: CLI-wrapper driver (pre-published manifest, seeded in beforeAll).
    const cliInstall = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        agentName: 'cli-wrapper-agent',
        podId: pod._id.toString(),
        scopes: ['context:read'],
      });
    expect(cliInstall.status).toBe(200);
    const t1 = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/cli-wrapper-agent/runtime-tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});
    cliToken = t1.body.token;

    // Agent 2: webhook-SDK driver (ADR-006 self-serve — no pre-published manifest).
    const installRes = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        agentName: 'webhook-sdk-agent',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read', 'messages:write'],
      });
    expect(installRes.status).toBe(200);
    const t2 = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/webhook-sdk-agent/runtime-tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});
    webhookToken = t2.body.token;

    expect(cliToken).toMatch(/^cm_agent_/);
    expect(webhookToken).toMatch(/^cm_agent_/);
  });

  // ------------------------------------------------------------------- //
  // Core cross-check: each driver writes + reads its own memory          //
  // ------------------------------------------------------------------- //

  it('both drivers write and read isolated memory envelopes', async () => {
    // CLI-wrapper writes via POST /memory/sync (same as memory-bridge.js syncBack)
    const cliSync = await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: {
          long_term: {
            content: 'User prefers concise answers. Allergic to kiwi.',
            visibility: 'private',
          },
        },
      });
    expect(cliSync.status).toBe(200);
    expect(cliSync.body.ok).toBe(true);
    expect(cliSync.body.schemaVersion).toBe(2);

    // Webhook-SDK writes via POST /memory/sync (same as commonly.py sync_memory)
    const webhookSync = await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'webhook-sdk-py',
        sections: {
          long_term: {
            content: 'Tracks daily standup summaries for the team.',
            visibility: 'private',
          },
        },
      });
    expect(webhookSync.status).toBe(200);
    expect(webhookSync.body.ok).toBe(true);
    expect(webhookSync.body.schemaVersion).toBe(2);

    // CLI-wrapper reads back — sees only its own content
    const cliRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${cliToken}`);
    expect(cliRead.status).toBe(200);
    expect(cliRead.body.sections.long_term.content).toBe(
      'User prefers concise answers. Allergic to kiwi.',
    );
    expect(cliRead.body.sourceRuntime).toBe('local-cli');

    // Webhook-SDK reads back — sees only its own content
    const webhookRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${webhookToken}`);
    expect(webhookRead.status).toBe(200);
    expect(webhookRead.body.sections.long_term.content).toBe(
      'Tracks daily standup summaries for the team.',
    );
    expect(webhookRead.body.sourceRuntime).toBe('webhook-sdk-py');

    // Cross-contamination check: neither envelope leaks into the other
    expect(cliRead.body.sections.long_term.content).not.toContain('standup');
    expect(webhookRead.body.sections.long_term.content).not.toContain('kiwi');
  });

  // ------------------------------------------------------------------- //
  // Server stamps are identical regardless of driver                      //
  // ------------------------------------------------------------------- //

  it('server stamps (byteSize, updatedAt, schemaVersion) behave identically across drivers', async () => {
    // Both write at roughly the same time
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: { long_term: { content: 'cli memo', visibility: 'private' } },
      });
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'webhook-sdk-py',
        sections: { long_term: { content: 'webhook memo', visibility: 'private' } },
      });

    const [cliMem, webhookMem] = await Promise.all([
      AgentMemory.findOne({ agentName: 'cli-wrapper-agent' }).lean(),
      AgentMemory.findOne({ agentName: 'webhook-sdk-agent' }).lean(),
    ]);

    // Both at schemaVersion 2
    expect(cliMem.schemaVersion).toBe(2);
    expect(webhookMem.schemaVersion).toBe(2);

    // byteSize is computed by the server from UTF-8 byte length of content
    expect(cliMem.sections.long_term.byteSize).toBe(Buffer.byteLength('cli memo', 'utf8'));
    expect(webhookMem.sections.long_term.byteSize).toBe(Buffer.byteLength('webhook memo', 'utf8'));

    // updatedAt is server-set (Date object, not undefined)
    expect(cliMem.sections.long_term.updatedAt).toBeInstanceOf(Date);
    expect(webhookMem.sections.long_term.updatedAt).toBeInstanceOf(Date);
  });

  // ------------------------------------------------------------------- //
  // Patch mode merges correctly for both drivers                          //
  // ------------------------------------------------------------------- //

  it('patch mode preserves sibling sections for both drivers', async () => {
    // CLI writes long_term
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: { long_term: { content: 'cli long term', visibility: 'private' } },
      });
    // CLI writes shared (a second section) — long_term should survive
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: { shared: { content: 'cli public bio', visibility: 'public' } },
      });

    const cliRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${cliToken}`);
    expect(cliRead.body.sections.long_term.content).toBe('cli long term');
    expect(cliRead.body.sections.shared.content).toBe('cli public bio');

    // Same for webhook
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'webhook-sdk-py',
        sections: { long_term: { content: 'webhook long term', visibility: 'private' } },
      });
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'webhook-sdk-py',
        sections: { shared: { content: 'webhook public bio', visibility: 'pod' } },
      });

    const webhookRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${webhookToken}`);
    expect(webhookRead.body.sections.long_term.content).toBe('webhook long term');
    expect(webhookRead.body.sections.shared.content).toBe('webhook public bio');
  });

  // ------------------------------------------------------------------- //
  // Full mode replaces correctly for both drivers                         //
  // ------------------------------------------------------------------- //

  it('full mode replaces the entire envelope for both drivers', async () => {
    // Seed both agents with long_term + shared
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: {
          long_term: { content: 'will be replaced', visibility: 'private' },
          shared: { content: 'also replaced', visibility: 'public' },
        },
      });
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'webhook-sdk-py',
        sections: {
          long_term: { content: 'will be replaced', visibility: 'private' },
          shared: { content: 'also replaced', visibility: 'public' },
        },
      });

    // CLI full-mode: only sends long_term → shared should be cleared
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'full',
        sourceRuntime: 'local-cli',
        sections: { long_term: { content: 'only this survives', visibility: 'private' } },
      });

    const cliRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${cliToken}`);
    expect(cliRead.body.sections.long_term.content).toBe('only this survives');
    expect(cliRead.body.sections.shared).toBeUndefined();

    // Webhook full-mode: only sends shared → long_term should be cleared
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'full',
        sourceRuntime: 'webhook-sdk-py',
        sections: { shared: { content: 'only shared survives', visibility: 'pod' } },
      });

    const webhookRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${webhookToken}`);
    expect(webhookRead.body.sections.long_term).toBeUndefined();
    expect(webhookRead.body.sections.shared.content).toBe('only shared survives');
  });

  // ------------------------------------------------------------------- //
  // Dedup works identically for both drivers                              //
  // ------------------------------------------------------------------- //

  it('dedup is per-agent and per-driver — identical payloads from different agents are NOT deduped', async () => {
    const sections = { long_term: { content: 'identical payload', visibility: 'private' } };

    const cli1 = await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({ mode: 'patch', sourceRuntime: 'local-cli', sections });
    expect(cli1.body.deduped).toBeUndefined();

    const webhook1 = await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({ mode: 'patch', sourceRuntime: 'webhook-sdk-py', sections });
    expect(webhook1.body.deduped).toBeUndefined();

    // Same agent, same payload → deduped
    const cli2 = await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({ mode: 'patch', sourceRuntime: 'local-cli', sections });
    expect(cli2.body.deduped).toBe(true);

    const webhook2 = await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({ mode: 'patch', sourceRuntime: 'webhook-sdk-py', sections });
    expect(webhook2.body.deduped).toBe(true);
  });

  // ------------------------------------------------------------------- //
  // v1 content mirroring works for both drivers                           //
  // ------------------------------------------------------------------- //

  it('v1 content field mirrors long_term.content for both drivers', async () => {
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: { long_term: { content: 'cli v1 mirror test', visibility: 'private' } },
      });
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'webhook-sdk-py',
        sections: { long_term: { content: 'webhook v1 mirror test', visibility: 'private' } },
      });

    // Read via GET — content (v1) should mirror long_term.content (v2)
    const cliRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${cliToken}`);
    expect(cliRead.body.content).toBe('cli v1 mirror test');

    const webhookRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${webhookToken}`);
    expect(webhookRead.body.content).toBe('webhook v1 mirror test');
  });

  // ------------------------------------------------------------------- //
  // Cross-driver token isolation — can't read the other's memory          //
  // ------------------------------------------------------------------- //

  it('tokens are scoped — each agent only sees its own envelope', async () => {
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${cliToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'local-cli',
        sections: { long_term: { content: 'SECRET: cli only', visibility: 'private' } },
      });
    await request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${webhookToken}`)
      .send({
        mode: 'patch',
        sourceRuntime: 'webhook-sdk-py',
        sections: { long_term: { content: 'SECRET: webhook only', visibility: 'private' } },
      });

    // CLI token can never see webhook memory
    const cliRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${cliToken}`);
    expect(cliRead.body.sections.long_term.content).not.toContain('webhook only');

    // Webhook token can never see CLI memory
    const webhookRead = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${webhookToken}`);
    expect(webhookRead.body.sections.long_term.content).not.toContain('cli only');

    // DB-level: both agents have distinct AgentMemory documents
    const names = (await AgentMemory.find({}).select('agentName').lean())
      .map((m) => m.agentName).sort();
    expect(names).toEqual(['cli-wrapper-agent', 'webhook-sdk-agent']);
  });
});
