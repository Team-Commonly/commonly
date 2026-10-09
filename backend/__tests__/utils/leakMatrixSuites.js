/**
 * B1 leak matrix — the suites. Each suite is { name, mount(app), seed(), cases }.
 *
 * seed() builds a world on memory Mongo with every credential-bearing field set
 * to a sentinel (see leakMatrix.js) and returns
 *   { sentinels, identities: { role: { user } | { agent } }, ...ids }.
 * Every human in every suite also carries User secrets (password, apiToken,
 * agentRuntimeTokens/deviceTokens hashes, digestUnsubscribeToken) so a populate
 * or projection that drags a User row along is caught on any route.
 *
 * A case is { method, path, role, url(ctx), expect, variant? }: `expect` is the
 * status the route answers today, pinned so a broken harness (every call a 500)
 * cannot pass vacuously.
 *
 * Models and routers are required lazily, inside mount()/seed(), so the calling
 * test file's jest.mock()s are registered first.
 */
const mongoose = require('mongoose');
const { createSentinels, sentinelValue, TOOLCALL_ARGS_SENTINEL_KEY } = require('./leakMatrix');

/* eslint-disable global-require */
const model = {
  User: () => require('../../models/User'),
  Pod: () => require('../../models/Pod'),
  Integration: () => require('../../models/Integration'),
  DiscordIntegration: () => require('../../models/DiscordIntegration'),
  InstallableInstallation: () => require('../../models/InstallableInstallation'),
  Installable: () => require('../../models/Installable'),
  AgentCredential: () => require('../../models/AgentCredential'),
  RoomGrant: () => require('../../models/RoomGrant'),
  AgentInstallation: () => require('../../models/AgentRegistry').AgentInstallation,
  Machine: () => require('../../models/Machine'),
  Gateway: () => require('../../models/Gateway'),
};
/* eslint-enable global-require */

const FUTURE = new Date('2099-01-01T00:00:00.000Z');

/**
 * A User row whose every secret field is a sentinel. Secrets are written with
 * the raw driver after create: the password pre-save hook would bcrypt the
 * sentinel away, and apiToken/digestUnsubscribeToken are select:false.
 */
const seedUser = async (s, prefix, over = {}) => {
  const User = model.User();
  const user = await User.create({
    username: `${prefix.toLowerCase()}-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
    email: `${prefix.toLowerCase()}-${new mongoose.Types.ObjectId().toString().slice(-6)}@leak.test`,
    password: 'placeholder-password',
    ...over,
  });
  await User.collection.updateOne({ _id: user._id }, {
    $set: {
      password: s(`${prefix}_USER_PASSWORD`),
      apiToken: s(`${prefix}_USER_APITOKEN`),
      digestUnsubscribeToken: s(`${prefix}_USER_DIGESTUNSUBSCRIBETOKEN`),
      agentRuntimeTokens: [{ tokenHash: s(`${prefix}_USER_AGENTRUNTIMETOKEN_HASH`), label: 'rt', createdAt: new Date() }],
      deviceTokens: [{ _id: new mongoose.Types.ObjectId(), tokenHash: s(`${prefix}_USER_DEVICETOKEN_HASH`), label: 'laptop', createdAt: new Date() }],
    },
  });
  return user._id;
};

const seedAgentUser = (s, prefix, agentName) => seedUser(s, prefix, {
  isBot: true,
  botType: 'agent',
  botMetadata: { agentName, instanceId: 'default', displayName: prefix },
});

/** Every Integration secret the schema allows, each a sentinel under `prefix`. */
const integrationSecrets = (s, prefix, { connectCode = false } = {}) => ({
  installationClaimId: s(`${prefix}_INSTALLATIONCLAIMID`),
  ingestTokens: [{ tokenHash: s(`${prefix}_INGEST_TOKENHASH`), label: 'ci', createdAt: new Date() }],
  config: {
    botToken: s(`${prefix}_BOTTOKEN`),
    signingSecret: s(`${prefix}_SIGNINGSECRET`),
    secretToken: s(`${prefix}_SECRETTOKEN`),
    accessToken: s(`${prefix}_ACCESSTOKEN`),
    refreshToken: s(`${prefix}_REFRESHTOKEN`),
    webhookUrl: `https://hooks.example.test/services/T1/B1/${s(`${prefix}_WEBHOOKURL`)}`,
    botTokenRef: s(`${prefix}_BOTTOKENREF`),
    oauthStateNonce: s(`${prefix}_OAUTHSTATENONCE`),
    oauthStateClaimId: s(`${prefix}_OAUTHSTATECLAIMID`),
    ...(connectCode ? { connectCode: s(`${prefix}_CONNECTCODE`) } : {}),
  },
});

