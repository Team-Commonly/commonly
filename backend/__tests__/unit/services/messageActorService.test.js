// F655: who an agent's message is accountable to. The owner is whose agent it
// is (agentOwnerService). The person it acts on behalf of comes only from the
// run's trigger: the message a native run claimed and is answering
// (answeringMessageId, set by the server), and only when a person wrote it in
// this pod. A reply edge is the agent's own choice, so it never names anyone.
// A run no person started records no one, and the owner is never filled in as
// that person.
const mongoose = require('mongoose');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');

const mockFindAuthor = jest.fn();
const mockResolveId = jest.fn();
jest.mock('../../../models/pg/Message', () => ({
  findAuthor: (...args) => mockFindAuthor(...args),
  resolveId: (...args) => mockResolveId(...args),
}));

const { resolveMessageActor } = require('../../../services/messageActorService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('resolveMessageActor', () => {
  let lily;
  let sam;
  let nova;
  let kai;
  let podId;

  const make = (name, extra = {}) => User.create({
    username: `${name}-${new mongoose.Types.ObjectId()}`,
    email: `${name}-${new mongoose.Types.ObjectId()}@test.com`,
    password: 'Password123!',
    ...extra,
  });
  const bot = (agentName, instanceId) => make(`${agentName}-${instanceId}`, {
    isBot: true, botType: 'agent', botMetadata: { agentName, instanceId },
  });

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    mockFindAuthor.mockReset();
    mockResolveId.mockReset();
    // A numeric PG id resolves to itself, as the model does.
    mockResolveId.mockImplementation(async (id) => (/^\d+$/.test(String(id)) ? String(id) : null));
    podId = new mongoose.Types.ObjectId();
    lily = await make('lily');
    sam = await make('sam');
    nova = await bot('openclaw', 'nova');
    kai = await bot('claude-code', 'kai');
    await AgentInstallation.create({
      agentName: 'openclaw', instanceId: 'nova', podId, installedBy: lily._id, version: '1.0.0',
    });
  });

  const authoredBy = (map) => mockFindAuthor.mockImplementation(async (id) => (
    map[id] ? { userId: String(map[id]), podId: String(podId) } : null
  ));

  it('names the owner and the person whose claimed message the run is answering', async () => {
    authoredBy({ 101: sam._id });
    expect(await resolveMessageActor({ podId, agentUser: nova, answeringMessageId: '101' }))
      .toEqual({ ownerUserId: String(lily._id), onBehalfOfUserId: String(sam._id) });
  });

  it('a reply edge never sets onBehalfOf: the agent picks what it replies to', async () => {
    authoredBy({ 202: sam._id });
    expect(await resolveMessageActor({ podId, agentUser: nova, replyToMessageId: '202' }))
      .toEqual({ ownerUserId: String(lily._id) });
    expect(mockFindAuthor).not.toHaveBeenCalled();
  });

  it('a native run with no claimed wake message records no onBehalfOf, even replying to a person', async () => {
    // A heartbeat or schedule that replies to an old message a person wrote.
    authoredBy({ 202: sam._id });
    expect(await resolveMessageActor({
      podId, agentUser: nova, answeringMessageId: undefined, replyToMessageId: '202',
    })).toEqual({ ownerUserId: String(lily._id) });
  });

  it('records the owner as the person asked when the owner asked', async () => {
    authoredBy({ 101: lily._id });
    expect(await resolveMessageActor({ podId, agentUser: nova, answeringMessageId: '101' }))
      .toEqual({ ownerUserId: String(lily._id), onBehalfOfUserId: String(lily._id) });
  });

  it('records no one on behalf of when no person started the run', async () => {
    expect(await resolveMessageActor({ podId, agentUser: nova }))
      .toEqual({ ownerUserId: String(lily._id) });
    expect(mockFindAuthor).not.toHaveBeenCalled();
  });

  it('an agent asking is not a person asking', async () => {
    authoredBy({ 101: kai._id });
    expect(await resolveMessageActor({ podId, agentUser: nova, answeringMessageId: '101' }))
      .toEqual({ ownerUserId: String(lily._id) });
  });

  it('ignores a message in another pod', async () => {
    mockFindAuthor.mockResolvedValue({ userId: String(sam._id), podId: String(new mongoose.Types.ObjectId()) });
    expect(await resolveMessageActor({ podId, agentUser: nova, answeringMessageId: '101' }))
      .toEqual({ ownerUserId: String(lily._id) });
  });

  it('resolves a legacy Mongo id for the claimed message before looking up its author', async () => {
    const legacy = '6a0da39bae757028b39f87a6';
    mockResolveId.mockImplementation(async (id) => (id === legacy ? '101' : null));
    authoredBy({ 101: sam._id });
    expect(await resolveMessageActor({ podId, agentUser: nova, answeringMessageId: legacy }))
      .toEqual({ ownerUserId: String(lily._id), onBehalfOfUserId: String(sam._id) });
    expect(mockFindAuthor).toHaveBeenCalledWith('101');
  });

  it('finds the installation by the declared agent name and instance before the identity\'s own', async () => {
    const renamed = await make('renamed', {
      isBot: true, botType: 'agent', botMetadata: { agentName: 'stale-name', instanceId: 'old' },
    });
    expect(await resolveMessageActor({
      podId, agentUser: renamed, agentName: 'OpenClaw', instanceId: 'nova',
    })).toEqual({ ownerUserId: String(lily._id) });
  });

  it('a kernel line speaks for Commonly, not the agent, and records nothing', async () => {
    authoredBy({ 101: sam._id });
    expect(await resolveMessageActor({
      podId, agentUser: nova, answeringMessageId: '101', authorKind: 'kernel',
    })).toBeNull();
  });

  it('an agent with no human owner still records who asked', async () => {
    authoredBy({ 101: sam._id });
    expect(await resolveMessageActor({ podId, agentUser: kai, answeringMessageId: '101' }))
      .toEqual({ onBehalfOfUserId: String(sam._id) });
  });

  it('a failed asker lookup still records the owner', async () => {
    mockFindAuthor.mockRejectedValue(new Error('pg down'));
    expect(await resolveMessageActor({ podId, agentUser: nova, answeringMessageId: '101' }))
      .toEqual({ ownerUserId: String(lily._id) });
  });

  it('a bot row posting with a user token records its owner and no one it acted for', async () => {
    const { actorForBotCaller } = require('../../../services/messageActorService');
    expect(await actorForBotCaller(podId, nova._id, {
      username: nova.username, botMetadata: { agentName: 'openclaw', instanceId: 'nova' },
    })).toEqual({ ownerUserId: String(lily._id) });
    expect(await actorForBotCaller(podId, sam._id, null)).toBeNull();
    expect(mockFindAuthor).not.toHaveBeenCalled();
  });

  it('never throws: with both lookups failing it records nothing', async () => {
    mockFindAuthor.mockRejectedValue(new Error('pg down'));
    expect(await resolveMessageActor({ podId, agentUser: kai, answeringMessageId: '101' })).toBeNull();
  });
});
