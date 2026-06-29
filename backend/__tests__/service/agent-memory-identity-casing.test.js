/**
 * ADR-003 convergence regression — agent-memory identity-casing split.
 *
 * The bug: `resolveMemoryIdentity` (routes/agentsRuntime.ts) keys the
 * AgentMemory document for every GET/PUT/sync over the HTTP memory boundary.
 * It used to return agentName WITHOUT normalization, while EVERY platform-side
 * writer/reader lowercases agentName:
 *   - systemExchangeTriggers.ts  -> String(agentName).toLowerCase()
 *   - agentEventService.ts       -> agentName.toLowerCase()
 *   - nativeRuntimeService.ts    -> String(installation.agentName || '').toLowerCase()
 *   - agentMemoryService.appendSystemExchange keys { agentName, instanceId } verbatim.
 *
 * The split only surfaces in the identity-continuity case: the bot's
 * AgentInstallation rows are gone (uninstalled / removed) but the User row +
 * its runtime token survive (ADR-001 identity-continuity invariant). With no
 * installation, resolveMemoryIdentity falls through the chain to
 * `botMetadata.agentName` / `username`, which can be mixed-case. A mixed-case
 * key on the agent's GET/PUT diverges from the platform's lowercased key —
 * silent read-after-write split: the agent reads a DIFFERENT doc than the
 * platform writes.
 *
 * This test reproduces exactly that case (mixed-case bot, NO active
 * AgentInstallation) and asserts the agent's PUT and the platform's
 * system_exchange write converge on ONE AgentMemory document.
 */

const express = require('express');
const request = require('supertest');

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const AgentMemory = require('../../models/AgentMemory');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { appendSystemExchange } = require('../../services/agentMemoryService');

// eslint-disable-next-line global-require
const { hash } = require('../../utils/secret');

const agentsRuntimeRoutes = require('../../routes/agentsRuntime');

jest.setTimeout(60000);

// Mixed-case identity — the username is what resolveMemoryIdentity falls back
// to when there's no installation, and the casing is the whole point.
const MIXED_AGENT_NAME = 'MixedCase-Agent';
const RAW_TOKEN = 'cm_agent_mixedcase_identity_regression_token';

describe('AgentMemory — identity-casing convergence (no installation)', () => {
  let app;

  beforeAll(async () => {
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/agents/runtime', agentsRuntimeRoutes);
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
  });

  // Create a bot User with a mixed-case identity + a runtime token minted
  // directly on the User row (the bot-user-token auth path), and crucially NO
  // AgentInstallation — the identity-continuity case the bug lives in.
  async function seedMixedCaseBotWithoutInstallation() {
    const botUser = await User.create({
      username: MIXED_AGENT_NAME,
      email: 'mixedcase-agent@agents.commonly.local',
      password: 'agent-password',
      verified: true,
      isBot: true,
      botType: 'agent',
      botMetadata: {
        displayName: 'Mixed Case Agent',
        agentName: MIXED_AGENT_NAME,
        instanceId: 'default',
      },
      agentRuntimeTokens: [
        { tokenHash: hash(RAW_TOKEN), label: 'casing-regression', createdAt: new Date() },
      ],
    });
    // Belt-and-suspenders: assert the precondition this whole test relies on.
    const installCount = await AgentInstallation.countDocuments({
      agentName: MIXED_AGENT_NAME.toLowerCase(),
    });
    expect(installCount).toBe(0);
    return botUser;
  }

  it('agent PUT and platform system_exchange write converge on ONE doc (lowercased key)', async () => {
    await seedMixedCaseBotWithoutInstallation();

    // 1) The agent writes its own memory over the HTTP boundary. With the fix,
    //    resolveMemoryIdentity lowercases the username-derived agentName.
    const put = await request(app)
      .put('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${RAW_TOKEN}`)
      .send({ content: '# MEMORY.md\nproject brain notes' });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);

    // 2) The platform writes a system_exchange. This mirrors EXACTLY how the
    //    platform writers key the doc (systemExchangeTriggers.resolveAgentMembers):
    //    agentName lowercased, instanceId from botMetadata (default 'default').
    const platformAgentName = String(MIXED_AGENT_NAME).toLowerCase();
    const platformInstanceId = 'default';
    const appendResult = await appendSystemExchange({
      agentName: platformAgentName,
      instanceId: platformInstanceId,
      kind: 'task-completed',
      surfacePodId: '507f1f77bcf86cd799439011',
      surfaceLabel: 'pod:demo',
      peers: [],
      takeaway: 'shipped the casing fix',
    });
    expect(appendResult).not.toBeNull();

    // 3) Exactly ONE AgentMemory document exists for this identity — the agent's
    //    PUT and the platform's append did NOT split into two casing variants.
    const allDocs = await AgentMemory.find({}).lean();
    expect(allDocs).toHaveLength(1);
    expect(allDocs[0].agentName).toBe(platformAgentName);
    expect(allDocs[0].instanceId).toBe(platformInstanceId);

    // The single doc holds BOTH the agent's content and the platform's entry.
    expect(allDocs[0].content).toBe('# MEMORY.md\nproject brain notes');
    expect(allDocs[0].sections.system_exchanges.entries).toHaveLength(1);
    expect(allDocs[0].sections.system_exchanges.entries[0].takeaway)
      .toContain('casing fix');

    // No mixed-case ghost doc exists.
    const ghost = await AgentMemory.findOne({ agentName: MIXED_AGENT_NAME }).lean();
    expect(ghost).toBeNull();
  });

  it('agent GET reads back the platform-written system_exchange (read-after-write across the boundary)', async () => {
    await seedMixedCaseBotWithoutInstallation();

    // Platform writes first, keyed the platform way (lowercased agentName).
    await appendSystemExchange({
      agentName: String(MIXED_AGENT_NAME).toLowerCase(),
      instanceId: 'default',
      kind: 'agent-dm-conclusion',
      surfacePodId: '507f1f77bcf86cd799439011',
      surfaceLabel: 'agent-dm:demo',
      peers: ['peer'],
      takeaway: 'concluded the dm',
    });

    // The agent reads its memory over the HTTP boundary and sees the platform's
    // write — proving both sides resolved the SAME envelope.
    const get = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${RAW_TOKEN}`);
    expect(get.status).toBe(200);
    expect(get.body.sections.system_exchanges.entries).toHaveLength(1);
    expect(get.body.sections.system_exchanges.entries[0].takeaway)
      .toContain('concluded the dm');
  });
});
