/**
 * ADR-003 Phase 1 — GET/PUT /memory envelope integration tests.
 *
 * Goes through the full agent-runtime auth pipeline (install agent → issue
 * runtime token → hit /memory) so the handlers are exercised the way a real
 * driver would hit them.
 *
 * Also covers the one-shot backfill script: v1 content-only records get
 * sections populated; v2 records are skipped; re-running is idempotent.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentMemory = require('../../models/AgentMemory');

const registryRoutes = require('../../routes/registry');
const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

const { backfillAgentMemorySections } = require('../../scripts/backfill-agent-memory-sections');

const JWT_SECRET = 'test-jwt-secret-for-memory-envelope';

jest.setTimeout(60000);

describe('AgentMemory envelope — GET/PUT /memory + backfill', () => {
  let app;
  let testUser;
  let authToken;
  let testPod;
  let runtimeToken;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);
    app.use('/api/agents/runtime', agentsRuntimeRoutes);

    testUser = await User.create({
      username: 'memory-admin',
      email: 'memory-admin@test.com',
      password: 'password123',
    });
    authToken = jwt.sign({ id: testUser._id.toString() }, JWT_SECRET);

    testPod = await Pod.create({
      name: 'Memory Pod',
      type: 'chat',
      createdBy: testUser._id,
      members: [testUser._id],
    });

    await AgentRegistry.create({
      agentName: 'mem-agent',
      displayName: 'Mem Agent',
      description: 'Agent for memory envelope tests',
      registry: 'commonly-official',
      verified: true,
      manifest: {
        name: 'mem-agent',
        version: '1.0.0',
        capabilities: [{ name: 'memory', description: 'uses memory' }],
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
    // Fresh install + token per test so state is fully isolated.
    await AgentInstallation.deleteMany({});
    await AgentMemory.deleteMany({});
    await User.updateMany({ isBot: true }, { $set: { agentRuntimeTokens: [] } });

    await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        agentName: 'mem-agent',
        podId: testPod._id.toString(),
        scopes: ['context:read'],
      });

    const tokenRes = await request(app)
      .post(`/api/registry/pods/${testPod._id}/agents/mem-agent/runtime-tokens`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ label: 'Memory Envelope Test Token' });
    runtimeToken = tokenRes.body.token;
    expect(runtimeToken).toMatch(/^cm_agent_/);
  });

  // ------------------------------------------------------------------- //
  // GET /memory                                                          //
  // ------------------------------------------------------------------- //

  describe('GET /memory', () => {
    it('returns empty content and undefined sections on a fresh record', async () => {
      const res = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('');
      expect(res.body.sections).toBeUndefined();
      expect(res.body.sourceRuntime).toBeUndefined();
      expect(res.body.schemaVersion).toBeUndefined();
    });

    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/api/agents/runtime/memory');
      expect(res.status).toBe(401);
    });

    it('returns both content and sections when both are persisted', async () => {
      const install = await AgentInstallation.findOne({ agentName: 'mem-agent' });
      await AgentMemory.create({
        agentName: install.agentName,
        instanceId: install.instanceId || 'default',
        content: 'v1 blob',
        sections: {
          long_term: { content: 'curated', visibility: 'private' },
          shared: { content: 'public bio', visibility: 'public' },
        },
        sourceRuntime: 'openclaw',
        schemaVersion: 2,
      });
      const res = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('v1 blob');
      expect(res.body.sections.long_term.content).toBe('curated');
      expect(res.body.sections.shared.visibility).toBe('public');
      expect(res.body.sourceRuntime).toBe('openclaw');
      expect(res.body.schemaVersion).toBe(2);
    });
  });

  // ------------------------------------------------------------------- //
  // PUT /memory                                                          //
  // ------------------------------------------------------------------- //

  describe('PUT /memory', () => {
    it('accepts the v1 shape and preserves content on read', async () => {
      const put = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ content: '# MEMORY.md\nhello' });
      expect(put.status).toBe(200);
      expect(put.body.ok).toBe(true);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('# MEMORY.md\nhello');
      // v1 writes do not auto-populate sections — that's the backfill's job.
      expect(get.body.sections).toBeUndefined();
    });

    it('accepts the v2 shape and mirrors long_term.content into content', async () => {
      const put = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            long_term: { content: 'curated', visibility: 'private' },
            dedup_state: { content: '## Commented\n{}' },
          },
          sourceRuntime: 'openclaw',
          schemaVersion: 2,
        });
      expect(put.status).toBe(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('curated'); // mirrored from long_term
      expect(get.body.sections.long_term.content).toBe('curated');
      expect(get.body.sections.dedup_state.content).toContain('Commented');
      expect(get.body.sourceRuntime).toBe('openclaw');
      expect(get.body.schemaVersion).toBe(2);
    });

    it('accepts both shapes in one request and stores each as given (no mirror override)', async () => {
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          content: 'explicit v1 blob',
          sections: { long_term: { content: 'different curated content' } },
        })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('explicit v1 blob');
      expect(get.body.sections.long_term.content).toBe('different curated content');
    });

    it('rejects a request with neither content nor sections', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/content or sections/);
    });

    it('rejects a non-string content', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ content: 42 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/content must be a string/);
    });

    it('rejects sections that are not an object', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/sections must be an object/);
    });

    it('rejects an invalid visibility on a section', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'x', visibility: 'everyone' } } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/visibility must be one of/);
    });

    it('rejects an invalid visibility on a daily entry', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { daily: [{ date: '2026-04-14', visibility: 'everyone' }] } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/daily\[\]\.visibility/);
    });

    it('rejects a relationships entry missing otherInstanceId', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { relationships: [{ notes: 'orphan' }] } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/otherInstanceId/);
    });

    it('rejects an empty sections object', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: {} });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/at least one key/);
    });

    it('rejects unknown section names', async () => {
      const res = await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { notes: { content: 'x' } } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/unknown section: notes/);
    });

    it('auto-sets schemaVersion to 2 when sections are written (not client-supplied)', async () => {
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'x' } } })
        .expect(200);
      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.schemaVersion).toBe(2);
    });

    it('server-stamps byteSize from content and ignores client-supplied values', async () => {
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            long_term: { content: '😀 hi', byteSize: 9999, updatedAt: '2000-01-01T00:00:00Z' },
          },
        })
        .expect(200);
      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term.byteSize).toBe(Buffer.byteLength('😀 hi', 'utf8'));
      const updatedAt = new Date(get.body.sections.long_term.updatedAt);
      expect(Date.now() - updatedAt.getTime()).toBeLessThan(60_000);
    });

    it('array sections (relationships, daily) are whole-array replace — Phase 1 intentional', async () => {
      // Seed two relationships.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            relationships: [
              { otherInstanceId: 'nova', notes: 'met in dev' },
              { otherInstanceId: 'theo', notes: 'pr review' },
            ],
          },
        })
        .expect(200);

      // Partial resend with ONE relationship — old entries are replaced, not merged.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { relationships: [{ otherInstanceId: 'liz', notes: 'new' }] },
        })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      const ids = (get.body.sections.relationships || []).map((r) => r.otherInstanceId);
      expect(ids).toEqual(['liz']); // nova and theo are intentionally replaced
    });

    it('sending long_term with empty content blanks the v1 content mirror (deliberate clear)', async () => {
      // Seed long_term with content so v1 mirror is non-empty.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'seeded' } } })
        .expect(200);

      // Explicit clear.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: '' } } })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('');
      expect(get.body.sections.long_term.content).toBe('');
      expect(get.body.sections.long_term.byteSize).toBe(0);
    });

    it('stamps byteSize per section when multiple sections arrive in one write', async () => {
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            long_term: { content: 'abcd' },
            shared: { content: 'hi', visibility: 'public' },
            dedup_state: { content: '## Commented\n{}' },
          },
        })
        .expect(200);
      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term.byteSize).toBe(4);
      expect(get.body.sections.shared.byteSize).toBe(2);
      expect(get.body.sections.dedup_state.byteSize).toBe(
        Buffer.byteLength('## Commented\n{}', 'utf8'),
      );
    });

    it('preserves sibling sections when a partial sections write lands', async () => {
      // Seed with long_term + shared + v1 content.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            long_term: { content: 'curated' },
            shared: { content: 'bio', visibility: 'public' },
          },
          sourceRuntime: 'openclaw',
        })
        .expect(200);

      // Partial write — only dedup_state. long_term, shared, and content must survive.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { dedup_state: { content: '## Commented\n{}' } } })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term.content).toBe('curated');
      expect(get.body.sections.shared.content).toBe('bio');
      expect(get.body.sections.shared.visibility).toBe('public');
      expect(get.body.sections.dedup_state.content).toContain('Commented');
      expect(get.body.content).toBe('curated'); // mirrored from original long_term write; not overwritten
      expect(get.body.sourceRuntime).toBe('openclaw');
    });

    it('does not overwrite content on a sections write that omits long_term', async () => {
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ content: 'original v1 content' })
        .expect(200);

      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { dedup_state: { content: '## Commented\n{}' } } })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('original v1 content');
      expect(get.body.sections.dedup_state.content).toContain('Commented');
    });

    it('is idempotent — repeated writes with the same shape do not error or duplicate', async () => {
      const put = () => request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ content: 'same every time' })
        .expect(200);
      await Promise.all([put(), put(), put()]);
      const count = await AgentMemory.countDocuments({});
      expect(count).toBe(1);
    });

    it('does not erase existing sections when only content is sent', async () => {
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'seed' } } });
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ content: 'new content only' });
      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('new content only');
      expect(get.body.sections.long_term.content).toBe('seed');
    });
  });

  // ------------------------------------------------------------------- //
  // backfill-agent-memory-sections                                       //
  // ------------------------------------------------------------------- //

  describe('backfillAgentMemorySections', () => {
    it('populates sections from legacy content for v1 records', async () => {
      await AgentMemory.create({
        agentName: 'openclaw',
        instanceId: 'alpha',
        content: '# MEMORY.md\nDurable stuff.\n## Commented\n{"a":1}',
      });

      const result = await backfillAgentMemorySections();
      expect(result).toMatchObject({
        total: 1, migrated: 1, skipped: 0, empty: 0,
      });

      const after = await AgentMemory.findOne({ instanceId: 'alpha' });
      expect(after.sections.long_term.content).toContain('Durable stuff.');
      expect(after.sections.long_term.content).not.toContain('## Commented');
      expect(after.sections.dedup_state.content).toContain('## Commented');
      // sourceRuntime intentionally left unset — first post-migration write
      // will populate with the driver's own identifier (ADR-003 §Runtime
      // driver expectations).
      expect(after.sourceRuntime).toBeUndefined();
      expect(after.schemaVersion).toBe(2);
      // v1 blob is preserved — ADR-003 Phase 1 is additive.
      expect(after.content).toContain('## Commented');
    });

    it('skips records that already have sections', async () => {
      await AgentMemory.create({
        agentName: 'openclaw',
        instanceId: 'beta',
        content: 'legacy',
        sections: { long_term: { content: 'already migrated' } },
        sourceRuntime: 'openclaw',
        schemaVersion: 2,
      });

      const result = await backfillAgentMemorySections();
      expect(result).toMatchObject({ total: 1, migrated: 0, skipped: 1 });

      const after = await AgentMemory.findOne({ instanceId: 'beta' });
      expect(after.sections.long_term.content).toBe('already migrated');
    });

    it('is idempotent — re-running does not re-migrate already-migrated records', async () => {
      await AgentMemory.create({
        agentName: 'openclaw',
        instanceId: 'gamma',
        content: 'plain content',
      });

      const first = await backfillAgentMemorySections();
      expect(first.migrated).toBe(1);
      const second = await backfillAgentMemorySections();
      expect(second.migrated).toBe(0);
      expect(second.skipped).toBe(1);
    });

    it('treats records with empty content as empty, not migrated', async () => {
      await AgentMemory.create({ agentName: 'openclaw', instanceId: 'delta', content: '' });
      const result = await backfillAgentMemorySections();
      expect(result.empty).toBe(1);
      expect(result.migrated).toBe(0);
      const after = await AgentMemory.findOne({ instanceId: 'delta' });
      expect(after.sections).toBeUndefined();
    });

    it('dryRun does not write changes', async () => {
      await AgentMemory.create({ agentName: 'openclaw', instanceId: 'eps', content: '## Commented\n{}' });
      const result = await backfillAgentMemorySections({ dryRun: true });
      expect(result.migrated).toBe(1);
      const after = await AgentMemory.findOne({ instanceId: 'eps' });
      expect(after.sections).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------- //
  // POST /memory/sync  (ADR-003 Phase 2)                                 //
  // ------------------------------------------------------------------- //

  describe('POST /memory/sync', () => {
    it('rejects requests without sections', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ mode: 'full' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/sections is required/);
    });

    it('rejects requests without a valid mode', async () => {
      const resA = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'x' } } });
      expect(resA.status).toBe(400);
      expect(resA.body.message).toMatch(/mode must be 'full' or 'patch'/);

      const resB = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'x' } }, mode: 'merge' });
      expect(resB.status).toBe(400);
    });

    it('rejects invalid YYYY-MM-DD date on daily entries', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { daily: [{ date: '2026/04/14', content: 'x' }] },
          mode: 'full',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/YYYY-MM-DD/);
    });

    it('also rejects calendar-invalid dates (feb 30)', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { daily: [{ date: '2026-02-30', content: 'x' }] },
          mode: 'full',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/YYYY-MM-DD/);
    });

    it('full mode: replaces the entire sections envelope', async () => {
      // Seed with long_term + shared.
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'old' }, shared: { content: 'bio', visibility: 'public' } } })
        .expect(200);

      // full sync with only dedup_state — long_term/shared should be gone.
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { dedup_state: { content: '## Commented\n{}' } },
          mode: 'full',
          sourceRuntime: 'openclaw',
        })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term).toBeUndefined();
      expect(get.body.sections.shared).toBeUndefined();
      expect(get.body.sections.dedup_state.content).toContain('Commented');
      expect(get.body.sourceRuntime).toBe('openclaw');
    });

    it('patch mode: preserves sibling sections and merges daily by date', async () => {
      // Seed.
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            long_term: { content: 'keep me' },
            daily: [
              { date: '2026-04-12', content: 'mon' },
              { date: '2026-04-13', content: 'tue' },
            ],
          },
          mode: 'full',
        })
        .expect(200);

      // Patch with updated tue + new wed; long_term should survive.
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            daily: [
              { date: '2026-04-13', content: 'tue-updated' },
              { date: '2026-04-14', content: 'wed' },
            ],
          },
          mode: 'patch',
        })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term.content).toBe('keep me');
      const byDate = Object.fromEntries(get.body.sections.daily.map((d) => [d.date, d.content]));
      expect(byDate['2026-04-12']).toBe('mon');
      expect(byDate['2026-04-13']).toBe('tue-updated');
      expect(byDate['2026-04-14']).toBe('wed');
    });

    it('patch mode: merges relationships by otherInstanceId', async () => {
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            relationships: [
              { otherInstanceId: 'nova', notes: 'old nova' },
              { otherInstanceId: 'theo', notes: 'old theo' },
            ],
          },
          mode: 'full',
        })
        .expect(200);

      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: {
            relationships: [
              { otherInstanceId: 'nova', notes: 'new nova' },
              { otherInstanceId: 'liz', notes: 'new liz' },
            ],
          },
          mode: 'patch',
        })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      const byId = Object.fromEntries(
        get.body.sections.relationships.map((r) => [r.otherInstanceId, r.notes]),
      );
      expect(byId.nova).toBe('new nova');
      expect(byId.theo).toBe('old theo');
      expect(byId.liz).toBe('new liz');
    });

    it('mirrors v1 content when patch mode includes long_term', async () => {
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { long_term: { content: 'sync-mirrored' } },
          mode: 'patch',
        })
        .expect(200);

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('sync-mirrored');
    });

    it('dedupes identical payloads within the same day bucket', async () => {
      const body = {
        sections: { long_term: { content: 'stable' } },
        sourceRuntime: 'openclaw',
        mode: 'patch',
      };

      const first = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send(body);
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);
      expect(first.body.deduped).toBeUndefined();

      const second = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send(body);
      expect(second.status).toBe(200);
      expect(second.body.ok).toBe(true);
      expect(second.body.deduped).toBe(true);

      // Count should still be 1.
      expect(await AgentMemory.countDocuments({})).toBe(1);
    });

    it('does NOT dedupe when the payload content changes', async () => {
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { long_term: { content: 'first' } }, sourceRuntime: 'openclaw', mode: 'patch',
        })
        .expect(200);

      const res = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { long_term: { content: 'second' } }, sourceRuntime: 'openclaw', mode: 'patch',
        });
      expect(res.body.deduped).toBeUndefined();
      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term.content).toBe('second');
    });

    it('server-stamps byteSize on sync writes', async () => {
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({
          sections: { long_term: { content: '😀 hi', byteSize: 9999 } },
          mode: 'full',
        })
        .expect(200);
      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term.byteSize).toBe(Buffer.byteLength('😀 hi', 'utf8'));
    });

    it('rejects unauthenticated sync requests', async () => {
      const res = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .send({ sections: { long_term: { content: 'x' } }, mode: 'full' });
      expect(res.status).toBe(401);
    });

    it('full mode without long_term wipes the v1 content mirror', async () => {
      // Seed with v1 content via mirror.
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'v1 mirror source' } }, mode: 'full' })
        .expect(200);
      let get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('v1 mirror source');

      // full sync that omits long_term — v1 content must be blanked, not stale.
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { dedup_state: { content: '## Commented\n{}' } }, mode: 'full' })
        .expect(200);
      get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.content).toBe('');
      expect(get.body.sections.long_term).toBeUndefined();
    });

    it('PUT /memory invalidates the sync dedup cache (cross-writer safety)', async () => {
      const body = {
        sections: { long_term: { content: 'dedup-me' } },
        sourceRuntime: 'openclaw',
        mode: 'patch',
      };

      // Sync once so lastSyncKey is populated.
      await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send(body)
        .expect(200);

      // A non-sync writer mutates sections directly (human operator / v1 tool).
      await request(app)
        .put('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send({ sections: { long_term: { content: 'stomped by PUT' } } })
        .expect(200);

      // The same sync payload must NOT be deduped now — kernel state drifted.
      const second = await request(app)
        .post('/api/agents/runtime/memory/sync')
        .set('Authorization', `Bearer ${runtimeToken}`)
        .send(body);
      expect(second.body.deduped).toBeUndefined();

      const get = await request(app)
        .get('/api/agents/runtime/memory')
        .set('Authorization', `Bearer ${runtimeToken}`);
      expect(get.body.sections.long_term.content).toBe('dedup-me');
    });
  });
});