const withConfig = (secrets, config) => ({ ...secrets, config: { ...secrets.config, ...config } });

/**
 * `refuse` lists roles whose correct answer is 401/403. Their `expect` is still
 * today's status; a 2xx for one of them fails the matrix unless KNOWN_EXPOSURES
 * lists it as ACCESS_2XX.
 */
const userCase = (method, path, role, url, expect, variant, refuse = false) => ({
  method, path, role, url, expect, variant, ...(refuse ? { refuse: true } : {}),
});
const matrix = (method, path, url, expectByRole, variant, { refuse = [] } = {}) => Object.entries(expectByRole)
  .map(([role, expect]) => userCase(method, path, role, url, expect, variant, refuse.includes(role)));

// ---------------------------------------------------------------------------
// 1. Integrations (+ Discord binding, admin global integrations)
// ---------------------------------------------------------------------------
const integrations = {
  name: 'integrations',
  mount(app) {
    /* eslint-disable global-require */
    app.use('/api/integrations', require('../../routes/integrations'));
    app.use('/api/discord', require('../../routes/discord'));
    app.use('/api/admin/integrations/global', require('../../routes/admin/globalIntegrations'));
    /* eslint-enable global-require */
  },
  async seed() {
    const s = createSentinels();
    const Pod = model.Pod();
    const Integration = model.Integration();
    const owner = await seedUser(s, 'OWNER');
    const member = await seedUser(s, 'MEMBER');
    const stranger = await seedUser(s, 'STRANGER');
    const admin = await seedUser(s, 'ADMIN', { role: 'admin' });
    const pod = await Pod.create({ name: 'Leak Ops', createdBy: owner, members: [owner, member] });
    const base = { podId: pod._id, scope: 'pod', status: 'connected', createdBy: owner, isActive: true };

    const telegram = await Integration.create({
      ...base,
      type: 'telegram',
      ...withConfig(integrationSecrets(s, 'INT_TELEGRAM', { connectCode: true }), { chatId: '-100', chatTitle: 'Ops' }),
    });
    const slack = await Integration.create({
      ...base,
      type: 'slack',
      ...withConfig(integrationSecrets(s, 'INT_SLACK'), {
        teamId: 'T1',
        pendingBind: {
          teamId: 'T1', slackUserId: 'U1', chatId: 'D1', expiresAt: FUTURE,
          botTokenRef: s('INT_SLACK_PENDINGBIND_BOTTOKENREF'),
        },
      }),
    });
    await Integration.create({
      ...base,
      type: 'x',
      ...withConfig(integrationSecrets(s, 'INT_X'), { username: 'ops' }),
    });
    const discord = await Integration.create({
      ...base,
      type: 'discord',
      ...withConfig(integrationSecrets(s, 'INT_DISCORD'), { serverId: 'srv-1', channelId: 'chan-1' }),
    });
    await model.DiscordIntegration().create({
      integrationId: discord._id,
      serverId: 'srv-1',
      serverName: 'Guild',
      channelId: 'chan-1',
      channelName: 'general',
      webhookUrl: `https://discord.com/api/webhooks/1/${s('DISCORDINTEGRATION_WEBHOOKURL')}`,
      webhookId: '1',
      botToken: s('DISCORDINTEGRATION_BOTTOKEN'),
    });

    // The admin global-integrations page reads X/Instagram rows in the pod
    // named 'Global Social Feed' (ensureGlobalSocialFeedPod finds it by name).
    const globalPod = await Pod.create({ name: 'Global Social Feed', type: 'chat', createdBy: admin, members: [admin] });
    await Integration.create({
      podId: globalPod._id, scope: 'pod', status: 'connected', createdBy: admin, isActive: true,
      type: 'x',
      ...withConfig(integrationSecrets(s, 'GLOBAL_X'), { username: 'commonly', agentAccessEnabled: true, globalAgentAccess: true }),
    });
    await Integration.create({
      podId: globalPod._id, scope: 'pod', status: 'connected', createdBy: admin, isActive: true,
      type: 'instagram',
      ...withConfig(integrationSecrets(s, 'GLOBAL_INSTAGRAM'), { username: 'commonly' }),
    });

    return {
      sentinels: s.all,
      identities: { owner: { user: owner }, member: { user: member }, stranger: { user: stranger }, admin: { user: admin } },
      podId: String(pod._id),
      telegramId: String(telegram._id),
      slackId: String(slack._id),
      discordId: String(discord._id),
    };
  },
  cases: [
    ...matrix('GET', '/api/integrations/catalog', () => '/api/integrations/catalog',
      { owner: 200, member: 200, stranger: 200, admin: 200 }),
    ...matrix('GET', '/api/integrations/:podId', (ctx) => `/api/integrations/${ctx.podId}`,
      { owner: 200, member: 200, stranger: 403, admin: 200 }),
    ...matrix('GET', '/api/integrations/admin/all', () => '/api/integrations/admin/all',
      { owner: 403, member: 403, stranger: 403, admin: 200 }),
    ...matrix('GET', '/api/integrations/user/all', () => '/api/integrations/user/all',
      { owner: 200, member: 200, stranger: 200, admin: 200 }),
    ...matrix('GET', '/api/integrations/:id/ingest-tokens', (ctx) => `/api/integrations/${ctx.telegramId}/ingest-tokens`,
      { owner: 200, member: 403, stranger: 403, admin: 200 }),
    ...matrix('GET', '/api/discord/binding/:podId', (ctx) => `/api/discord/binding/${ctx.podId}`,
      { owner: 200, member: 403, stranger: 403, admin: 200 }),
    ...matrix('GET', '/api/admin/integrations/global', () => '/api/admin/integrations/global',
      { owner: 403, member: 403, stranger: 403, admin: 200 }),
    // Owner-only via pod.createdBy (routes/integrations.ts); a member is 403.
    // Discord builds a DiscordService from the row; Slack answers inline.
    ...matrix('GET', '/api/integrations/:id/stats', (ctx) => `/api/integrations/${ctx.discordId}/stats`,
      { owner: 200, member: 403, stranger: 403, admin: 403 }, 'discord row'),
    ...matrix('GET', '/api/integrations/:id/stats', (ctx) => `/api/integrations/${ctx.slackId}/stats`,
      { owner: 200, member: 403, stranger: 403, admin: 403 }, 'slack row'),
    ...matrix('GET', '/api/integrations/:id/messages', (ctx) => `/api/integrations/${ctx.discordId}/messages`,
      { owner: 500, member: 403, stranger: 403, admin: 403 }, 'discord row'),
    ...matrix('GET', '/api/integrations/:id/messages', (ctx) => `/api/integrations/${ctx.slackId}/messages`,
      { owner: 200, member: 403, stranger: 403, admin: 403 }, 'slack row'),
  ],
};

