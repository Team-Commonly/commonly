/**
 * A suppressed runtime failure must not conclude an agent-dm.
 *
 * @sprint-review, 2026-08-25: `agentMessageService` empties `sanitizedContent`
 * for a runtime model-failure (:949) and a tool-failure note (:957), and the
 * empty path then returns the SAME `silent_or_empty` an intentional NO_REPLY
 * returns. The label was the small half.
 *
 * The large half is that the empty path also fires ADR-012 §4's
 * `recordAgentDmConclusion`, which writes a `system_exchanges` entry for BOTH
 * peers whose takeaway is the sender's PRECEDING message. So a model chain
 * being exhausted wrote "this conversation concluded" into the record, with a
 * takeaway the agent never reached — a failure laundered into a positive
 * semantic event, its only honest trace a `console.warn` no agent can read.
 *
 * These pin the discrimination in both directions. The NO_REPLY case is the
 * control: it must still conclude, or the fix has traded one collapse for
 * another.
 */
const mockRecordAgentDmConclusion = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/systemExchangeTriggers', () => ({
  recordAgentDmConclusion: (...args) => mockRecordAgentDmConclusion(...args),
}));

const AgentMessageService = require('../../../services/agentMessageService');

const POD = '69ef02b036b742e2e2c0c4af';
const post = (content) => AgentMessageService.postMessage({
  agentName: 'openclaw', instanceId: 'nova', podId: POD, content,
});

beforeEach(() => {
  mockRecordAgentDmConclusion.mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('a failure concludes nothing', () => {
  it.each([
    ['model chain exhausted', '⚠️ Agent failed before reply: All models failed (4): openrouter/x: 401'],
    ['failover summary', 'All models failed (3): openrouter/a: 429'],
    ['tool-status note', '⚠️ 📝 Edit: in /workspace/MEMORY.md failed'],
  ])('%s does not fire the agent-dm conclusion trigger', async (_label, content) => {
    await post(content);
    expect(mockRecordAgentDmConclusion).not.toHaveBeenCalled();
  });

  it('and says which failure it was, not "silent"', async () => {
    const model = await post('All models failed (3): openrouter/a: 429');
    const tool = await post('⚠️ 📝 Edit: in /workspace/MEMORY.md failed');
    expect(model.reason).toBe('runtime_model_failure_suppressed');
    expect(tool.reason).toBe('runtime_tool_failure_suppressed');
    // Still skipped, still not an error — the caller did nothing wrong and a
    // 500 here would turn a degraded model chain into a broken endpoint.
    expect(model).toMatchObject({ success: true, skipped: true });
    expect(tool).toMatchObject({ success: true, skipped: true });
  });

  it('logs the suppressed content for the operator, as before', async () => {
    await post('All models failed (3): openrouter/a: 429');
    const warned = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('suppressed runtime model-failure');
    expect(warned).toContain('All models failed');
  });
});

describe('CONTROL: an intentional silence still concludes', () => {
  // Without this the suite is equally consistent with a fix that simply
  // stopped calling the trigger, which would break ADR-012 §4 outright.
  it('a bare NO_REPLY fires the trigger and reports silent_or_empty', async () => {
    const res = await post('NO_REPLY');
    expect(mockRecordAgentDmConclusion).toHaveBeenCalledWith({
      podId: POD, senderAgentName: 'openclaw', senderInstanceId: 'nova',
    });
    expect(res.reason).toBe('silent_or_empty');
  });

  it('and so does genuinely empty content', async () => {
    const res = await post('   ');
    expect(mockRecordAgentDmConclusion).toHaveBeenCalled();
    expect(res.reason).toBe('silent_or_empty');
  });
});
