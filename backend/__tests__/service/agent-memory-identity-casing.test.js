/**
 * TASK-270 closes the old no-install memory path. The bot User and memory
 * remain for identity continuity, while its retired runtime token gets 401.
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
 * The old test expected GET/PUT to work without an AgentInstallation, which
 * let an uninstalled bearer read private memory. That expectation is inverted
 * under TASK-270; platform writes still preserve the lowercased envelope.
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

describe('AgentMemory — uninstalled token cannot reach retained memory (TASK-270)', () => {
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

  it('agent PUT is denied while the platform can retain a lowercased memory envelope', async () => {
    await seedMixedCaseBotWithoutInstallation();

    // The old casing regression used this forbidden no-install HTTP path.
    const put = await request(app)
      .put('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${RAW_TOKEN}`)
      .send({ content: '# MEMORY.md\nproject brain notes' });
    expect(put.status).toBe(401);

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

    // Only the platform write creates a document; the refused PUT writes none.
    const allDocs = await AgentMemory.find({}).lean();
    expect(allDocs).toHaveLength(1);
    expect(allDocs[0].agentName).toBe(platformAgentName);
    expect(allDocs[0].instanceId).toBe(platformInstanceId);

    expect(allDocs[0].content).not.toContain('project brain notes');
    expect(allDocs[0].sections.system_exchanges.entries).toHaveLength(1);
    expect(allDocs[0].sections.system_exchanges.entries[0].takeaway)
      .toContain('casing fix');

    // No mixed-case ghost doc exists.
    const ghost = await AgentMemory.findOne({ agentName: MIXED_AGENT_NAME }).lean();
    expect(ghost).toBeNull();
  });

  it('agent GET cannot read the retained platform-written system_exchange', async () => {
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

    // Identity continuity keeps this document; auth must still refuse the
    // uninstalled token before returning its contents.
    const get = await request(app)
      .get('/api/agents/runtime/memory')
      .set('Authorization', `Bearer ${RAW_TOKEN}`);
    expect(get.status).toBe(401);
    const retained = await AgentMemory.findOne({ agentName: MIXED_AGENT_NAME.toLowerCase() }).lean();
    expect(retained.sections.system_exchanges.entries).toHaveLength(1);
    expect(retained.sections.system_exchanges.entries[0].takeaway)
      .toContain('concluded the dm');
  });
});