// ---------------------------------------------------------------------------
// 2. Installables catalog (installableCatalogService .lean() path)
// ---------------------------------------------------------------------------
const installables = {
  name: 'installables',
  mount(app) {
    // eslint-disable-next-line global-require
    app.use('/api/installables', require('../../routes/installables'));
  },
  async seed() {
    const s = createSentinels();
    const Integration = model.Integration();
    const InstallableInstallation = model.InstallableInstallation();
    const owner = await seedUser(s, 'OWNER');
    const stranger = await seedUser(s, 'STRANGER');
    const admin = await seedUser(s, 'ADMIN', { role: 'admin' });
    const installation = (installableId, claimKey) => InstallableInstallation.create({
      installableId,
      installableVersion: '1.0.0',
      targetType: 'user',
      targetId: owner,
      scope: 'user',
      installedBy: owner,
      installSource: 'ui',
      status: 'active',
      claimId: s(claimKey),
    });
    const tgInstall = await installation('telegram', 'INST_TELEGRAM_INSTALLATION_CLAIMID');
    const slackInstall = await installation('slack', 'INST_SLACK_INSTALLATION_CLAIMID');
    await Integration.create({
      installationId: String(tgInstall._id), scope: 'user', type: 'telegram', status: 'connected', createdBy: owner, isActive: true,
      ...withConfig(integrationSecrets(s, 'INST_TELEGRAM', { connectCode: true }), { chatId: '-100' }),
    });
    await Integration.create({
      installationId: String(slackInstall._id), scope: 'user', type: 'slack', status: 'pending', createdBy: owner, isActive: true,
      ...withConfig(integrationSecrets(s, 'INST_SLACK', { connectCode: true }), {
        teamId: 'T1',
        pendingBind: {
          teamId: 'T1', slackUserId: 'U1', chatId: 'D1', expiresAt: FUTURE,
          botTokenRef: s('INST_SLACK_PENDINGBIND_BOTTOKENREF'),
        },
      }),
    });
    // The Tools list: the seeded GitHub tool Installable and the caller's own
    // github-app connection, which the catalog projects to connectionId/owner/repo.
    // eslint-disable-next-line global-require
    const { buildGithubToolInstallable } = require('../../services/installable/toolInstallables');
    await model.Installable().create(buildGithubToolInstallable());
    await Integration.create({
      installationId: 'install-leak-1', scope: 'user', type: 'github-app', status: 'connected', createdBy: owner, isActive: true,
      ...withConfig(integrationSecrets(s, 'INST_GITHUBAPP'), { installationId: 'install-leak-1', owner: 'octo', repo: 'demo' }),
    });
    return {
      sentinels: s.all,
      identities: { owner: { user: owner }, stranger: { user: stranger }, admin: { user: admin } },
    };
  },
  cases: [
    ...matrix('GET', '/api/installables', () => '/api/installables', { owner: 200, stranger: 200, admin: 200 }),
  ],
};

