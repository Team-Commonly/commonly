/**
 * ADR-018 D8.1: the first agent a person brings into a pod wakes on every human
 * message by default; later agents stay mention-only. Run against a real Mongo
 * (mongodb-memory-server) through the AgentInstallation model, so the "is there
 * already an ambient answerer" query is the one that ships.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let AgentInstallation;
let firstAgentWakeDefault;
let isPersonBroughtAgent;

const POD = new mongoose.Types.ObjectId();
const NOW = new Date('2026-10-21T09:00:00Z');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  ({ AgentInstallation } = require('../../../models/AgentRegistry'));
  ({ firstAgentWakeDefault, isPersonBroughtAgent } = require('../../../services/wakeDefaultService'));
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => { await AgentInstallation.collection.deleteMany({}); });

const seed = (agentName, config, status = 'active', podId = POD) => AgentInstallation.collection.insertOne({
  agentName, instanceId: 'default', podId, status, version: '1.0.0', installedBy: new mongoose.Types.ObjectId(), config,
});

const OWN_AGENT = { runtime: { runtimeType: 'webhook', host: 'byo' } };
const ON_COMPUTER = { runtime: { runtimeType: 'wrapper' } };
const decide = (agentName, installConfig) => firstAgentWakeDefault({
  podId: POD, agentName, instanceId: 'default', installConfig, now: NOW,
});

describe('the first agent a person brings into a pod wakes on every human message', () => {
  test('a first own agent, beside a Scout that wakes on everything, defaults on: human-only, no board wakes', async () => {
    await seed('scout', { wakeOnMessage: { enabled: true } });
    expect(await decide('sam-claude', OWN_AGENT)).toEqual({
      wakeOnMessage: {
        enabled: true, humanOnly: true, reason: 'first-agent-default', defaultedAt: NOW.toISOString(),
      },
      boardWake: { enabled: false },
    });
  });

  test('a first agent placed on the person\'s computer defaults on too', async () => {
    expect((await decide('sam-local', ON_COMPUTER)).wakeOnMessage.enabled).toBe(true);
  });

  test('an agent added when another non-Scout agent already wakes on everything stays mention-only', async () => {
    await seed('sam-claude', { wakeOnMessage: { enabled: true, humanOnly: true } });
    expect(await decide('sam-codex', OWN_AGENT)).toBeNull();
  });

  test('agents that are mention-only, uninstalled, or in another pod don\'t count as an answerer', async () => {
    await seed('old-agent', {});
    await seed('gone-agent', { wakeOnMessage: { enabled: true } }, 'uninstalled');
    await seed('elsewhere', { wakeOnMessage: { enabled: true } }, 'active', new mongoose.Types.ObjectId());
    expect(await decide('sam-claude', OWN_AGENT)).not.toBeNull();
  });

  test('the agent\'s own row doesn\'t count against itself', async () => {
    await seed('sam-claude', { wakeOnMessage: { enabled: true } });
    expect(await decide('sam-claude', OWN_AGENT)).not.toBeNull();
  });

  test('an explicit wakeOnMessage in the request wins, either way', async () => {
    expect(await decide('sam-claude', { ...OWN_AGENT, wakeOnMessage: { enabled: false } })).toBeNull();
    expect(await decide('sam-claude', { ...OWN_AGENT, wakeOnMessage: { enabled: true } })).toBeNull();
  });

  test('an explicit boardWake in the request is left alone', async () => {
    const patch = await decide('sam-claude', { ...OWN_AGENT, boardWake: { enabled: true } });
    expect(patch.wakeOnMessage.enabled).toBe(true);
    expect(patch).not.toHaveProperty('boardWake');
  });

  test('Scout, hosted agents, first-party apps, CLI attaches and push webhooks are untouched', async () => {
    expect(await decide('scout', OWN_AGENT)).toBeNull();
    for (const runtime of [
      { runtimeType: 'hosted' },
      { runtimeType: 'native' },
      { runtimeType: 'claude-code', host: 'byo' },
      { runtimeType: 'codex', host: 'byo' },
      { runtimeType: 'webhook', host: 'byo', webhookUrl: 'https://example.test/hook' },
      { runtimeType: 'webhook' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await decide('sam-agent', { runtime })).toBeNull();
    }
  });

  test('isPersonBroughtAgent reads the normalized runtime block', () => {
    expect(isPersonBroughtAgent({ runtime: { runtimeType: ' Wrapper ' } })).toBe(true);
    expect(isPersonBroughtAgent({})).toBe(false);
  });
});
