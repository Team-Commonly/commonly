/**
 * Regression test for the install endpoint preserving curated displayName
 * across both seams it writes to.
 *
 * Surfaced 2026-05-20 in the dev-agent smoke pod: PR #408 fixed the
 * AgentInstallation.displayName seam, but the AgentProfile.name seam (read
 * FIRST by the V2 member list) still got `agent.displayName` ("Cuz 🦞" for
 * openclaw, "Codex" for codex), so every member row in a fresh pod showed
 * "Cuz" even though the underlying User identity was correct.
 *
 * Contract: when an admin/installer POSTs /install for an EXISTING agent
 * identity (same agentName + instanceId, User row already has a curated
 * botMetadata.displayName) with NO explicit `displayName` in the body, the
 * curated User displayName must propagate to BOTH AgentInstallation AND
 * AgentProfile, not the registry-wide default.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentRegistry, AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile').default || require('../../models/AgentProfile');

const registryRoutes = require('../../routes/registry');

const JWT_SECRET = 'test-jwt-secret-install-displayname';

jest.setTimeout(60000);

describe('Install endpoint preserves curated displayName (cycle-of-Aria regression)', () => {
  let app;
  let installer;
  let installerToken;
  let pod;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await setupMongoDb();

    app = express();
    app.use(express.json());
    app.use('/api/registry', registryRoutes);

    installer = await User.create({
      username: 'installer',
      email: 'installer@test.com',
      password: 'password123',
      // openclaw is a cloud (moltbot) agent — entitle the installer so the
      // hosted-agent gate passes; this test asserts displayName preservation.
      entitlements: { cloudAgents: true },
    });
    installerToken = jwt.sign({ id: installer._id.toString() }, JWT_SECRET);

    pod = await Pod.create({
      name: 'Install-DisplayName Test Pod',
      type: 'chat',
      createdBy: installer._id,
      members: [installer._id],
    });

    // Registry-wide manifest with the "ugly" default name — mirror the
    // production shape where openclaw → "Cuz 🦞" and codex → "Codex".
    await AgentRegistry.create({
      agentName: 'openclaw',
      displayName: 'Cuz 🦞',
      description: 'OpenClaw test',
      manifest: {
        name: 'openclaw',
        version: '1.0.0',
        capabilities: [],
        context: { required: [], optional: [] },
      },
      latestVersion: '1.0.0',
      versions: [{ version: '1.0.0', manifest: { name: 'openclaw', version: '1.0.0', capabilities: [], context: { required: [], optional: [] } }, publishedAt: new Date() }],
      registry: 'private',
    });

    // Pre-existing curated agent identity. This is the "Aria" / "Nova" /
    // "Pixel" case — the User row has the right name, we're just installing
    // her into a NEW pod.
    await User.create({
      username: 'openclaw-aria',
      email: 'openclaw-aria@bot.local',
      password: 'bot-no-login',
      isBot: true,
      botMetadata: {
        agentName: 'openclaw',
        instanceId: 'aria',
        displayName: 'Aria',
      },
    });
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await AgentInstallation.deleteMany({});
    await AgentProfile.deleteMany({});
  });

  it('writes curated User.botMetadata.displayName to AgentInstallation AND AgentProfile when no explicit displayName', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${installerToken}`)
      .send({
        agentName: 'openclaw',
        instanceId: 'aria',
        podId: pod._id.toString(),
        version: '1.0.0',
        scopes: ['context:read', 'summaries:read', 'messages:write'],
        // Deliberately NO displayName — must NOT fall back to registry default.
      });

    expect(res.status).toBe(200);

    const installation = await AgentInstallation.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'aria',
    }).lean();
    expect(installation).toBeTruthy();
    expect(installation.displayName).toBe('Aria');
    expect(installation.displayName).not.toBe('Cuz 🦞');

    const profile = await AgentProfile.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'aria',
    }).lean();
    expect(profile).toBeTruthy();
    expect(profile.name).toBe('Aria');
    expect(profile.name).not.toBe('Cuz 🦞');
  });

  it('does not promote a legacy runtime-shaped User displayName into either higher-precedence label', async () => {
    await User.create({
      username: 'openclaw-nova',
      email: 'openclaw-nova@bot.local',
      password: 'bot-no-login',
      isBot: true,
      botMetadata: {
        agentName: 'openclaw',
        instanceId: 'nova',
        // A historical writer stored the runtime rather than Nova’s label.
        displayName: 'openclaw (nova)',
      },
    });

    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${installerToken}`)
      .send({
        agentName: 'openclaw',
        instanceId: 'nova',
        podId: pod._id.toString(),
        version: '1.0.0',
        scopes: ['context:read', 'summaries:read', 'messages:write'],
      });

    expect(res.status).toBe(200);

    const installation = await AgentInstallation.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'nova',
    }).lean();
    expect(installation.displayName).toBe('nova');
    expect(installation.displayName).not.toBe('openclaw (nova)');

    const profile = await AgentProfile.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'nova',
    }).lean();
    expect(profile.name).toBe('nova');
    expect(profile.name).not.toBe('openclaw (nova)');
  });

  it('respects explicit displayName in request body over both registry default AND existing User row', async () => {
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${installerToken}`)
      .send({
        agentName: 'openclaw',
        instanceId: 'aria',
        podId: pod._id.toString(),
        version: '1.0.0',
        scopes: ['context:read', 'summaries:read', 'messages:write'],
        displayName: 'Aria Prime',
      });

    expect(res.status).toBe(200);

    const installation = await AgentInstallation.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'aria',
    }).lean();
    expect(installation.displayName).toBe('Aria Prime');

    const profile = await AgentProfile.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'aria',
    }).lean();
    expect(profile.name).toBe('Aria Prime');
  });

  it('falls back to registry displayName when no User row exists yet (fresh agent identity)', async () => {
    // A brand-new instanceId with no prior User row — the only signal is
    // the registry default, so we must use it rather than crashing or
    // writing an empty string.
    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${installerToken}`)
      .send({
        agentName: 'openclaw',
        instanceId: 'fresh-agent',
        podId: pod._id.toString(),
        version: '1.0.0',
        scopes: ['context:read', 'summaries:read', 'messages:write'],
      });

    expect(res.status).toBe(200);

    const installation = await AgentInstallation.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'fresh-agent',
    }).lean();
    // Registry default is acceptable when there's no curated identity to preserve.
    expect(installation.displayName).toBe('Cuz 🦞');
  });

  // TASK-032, ruled 2026-09-02: AgentInstallation is canonical; the User row
  // is a seed for an installation that has no name, never a preference over
  // one that does. Before the ruling this case reverted a per-pod label to
  // the shared identity's label on every re-install, while the read paths
  // (agentMessageService, dmService) already preferred the installation.
  //
  // This is the discriminating case for that precedence and nothing else in
  // the file reaches it: every other test starts from an empty
  // AgentInstallation collection, where seed and preference are the same
  // value and the two orderings agree.
  //
  // The reachable shape is uninstall-then-reinstall, not install-twice: an
  // ACTIVE row makes the route 400 ('Agent already installed in this pod'),
  // so the only way a second install meets an existing row is the
  // reactivation path — where ADR-001 §3 identity continuity keeps the row
  // (and its curated name) across the uninstall.
  it('keeps an existing installation displayName over the curated User row on re-install', async () => {
    await AgentInstallation.create({
      agentName: 'openclaw',
      podId: pod._id,
      instanceId: 'aria',
      installedBy: installer._id,
      version: '1.0.0',
      status: 'uninstalled',
      scopes: ['context:read'],
      // Curated for THIS pod, and deliberately different from the User row's
      // 'Aria' so the assertion cannot pass by coincidence.
      displayName: 'Aria (Sprint Desk)',
    });

    const res = await request(app)
      .post('/api/registry/install')
      .set('Authorization', `Bearer ${installerToken}`)
      .send({
        agentName: 'openclaw',
        instanceId: 'aria',
        podId: pod._id.toString(),
        version: '1.0.0',
        scopes: ['context:read', 'summaries:read', 'messages:write'],
        // No explicit displayName — the caller is re-installing, not renaming.
      });

    expect(res.status).toBe(200);

    const installation = await AgentInstallation.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'aria',
    }).lean();
    expect(installation.displayName).toBe('Aria (Sprint Desk)');
    // The two values the old precedence would have written instead.
    expect(installation.displayName).not.toBe('Aria');
    expect(installation.displayName).not.toBe('Cuz 🦞');

    const profile = await AgentProfile.findOne({
      podId: pod._id,
      agentName: 'openclaw',
      instanceId: 'aria',
    }).lean();
    expect(profile.name).toBe('Aria (Sprint Desk)');
  });
});