// ---------------------------------------------------------------------------
// 3. Users
// ---------------------------------------------------------------------------
const users = {
  name: 'users',
  mount(app) {
    /* eslint-disable global-require */
    app.use('/api/auth', require('../../routes/auth'));
    app.use('/api/users', require('../../routes/users'));
    app.use('/api/admin/users', require('../../routes/admin/users'));
    /* eslint-enable global-require */
  },
  async seed() {
    const s = createSentinels();
    const self = await seedUser(s, 'SELF');
    const stranger = await seedUser(s, 'STRANGER');
    const admin = await seedUser(s, 'ADMIN', { role: 'admin' });
    return {
      sentinels: s.all,
      identities: { self: { user: self }, stranger: { user: stranger }, admin: { user: admin } },
      selfId: String(self),
    };
  },
  cases: [
    // Routes whose subject is always the caller: only `self` is meaningful.
    ...matrix('GET', '/api/auth/user', () => '/api/auth/user', { self: 200 }),
    ...matrix('GET', '/api/auth/profile', () => '/api/auth/profile', { self: 200 }),
    // PUT returns the saved User too, so it must carry the same projection.
    ...matrix('PUT', '/api/auth/profile', () => '/api/auth/profile', { self: 200 }),
    ...matrix('GET', '/api/auth/api-token', () => '/api/auth/api-token', { self: 200 }),
    ...matrix('GET', '/api/users/profile', () => '/api/users/profile', { self: 200 }),
    // Routes with a subject: the seeded `self` user, viewed by each role.
    ...matrix('GET', '/api/users/:id', (ctx) => `/api/users/${ctx.selfId}`, { self: 200, stranger: 200, admin: 200 }),
    ...matrix('GET', '/api/admin/users', () => '/api/admin/users', { self: 403, stranger: 403, admin: 200 }),
  ],
};

// ---------------------------------------------------------------------------
// 4. Credentials
// ---------------------------------------------------------------------------
const credentials = {
  name: 'credentials',
  mount(app) {
    // eslint-disable-next-line global-require
    app.use('/api/credentials', require('../../routes/credentials'));
  },
  async seed() {
    const s = createSentinels();
    const AgentCredential = model.AgentCredential();
    const owner = await seedUser(s, 'OWNER');
    const stranger = await seedUser(s, 'STRANGER');
    const admin = await seedUser(s, 'ADMIN', { role: 'admin' });
    const daemon = await AgentCredential.create({
      tokenHash: s('OWNER_CRED_DAEMON_TOKENHASH'), kind: 'daemon', ownerUserId: owner, machineId: 'm-1', label: 'laptop',
    });
    await AgentCredential.create({
      tokenHash: s('OWNER_CRED_RUNTIME_TOKENHASH'), kind: 'runtime', ownerUserId: owner, parentId: daemon._id, label: 'seat',
    });
    await AgentCredential.create({ tokenHash: s('STRANGER_CRED_TOKENHASH'), kind: 'runtime', ownerUserId: stranger });
    await AgentCredential.create({ tokenHash: s('ADMIN_CRED_TOKENHASH'), kind: 'runtime', ownerUserId: admin });
    return {
      sentinels: s.all,
      identities: { owner: { user: owner }, stranger: { user: stranger }, admin: { user: admin } },
    };
  },
  cases: [
    ...matrix('GET', '/api/credentials', () => '/api/credentials', { owner: 200, stranger: 200, admin: 200 }),
  ],
};

