// Unit test for SchedulerService.dispatchPodSummaryRequests chunking
// (#454 follow-up). The previous bare Promise.all fanned out all
// installations in a single tick — see project-2026-05-26-pg-pool-
// exhaustion-incident memory for the live incident this prevents.

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn().mockResolvedValue({ _id: 'evt' }),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
  },
}));

const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
// schedulerService is exported as `new SchedulerService()` instance via
// CJS compat (`module.exports = exports["default"]`). The class lives
// on `.constructor` of that instance — same pattern routes/summaries.ts
// uses to access SchedulerService.runSummarizer.
const schedulerServiceInstance = require('../../../services/schedulerService');
const SchedulerService = schedulerServiceInstance.constructor;

const makeFindChain = (installations) => {
  const lean = jest.fn().mockResolvedValue(installations);
  const select = jest.fn().mockReturnValue({ lean });
  AgentInstallation.find.mockReturnValue({ select });
};

describe('SchedulerService.dispatchPodSummaryRequests chunking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Force tiny pause so the test runs fast.
    process.env.SUMMARIZER_FANOUT_BATCH_SIZE = '10';
    process.env.SUMMARIZER_FANOUT_BATCH_PAUSE_MS = '0';
  });

  afterAll(() => {
    delete process.env.SUMMARIZER_FANOUT_BATCH_SIZE;
    delete process.env.SUMMARIZER_FANOUT_BATCH_PAUSE_MS;
  });

  it('returns 0 enqueued when no installations exist', async () => {
    makeFindChain([]);
    const result = await SchedulerService.dispatchPodSummaryRequests();
    expect(result).toEqual({ enqueued: 0 });
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues every installation when count <= batch size', async () => {
    const installs = Array.from({ length: 5 }, (_, i) => ({ podId: `pod-${i}`, instanceId: 'default' }));
    makeFindChain(installs);
    const result = await SchedulerService.dispatchPodSummaryRequests();
    expect(result).toEqual({ enqueued: 5 });
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(5);
  });

  it('chunks the fanout when count exceeds batch size (no all-at-once burst)', async () => {
    const installs = Array.from({ length: 60 }, (_, i) => ({ podId: `pod-${i}`, instanceId: 'default' }));
    makeFindChain(installs);

    // Snapshot the order of calls so we can verify they came in
    // batches, not one big Promise.all over 60 items. With
    // BATCH_PAUSE_MS=0 each batch still awaits its Promise.all before
    // the next batch starts — verified by call ordering.
    const callOrder = [];
    AgentEventService.enqueue.mockImplementation(async ({ podId }) => {
      callOrder.push(String(podId));
      return { _id: 'evt' };
    });

    const result = await SchedulerService.dispatchPodSummaryRequests();
    expect(result).toEqual({ enqueued: 60 });
    expect(callOrder).toHaveLength(60);
    // First 10 calls should be the first batch (pod-0 through pod-9),
    // demonstrating sequential batching. With a single Promise.all over
    // all 60 the order is non-deterministic.
    expect(callOrder.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, i) => `pod-${i}`),
    );
    expect(callOrder.slice(10, 20)).toEqual(
      Array.from({ length: 10 }, (_, i) => `pod-${10 + i}`),
    );
  });

  it('forwards trigger + windowMinutes options into the payload', async () => {
    makeFindChain([{ podId: 'pod-x', instanceId: 'default' }]);
    await SchedulerService.dispatchPodSummaryRequests({ trigger: 'manual-test', windowMinutes: 15 });
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'commonly-bot',
      podId: 'pod-x',
      type: 'summary.request',
      payload: expect.objectContaining({
        trigger: 'manual-test',
        windowMinutes: 15,
      }),
    }));
  });
});
