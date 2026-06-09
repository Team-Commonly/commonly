/**
 * WEDGE SMOKE — "one project memory shared by all your AI tools".
 *
 * The complement of two-driver-memory-cross-check.test.js (which proves
 * ISOLATION: different agent identities never see each other). This proves
 * CONVERGENCE: when every tool a developer uses authenticates with the SAME
 * agent identity (one COMMONLY_AGENT_TOKEN), they all read and write ONE shared
 * memory envelope — regardless of the tool shape used to reach the kernel.
 *
 * This is the "shared identity = the project's brain" framing: the schema is
 * keyed (agentName, instanceId), so pointing Claude Code + Cursor + Codex +
 * a webhook agent at the same token makes that envelope the shared store.
 *
 * Tool shapes exercised against ONE token:
 *   - Claude Code / Cursor / Codex (via @commonlyai/mcp) -> POST /memory/sync
 *     (the shipped MCP server's commonly_memory_sync verb) + GET /memory
 *   - Webhook SDK / CLI-wrapper -> direct CAP HTTP to the same endpoints
 *
 * If this passes, the wedge mechanic holds at the kernel: all tools converge.
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

const JWT_SECRET = 'test-jwt-secret-shared-identity';

jest.setTimeout(60000);

describe('WEDGE — shared identity converges memory across tools', () => {
  let app;
  let user;
  let authToken;
  let pod;
  let projectToken; // the ONE token every tool points at
  let secondToken; // a different identity, for the negative control

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    user = await User.create({
      username: 'wedge-admin',
      email: 'wedge@test.com',
      password: 'password123',
    });
    authToken = jwt.sign({ id: user._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Project Pod',
      type: 'chat',
      createdBy: user._id,
      members: [user._id],
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
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });

    // The project's shared brain — one agent identity, webhook-installed so it
    // needs no pre-published manifest (ADR-006 self-serve).
    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        agentName: 'project-brain',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read', 'messages:write'],
      })
      .expect(200);
    const t1 = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/project-brain/runtime-tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});
    projectToken = t1.body.token;

    // A second, unrelated identity — negative control for the isolation guard.
    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        agentName: 'other-brain',
        podId: pod._id.toString(),
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: ['context:read'],
      })
      .expect(200);
    const t2 = await request(app)
      .post(`/api/registry/pods/${pod._id}/agents/other-brain/runtime-tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});
    secondToken = t2.body.token;

    expect(projectToken).toMatch(/^cm_agent_/);
    expect(secondToken).toMatch(/^cm_agent_/);
  });

  // Helpers mirroring how each tool reaches the kernel. They differ ONLY in the
  // sourceRuntime tag — the endpoint + token are identical, which is the point.
  const writeAs = (token, sourceRuntime, sections, mode = 'patch') =>
    request(app)
      .post('/api/agents/runtime/memory/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode, sourceRuntime, sections });

  const readAs = (token) =>
    request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${token}`);

  it('Claude Code writes, Cursor (same token) reads it back', async () => {
    // Tool A = Claude Code via MCP commonly_memory_sync
    const w = await writeAs(projectToken, 'mcp-claude-code', {
      long_term: {
        content: 'Project uses pnpm workspaces. Deploy via Deploy Dev workflow.',
        visibility: 'private',
      },
    });
    expect(w.status).toBe(200);
    expect(w.body.ok).toBe(true);

    // Tool B = Cursor via MCP, SAME token
    const r = await readAs(projectToken);
    expect(r.status).toBe(200);
    expect(r.body.sections.long_term.content).toContain('pnpm workspaces');
  });

  it('three tools writing different sections all land in ONE envelope', async () => {
    // Claude Code -> long_term
    await writeAs(projectToken, 'mcp-claude-code', {
      long_term: { content: 'Architecture notes live in docs/adr.', visibility: 'private' },
    }).expect(200);
    // Codex CLI (via MCP on 0.133+) -> shared
    await writeAs(projectToken, 'mcp-codex', {
      shared: { content: 'Public project summary for teammates.', visibility: 'pod' },
    }).expect(200);
    // Webhook agent (HTTP-direct) -> dedup_state
    await writeAs(projectToken, 'webhook-sdk-py', {
      dedup_state: { content: 'last-indexed-commit: 5a05c421', visibility: 'private' },
    }).expect(200);

    // Any tool reading the shared identity sees ALL three sections converge.
    const r = await readAs(projectToken);
    expect(r.body.sections.long_term.content).toContain('docs/adr');
    expect(r.body.sections.shared.content).toContain('teammates');
    expect(r.body.sections.dedup_state.content).toContain('5a05c421');

    // Exactly ONE envelope exists for the shared identity — not one per tool.
    const docs = await AgentMemory.find({ agentName: 'project-brain' }).lean();
    expect(docs).toHaveLength(1);
  });

  it('a later tool sees an earlier tool\'s update (read-after-write across tools)', async () => {
    await writeAs(projectToken, 'mcp-claude-code', {
      long_term: { content: 'v1: initial setup', visibility: 'private' },
    }).expect(200);

    // A different tool (Codex) updates the same section on the shared identity.
    await writeAs(projectToken, 'mcp-codex', {
      long_term: { content: 'v2: added auth module', visibility: 'private' },
    }).expect(200);

    // Cursor reading later sees the latest, and the server records who wrote last.
    const r = await readAs(projectToken);
    expect(r.body.sections.long_term.content).toBe('v2: added auth module');
    expect(r.body.sourceRuntime).toBe('mcp-codex');
  });

  it('negative control: a DIFFERENT identity does NOT share the envelope', async () => {
    await writeAs(projectToken, 'mcp-claude-code', {
      long_term: { content: 'SECRET project context', visibility: 'private' },
    }).expect(200);

    // Same pod, different agent token -> separate envelope, no leakage.
    const r = await readAs(secondToken);
    expect(r.status).toBe(200);
    const otherContent = r.body.sections?.long_term?.content || '';
    expect(otherContent).not.toContain('SECRET project context');

    // The wedge requires SAME token. Different tokens => different brains.
    const names = (await AgentMemory.find({}).select('agentName').lean())
      .map((m) => m.agentName)
      .sort();
    expect(names).toContain('project-brain');
  });
});