// ---------------------------------------------------------------------------
// 5. Grants
// ---------------------------------------------------------------------------
const grants = {
  name: 'grants',
  mount(app) {
    // eslint-disable-next-line global-require
    const grantRoutes = require('../../routes/grants');
    app.use('/api/pods', grantRoutes.podGrantsRouter);
    app.use('/api/grants', grantRoutes);
  },
  async seed() {
    const s = createSentinels();
    const owner = await seedUser(s, 'OWNER'); // installed the App: every grant's granter
    const member = await seedUser(s, 'MEMBER');
    const stranger = await seedUser(s, 'STRANGER');
    const admin = await seedUser(s, 'ADMIN', { role: 'admin' });
    const seat = await seedAgentUser(s, 'SEAT', 'leakseat');
    const pod = await model.Pod().create({ name: 'Grant Room', createdBy: owner, members: [owner, member, seat] });
    const connectionId = s('GRANT_CONNECTIONID');
    await model.Integration().create({
      installationId: connectionId, scope: 'user', type: 'github-app', status: 'connected', createdBy: owner, isActive: true,
      ...withConfig(integrationSecrets(s, 'GRANT_CONNECTION'), { installationId: 'install-1', owner: 'octo', repo: 'demo' }),
    });
    const RoomGrant = model.RoomGrant();
    const shared = {
      connectionId,
      installationId: 'install-1',
      tools: ['github.list_issues'],
      writeMode: 'read',
      budget: { calls: 10, windowMs: 60000 },
      expiresAt: FUTURE,
      brokerId: s('GRANT_BROKERID'),
    };
    await RoomGrant.create({
      ...shared,
      grantId: 'grant_pod_leak',
      target: { kind: 'pod', id: String(pod._id) },
      // A departed agent still in the snapshot: only the effective audience may go out.
      audience: [String(seat), s('GRANT_POD_RAW_AUDIENCE')],
    });
    // A seat grant's audience is exactly [seat]: POST /api/grants refuses any
    // other seat audience (routes/grants.ts, 'seat audience must be the target
    // seat'), so a second entry here would seed an unreachable state.
    await RoomGrant.create({
      ...shared,
      grantId: 'grant_seat_leak',
      target: { kind: 'seat', id: String(seat) },
      audience: [String(seat)],
    });
    s.all[TOOLCALL_ARGS_SENTINEL_KEY] = sentinelValue(TOOLCALL_ARGS_SENTINEL_KEY);
    return {
      sentinels: s.all,
      boundarySentinels: [TOOLCALL_ARGS_SENTINEL_KEY], // lives in the ToolCall mock, not Mongo
      identities: {
        owner: { user: owner }, member: { user: member }, stranger: { user: stranger }, admin: { user: admin }, seat: { agent: seat },
      },
      podId: String(pod._id),
    };
  },
  cases: [
    ...matrix('GET', '/api/grants/:grantId', () => '/api/grants/grant_pod_leak',
      { owner: 200, member: 200, stranger: 403, admin: 200, seat: 200 }, 'pod grant'),
    ...matrix('GET', '/api/grants/:grantId', () => '/api/grants/grant_seat_leak',
      { owner: 200, member: 403, stranger: 403, admin: 403, seat: 200 }, 'seat grant'),
    ...matrix('GET', '/api/grants/:grantId/calls', () => '/api/grants/grant_pod_leak/calls',
      { owner: 200, member: 200, stranger: 403, admin: 200, seat: 200 }, 'pod grant'),
    ...matrix('GET', '/api/grants/:grantId/calls', () => '/api/grants/grant_seat_leak/calls',
      { owner: 200, member: 403, stranger: 403, admin: 403, seat: 200 }, 'seat grant'),
    ...matrix('GET', '/api/pods/:podId/grants', (ctx) => `/api/pods/${ctx.podId}/grants`,
      { owner: 200, member: 200, stranger: 403, admin: 200 }),
  ],
};

