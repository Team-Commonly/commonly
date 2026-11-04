// TASK-774: the roster's newest-heartbeat and newest-run reads, one index seek
// per install. These pin the answers; the real-Mongo cost is pinned in
// __tests__/service/podAgents.rosterLatency.realDb.test.js.
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const AgentEvent = require('../../../models/AgentEvent');
const AgentRun = require('../../../models/AgentRun');
const { newestPerInstall, installKey } = require('../../../services/newestPerInstall');
const { lastHeartbeatPerInstall, collectPodAgentActivity } = require('../../../services/agentStateService');

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(clearMongoDb);

const POD = new mongoose.Types.ObjectId();
const OTHER_POD = new mongoose.Types.ObjectId();
const at = (iso) => new Date(iso);
const event = (agentName, instanceId, type, status, createdAt, podId = POD) => ({
  agentName, instanceId, podId, type, status, deliveryMode: 'wake', createdAt, updatedAt: createdAt,
});

describe('lastHeartbeatPerInstall', () => {
  test('the newest delivered heartbeat per install, from any pod', async () => {
    await AgentEvent.collection.insertMany([
      event('rivet', 'default', 'heartbeat', 'delivered', at('2026-11-01T00:00:00Z')),
      event('rivet', 'default', 'heartbeat', 'delivered', at('2026-11-03T00:00:00Z'), OTHER_POD),
      // Newer, but not a delivered heartbeat: never the answer.
      event('rivet', 'default', 'chat.mention', 'delivered', at('2026-11-04T00:00:00Z')),
      event('rivet', 'default', 'heartbeat', 'acked', at('2026-11-04T01:00:00Z')),
      event('rivet', 'night', 'heartbeat', 'delivered', at('2026-11-02T00:00:00Z')),
      // Not an install below: the cross product of names and instances.
      event('kite', 'night', 'heartbeat', 'delivered', at('2026-11-04T02:00:00Z')),
    ]);
    const map = await lastHeartbeatPerInstall([
      { agentName: 'rivet' }, { agentName: 'rivet', instanceId: 'night' }, { agentName: 'kite', instanceId: 'default' },
    ]);
    expect(Object.fromEntries([...map].map(([k, v]) => [k, v.toISOString()]))).toEqual({
      'rivet:default': '2026-11-03T00:00:00.000Z',
      'rivet:night': '2026-11-02T00:00:00.000Z',
    });
  });

  test('no installs, no query', async () => {
    const spy = jest.spyOn(AgentEvent, 'aggregate');
    await expect(lastHeartbeatPerInstall([])).resolves.toEqual(new Map());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('newestPerInstall', () => {
  test('a repeated install is read once, and more than 50 installs still all answer', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `seat-${i}`);
    await AgentEvent.collection.insertMany(names.map((n, i) => (
      event(n, 'default', 'heartbeat', 'delivered', new Date(Date.UTC(2026, 10, 1) + i * 1000))
    )));
    const spy = jest.spyOn(AgentEvent, 'aggregate');
    const map = await newestPerInstall(AgentEvent, [...names, 'seat-0'].map((agentName) => ({ agentName })), {
      match: ({ agentName, instanceId }) => ({
        agentName, instanceId, type: 'heartbeat', status: 'delivered', 
      }),
      field: 'createdAt',
    });
    expect(map.size).toBe(120);
    expect(map.get(installKey('seat-119')).getTime()).toBe(Date.UTC(2026, 10, 1) + 119 * 1000);
    expect(spy).toHaveBeenCalledTimes(3); // 50 + 50 + 20
  });
});

describe('collectPodAgentActivity reads the newest run in this pod', () => {
  const run = (agentName, instanceId, startedAt, podId = POD) => ({
    podId,
    agentName,
    ...(instanceId === undefined ? {} : { instanceId }),
    trigger: 'mention',
    status: 'succeeded',
    model: 'm',
    startedAt,
    createdAt: startedAt,
  });

  test('per install, this pod only; a run with no instanceId counts for default', async () => {
    await AgentRun.collection.insertMany([
      run('guide', 'default', at('2026-11-01T00:00:00Z')),
      run('guide', undefined, at('2026-11-02T00:00:00Z')),
      run('guide', 'default', at('2026-11-04T00:00:00Z'), OTHER_POD),
      run('guide', 'second', at('2026-11-03T00:00:00Z')),
    ]);
    const map = await collectPodAgentActivity(String(POD), [
      { agentName: 'guide', instanceId: 'default' }, { agentName: 'guide', instanceId: 'second' },
    ]);
    expect(map.get('guide:default').toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(map.get('guide:second').toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  test('a run stored with an empty instanceId counts for default too', async () => {
    await AgentRun.collection.insertMany([
      run('guide', 'default', at('2026-11-01T00:00:00Z')),
      run('guide', '', at('2026-11-02T06:00:00Z')),
    ]);
    const map = await collectPodAgentActivity(String(POD), [{ agentName: 'guide' }]);
    expect(map.get('guide:default').toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });
});
