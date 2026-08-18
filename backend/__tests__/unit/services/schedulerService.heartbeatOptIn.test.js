/**
 * Heartbeat dispatch is opt-in (#832 follow-up).
 *
 * The guard used to be `enabled === false`, which meant an install that had
 * never expressed an opinion still woke on a timer. Measured on production
 * 2026-08-04: 166 of 245 active installations, across 48 distinct owners, were
 * ticking hourly on that default alone — each spending its own owner's model
 * quota to run a heartbeat that has no content contract behind it (#800).
 *
 * The distinction this file defends is `undefined` vs `true`. A test that only
 * covered `false` would have passed against the old behaviour too.
 */

const fs = require('fs');
const path = require('path');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt' }),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn() },
}));
// The enqueue path builds an activity hint from recent posts; that aggregate
// is not what this file is testing, and unmocked it blocks on a real Mongo.
jest.mock('../../../models/Post', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/Message', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));

const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const SchedulerService = require('../../../services/schedulerService').constructor;

const install = (heartbeat) => ({
  _id: 'i1',
  agentName: 'a',
  instanceId: 'default',
  podId: 'p1',
  status: 'active',
  config: heartbeat === undefined ? {} : { heartbeat },
});

const mockFind = (rows) => {
  const lean = jest.fn().mockResolvedValue(rows);
  const select = jest.fn().mockReturnValue({ lean });
  AgentInstallation.find.mockReturnValue({ select, lean });
};

describe('dispatchAgentHeartbeats — opt-in', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an install with no heartbeat config does NOT fire', async () => {
    mockFind([install(undefined)]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBe(0);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('an install with heartbeat present but enabled unset does NOT fire', async () => {
    mockFind([install({ everyMinutes: 60 })]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBe(0);
  });

  test('enabled:false still does not fire', async () => {
    mockFind([install({ enabled: false, everyMinutes: 60 })]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBe(0);
  });

  test('enabled:true DOES fire — opting in still works', async () => {
    mockFind([install({ enabled: true, everyMinutes: 60 })]);
    const r = await SchedulerService.dispatchAgentHeartbeats({
      trigger: 'test', respectIntervals: false,
    });
    expect(r.enqueued).toBeGreaterThan(0);
  });

  test("the startup banner's heartbeat line names the gate, not just the cadence", () => {
    // The behaviour above is only half of what an operator relies on; the other
    // half is the one sentence describing it at boot. That sentence read
    // "Agent heartbeats run every 10 minutes with per-agent intervals" — true
    // about the dispatcher, silent about the opt-in — and on 2026-08-18 it sent
    // a reader to resolveHeartbeatIntervalMinutes to compute a fleet wake rate
    // from a field that is never reached for a seat which never opted in. The
    // number was retracted; the sentence that produced it would not have been.
    //
    // Asserted on the source text because the banner is emitted inside start(),
    // which schedules real cron jobs. Matched on the gate's NAME rather than on
    // wording, so a rephrase stays green and a re-simplification does not.
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/schedulerService.ts'), 'utf8',
    );
    const banner = src.slice(src.indexOf('- Agent heartbeats'));
    const line = banner.slice(0, banner.indexOf(');'));
    expect(line).toContain('heartbeat.enabled');
    // Control: the slice really did capture the banner and not an empty string,
    // which would satisfy nothing above and look identical to a pass.
    expect(line).toContain('10 minutes');
  });
});