// ---------------------------------------------------------------------------
// 6. Agent runtime integrations
// ---------------------------------------------------------------------------
const agentRuntime = {
  name: 'agentRuntime',
  mount(app) {
    // eslint-disable-next-line global-require
    app.use('/api/agents/runtime', require('../../routes/agentsRuntime'));
  },
  async seed() {
    const s = createSentinels();
    const Pod = model.Pod();
    const Integration = model.Integration();
    const AgentInstallation = model.AgentInstallation();
    const owner = await seedUser(s, 'OWNER');
    const agent = await seedAgentUser(s, 'AGENT', 'leakagent');
    const unscoped = await seedAgentUser(s, 'AGENT_UNSCOPED', 'leaknoscope');
    const outsider = await seedAgentUser(s, 'AGENT_OUTSIDER', 'leakoutsider');
    const pod = await Pod.create({ name: 'Runtime Room', createdBy: owner, members: [owner, agent, unscoped] });
    const otherPod = await Pod.create({ name: 'Elsewhere', createdBy: owner, members: [owner, outsider] });
    const install = (agentName, podId, scopes) => AgentInstallation.create({
      agentName, podId, version: '1.0.0', installedBy: owner, instanceId: 'default', status: 'active', scopes,
    });
    await install('leakagent', pod._id, ['integration:read']);
    await install('leaknoscope', pod._id, ['context:read']);
    await install('leakoutsider', otherPod._id, ['integration:read']);
    const base = { scope: 'pod', status: 'connected', createdBy: owner, isActive: true };
    await Integration.create({
      ...base, podId: pod._id, type: 'telegram',
      ...withConfig(integrationSecrets(s, 'RT_TELEGRAM'), { chatId: '-100', agentAccessEnabled: true }),
    });
    await Integration.create({
      ...base, podId: pod._id, type: 'x',
      ...withConfig(integrationSecrets(s, 'RT_X'), { username: 'ops', agentAccessEnabled: true }),
    });
    // Agent access OFF: must never reach an agent, scoped or not.
    await Integration.create({
      ...base, podId: pod._id, type: 'slack',
      ...withConfig(integrationSecrets(s, 'RT_SLACK_NOACCESS'), { teamId: 'T1', agentAccessEnabled: false }),
    });
    // A global integration in another pod, shared to every agent with integration:read.
    await Integration.create({
      ...base, podId: otherPod._id, type: 'x',
      ...withConfig(integrationSecrets(s, 'RT_GLOBAL_X'), { username: 'commonly', agentAccessEnabled: true, globalAgentAccess: true }),
    });
    return {
      sentinels: s.all,
      identities: { agent: { agent }, 'agent-unscoped': { agent: unscoped }, 'agent-outsider': { agent: outsider } },
      podId: String(pod._id),
    };
  },
  cases: [
    ...matrix('GET', '/api/agents/runtime/pods/:podId/integrations', (ctx) => `/api/agents/runtime/pods/${ctx.podId}/integrations`,
      { agent: 200, 'agent-unscoped': 403, 'agent-outsider': 403 }),
  ],
};

/**
 * An AgentInstallation config carrying every runtime secret the install and
 * provision paths persist: runtime.webhookSecret (read back by
 * agentEventService.deliverEventViaWebhook to sign deliveries), and the
 * authProfiles / skillEnv blocks routes/registry/install.ts + provision.ts
 * normalize and store.
 */
const installationConfigSecrets = (s, prefix) => ({
  presetId: 'leak-preset',
  heartbeat: { everyMinutes: 30 },
  runtime: {
    runtimeType: 'webhook',
    status: 'provisioned',
    accountId: 'acct-1',
    webhookUrl: 'https://agent.example.test/events',
    webhookSecret: s(`${prefix}_RUNTIME_WEBHOOKSECRET`),
    authProfiles: {
      'openai:default': { type: 'api_key', provider: 'openai', key: s(`${prefix}_RUNTIME_AUTHPROFILE_KEY`) },
    },
    skillEnv: { github: { GITHUB_TOKEN: s(`${prefix}_RUNTIME_SKILLENV_VALUE`) } },
  },
});

