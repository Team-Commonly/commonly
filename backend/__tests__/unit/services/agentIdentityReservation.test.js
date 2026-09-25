// The namespace a human registration may not take (TASK-133 b).
//
// Two disjoint closures, and the difference is the point: (a) refuses to ADOPT
// a row that carries no agent marker, and (b) refuses to CREATE one under a name
// or address an install derives. Neither covers the other — a squatted address
// row is agent-marked, so (a) adopts it; a plain name is not, so (b)'s name
// rules would never see it (`openclaw-pixel` registers today, by design).
//
// The predictors here are the ones both registration paths call:
// `controllers/authController.register` (password) and
// `controllers/oauthController.generateUsername` (provider).

const AgentIdentityService = require('../../../services/agentIdentityService');
const { AgentRegistry } = require('../../../models/AgentRegistry');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('agent identity names reserved for agents (TASK-133 b)', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
  });

  it('reserves every AGENT_TYPES key, judged on the normalized form', () => {
    const types = Object.keys(AgentIdentityService.getAgentTypes());
    // A curated list: the assertion is exact-length rather than a floor, so a
    // taxonomy that shrinks silently fails here.
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(AgentIdentityService.isReservedAgentUsername(type)).toBe(true);
    }
    // Registration takes the username verbatim (trim only) and the User index is
    // case-insensitive, so the reservation has to be too.
    expect(AgentIdentityService.isReservedAgentUsername('  Claude-Code ')).toBe(true);
  });

  it('does not reserve an instance-suffixed principal (wren 73988)', () => {
    // The shape rule was ruled out: these are legitimate human handles, and the
    // row they create carries no agent marker, so (a) refuses the adoption
    // rather than converting a person.
    expect(AgentIdentityService.isReservedAgentUsername('openclaw-pixel')).toBe(false);
    expect(AgentIdentityService.isReservedAgentUsername('pixel')).toBe(false);
    expect(AgentIdentityService.isReservedAgentUsername('')).toBe(false);
    expect(AgentIdentityService.isReservedAgentUsername(undefined)).toBe(false);
  });

  it('reserves the derived address domain and only that domain', () => {
    expect(AgentIdentityService.isReservedAgentEmail('claude-code@agents.commonly.local')).toBe(true);
    expect(AgentIdentityService.isReservedAgentEmail('AGENTS@AGENTS.COMMONLY.LOCAL')).toBe(true);
    // A suffix check, not a `includes` — a lookalike domain is somebody else's.
    expect(AgentIdentityService.isReservedAgentEmail('someone@agents.commonly.local.evil.com')).toBe(false);
    expect(AgentIdentityService.isReservedAgentEmail('someone@example.com')).toBe(false);
    expect(AgentIdentityService.isReservedAgentEmail(undefined)).toBe(false);
  });

  it('reserves a name an AgentRegistry row claims', async () => {
    await AgentRegistry.create({
      agentName: 'pixel-helper',
      displayName: 'Pixel Helper',
      description: 'a pod helper',
      manifest: { name: 'pixel-helper', version: '1.0.0' },
    });

    expect(await AgentIdentityService.resolveAccountNameConflict({ username: 'pixel-helper' }))
      .toBe('agent_username_reserved');
    expect(await AgentIdentityService.resolveAccountNameConflict({ username: 'Pixel-Helper' }))
      .toBe('agent_username_reserved');
    // A name that merely starts the same is not the same name.
    expect(await AgentIdentityService.resolveAccountNameConflict({ username: 'pixel-helper-2' }))
      .toBeNull();
  });

  it('matches a scoped registry row as written, and pins the normalized-form limit', async () => {
    await AgentRegistry.create({
      agentName: '@acme/scout',
      displayName: 'Scout',
      description: 'scoped',
      manifest: { name: '@acme/scout', version: '1.0.0' },
    });

    expect(await AgentIdentityService.resolveAccountNameConflict({ username: '@acme/scout' }))
      .toBe('agent_username_reserved');

    // DOCUMENTED LIMIT, not a hole. The row is matched by exact name, and this
    // candidate's normalized form (`acmescout`) is what an install derives from
    // `@acme/scout` — but the stored row keeps its scope, so an exact match
    // cannot see the collision. The row such a registration creates carries no
    // agent marker, so it rides the (a) refusal: a refused install, never a
    // flip. Pinned here so the day this is tightened, this test says what
    // changed.
    expect(await AgentIdentityService.resolveAccountNameConflict({ username: 'acmescout' }))
      .toBeNull();
  });

  it('prefers the address refusal, and never fires for an ordinary person', async () => {
    expect(await AgentIdentityService.resolveAccountNameConflict({
      username: 'wren',
      email: 'wren@agents.commonly.local',
    })).toBe('agent_email_reserved');

    expect(await AgentIdentityService.resolveAccountNameConflict({
      username: 'wren',
      email: 'wren@example.com',
    })).toBeNull();
  });
});