// ---------------------------------------------------------------------------
// 7. Registry: agent tokens + installed pod agent (routes/registry/agent-tokens.ts, pod-agents.ts)
// ---------------------------------------------------------------------------
const REG_AGENT = 'leakregagent';
const registry = {
  name: 'registry',
  mount(app) {
    // eslint-disable-next-line global-require
    app.use('/api/registry', require('../../routes/registry'));
  },
  async seed() {
    const s = createSentinels();
    const owner = await seedUser(s, 'OWNER');
    const member = await seedUser(s, 'MEMBER');
    const stranger = await seedUser(s, 'STRANGER');
    const admin = await seedUser(s, 'ADMIN', { role: 'admin' });
    const pod = await model.Pod().create({ name: 'Registry Room', createdBy: owner, members: [owner, member] });
    // agent-tokens looks the agent up by buildAgentUsername(type, 'default') === type.
    // seedUser gives it an apiToken (read by GET user-token via +apiToken) and an
    // agentRuntimeTokens[].tokenHash (read by GET runtime-tokens).
    await seedUser(s, 'REG_AGENT', {
      username: REG_AGENT,
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: REG_AGENT, instanceId: 'default', displayName: 'Reg Agent' },
    });
    await model.AgentInstallation().create({
      agentName: REG_AGENT,
      podId: pod._id,
      version: '1.0.0',
      installedBy: owner,
      instanceId: 'default',
      displayName: 'Reg Agent',
      status: 'active',
      scopes: ['context:read'],
      runtimeTokens: [{ tokenHash: s('REG_INSTALL_RUNTIMETOKEN_HASH'), label: 'rt' }],
      config: installationConfigSecrets(s, 'REG_INSTALL'),
    });
    return {
      sentinels: s.all,
      identities: { owner: { user: owner }, member: { user: member }, stranger: { user: stranger }, admin: { user: admin } },
      podId: String(pod._id),
    };
  },
  cases: [
    ...matrix('GET', '/api/registry/pods/:podId/agents/:name', (ctx) => `/api/registry/pods/${ctx.podId}/agents/${REG_AGENT}`,
      { owner: 200, member: 200, stranger: 403, admin: 403 }),
    ...matrix('GET', '/api/registry/pods/:podId/agents/:name/runtime-tokens',
      (ctx) => `/api/registry/pods/${ctx.podId}/agents/${REG_AGENT}/runtime-tokens`,
      { owner: 200, member: 200, stranger: 403, admin: 403 }),
    ...matrix('GET', '/api/registry/pods/:podId/agents/:name/user-token',
      (ctx) => `/api/registry/pods/${ctx.podId}/agents/${REG_AGENT}/user-token`,
      { owner: 200, member: 200, stranger: 403, admin: 403 }),
  ],
};

// ---------------------------------------------------------------------------
// 8. Machines + gateways (routes/machines.ts, routes/gateways.ts)
// ---------------------------------------------------------------------------
const machines = {
  name: 'machines',
  mount(app) {
    /* eslint-disable global-require */
    app.use('/api/machines', require('../../routes/machines'));
    app.use('/api/gateways', require('../../routes/gateways'));
    /* eslint-enable global-require */
  },
  async seed() {
    const s = createSentinels();
    // eslint-disable-next-line global-require
    const { hash } = require('../../utils/secret');
    const owner = await seedUser(s, 'OWNER');
    const stranger = await seedUser(s, 'STRANGER');
    const admin = await seedUser(s, 'ADMIN', { role: 'admin' });
    // Machine has no secret field of its own; its bearer is a daemon
    // AgentCredential. The raw cm_daemon_ bearer never reaches the store (a
    // boundary sentinel); its sha256 is the stored tokenHash, registered as a
    // sentinel by value so a response carrying the hash is caught too.
    const daemonBearer = async (prefix, ownerUserId, machineId) => {
      const raw = `cm_daemon_${sentinelValue(`${prefix}_DAEMON_BEARER`)}`;
      s.all[`${prefix}_DAEMON_BEARER`] = raw;
      s.all[`${prefix}_DAEMON_TOKENHASH`] = hash(raw);
      await model.AgentCredential().create({
        tokenHash: hash(raw), kind: 'daemon', ownerUserId, machineId, scopes: ['machine:read', 'machine:heartbeat'],
      });
      return raw;
    };
    const Machine = model.Machine();
    await Machine.create({ ownerUserId: owner, machineId: 'machine-owner-1', name: 'owner-laptop', lastSeenAt: new Date(), status: 'online' });
    await Machine.create({ ownerUserId: stranger, machineId: 'machine-stranger-1', name: 'stranger-laptop' });
    const ownerBearer = await daemonBearer('MACHINE_OWNER', owner, 'machine-owner-1');
    await daemonBearer('MACHINE_STRANGER', stranger, 'machine-stranger-1');
    const Gateway = model.Gateway();
    await Gateway.create({ name: 'Local Gateway', slug: 'default', mode: 'local', createdBy: admin });
    // Rows written before the route stopped storing it can still carry
    // metadata.gatewayToken; no read may return it.
    await Gateway.create({
      name: 'Leak Gateway', slug: 'leak-gw', mode: 'k8s', baseUrl: 'http://gw.example.test', createdBy: admin,
      metadata: { namespace: 'ns', gatewayToken: s('GATEWAY_METADATA_GATEWAYTOKEN') },
    });
    return {
      sentinels: s.all,
      boundarySentinels: ['MACHINE_OWNER_DAEMON_BEARER', 'MACHINE_STRANGER_DAEMON_BEARER'],
      identities: {
        owner: { user: owner }, stranger: { user: stranger }, admin: { user: admin }, machine: { bearer: ownerBearer },
      },
    };
  },
  cases: [
    ...matrix('GET', '/api/machines', () => '/api/machines', { owner: 200, stranger: 200, admin: 200 }),
    // daemonAuth('machine:read') is REAL here: the machine role sends its cm_daemon_ bearer.
    ...matrix('GET', '/api/machines/me', () => '/api/machines/me', { owner: 401, stranger: 401, admin: 401, machine: 200 }),
    ...matrix('GET', '/api/gateways', () => '/api/gateways', { owner: 403, stranger: 403, admin: 200 }),
  ],
};

// ---------------------------------------------------------------------------
// 9. Public agent profile (routes/agentProfile.ts: no auth; selects agentConfig)
// ---------------------------------------------------------------------------
const PROFILE_AGENT = 'leakprofile';
const agentProfile = {
  name: 'agentProfile',
  mount(app) {
    // eslint-disable-next-line global-require
    app.use('/api/agent-profile', require('../../routes/agentProfile'));
  },
  async seed() {
    const s = createSentinels();
    const owner = await seedUser(s, 'OWNER');
    const stranger = await seedUser(s, 'STRANGER');
    const agent = await seedUser(s, 'PROFILE_AGENT', {
      isBot: true,
      botType: 'agent',
      botMetadata: { agentName: PROFILE_AGENT, instanceId: 'default', displayName: 'Profile Agent', description: 'Answers questions.' },
    });
    // agentConfig is the one config block the route selects; systemPrompt is its private field.
    await model.User().collection.updateOne({ _id: agent }, {
      $set: {
        agentConfig: {
          personality: { tone: 'friendly', interests: ['ops'], behavior: 'reactive', responseStyle: 'concise' },
          systemPrompt: s('PROFILE_AGENT_SYSTEMPROMPT'),
          capabilities: ['chat'],
        },
      },
    });
    const pod = await model.Pod().create({ name: 'Private Room', createdBy: owner, members: [owner, agent] });
    await model.AgentInstallation().create({
      agentName: PROFILE_AGENT,
      podId: pod._id,
      version: '1.0.0',
      installedBy: owner,
      instanceId: 'default',
      displayName: 'Profile Agent',
      status: 'active',
      scopes: ['context:read'],
      runtimeTokens: [{ tokenHash: s('PROFILE_INSTALL_RUNTIMETOKEN_HASH'), label: 'rt' }],
      config: installationConfigSecrets(s, 'PROFILE_INSTALL'),
    });
    return {
      sentinels: s.all,
      identities: { stranger: { user: stranger }, anonymous: {} },
    };
  },
  cases: [
    ...matrix('GET', '/api/agent-profile/:agentName/:instanceId?', () => `/api/agent-profile/${PROFILE_AGENT}/default`,
      { stranger: 200, anonymous: 200 }),
  ],
};

const SUITES = {
  integrations, installables, users, credentials, grants, agentRuntime, registry, machines, agentProfile,
};

module.exports = { SUITES, ...SUITES };
