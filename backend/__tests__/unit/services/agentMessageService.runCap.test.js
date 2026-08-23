/**
 * Consecutive-run cap (ADR-024 fine-tuning, ruled by fable-lead).
 *
 * The defect: a rate cap bounds how FAST an agent talks and never how LONG it
 * holds the floor. sprint-review posted 24 consecutive messages over 433s and
 * pod-architect 21 over 379s, both inside the documented "3 messages per
 * minute" — 24/433s is 3.3/min, sitting on the stated limit.
 *
 * Two properties are load-bearing and neither is obvious from the code:
 *
 * 1. It lives HERE, not in the wrapper. fable-lead demonstrated why on itself:
 *    "my posts ride MCP and no wrapper ever saw them." A wrapper-side cap
 *    misses exactly the seats that post most.
 * 2. The refusal STEERS. A bare refusal converts a monologue into silence,
 *    which in this system is indistinguishable from a considered decision —
 *    the failure family behind nearly every bug found tonight.
 */
const AgentMessageService = require('../../../services/agentMessageService');

const POD = 'pod-1';
const ME = 'agent-user-1';
const SOMEONE_ELSE = 'human-user-1';

const msg = (userId) => ({ user_id: userId, content: 'x', createdAt: new Date().toISOString() });

const withRecent = (rows, fn) => {
  const original = AgentMessageService.getRecentMessages;
  AgentMessageService.getRecentMessages = jest.fn().mockResolvedValue(rows);
  return fn().finally(() => { AgentMessageService.getRecentMessages = original; });
};

describe('countConsecutiveRun', () => {
  it('counts only the unbroken tail, so an interleaved speaker resets it', async () => {
    await withRecent(
      [msg(ME), msg(ME), msg(ME), msg(SOMEONE_ELSE), msg(ME)],
      async () => {
        // Someone else spoke, then this agent posted once. The run is 1 — the
        // three earlier messages are history, not a monologue in progress.
        expect(await AgentMessageService.countConsecutiveRun(POD, ME)).toBe(1);
      },
    );
  });

  it('counts a full tail run', async () => {
    await withRecent([msg(SOMEONE_ELSE), msg(ME), msg(ME), msg(ME)], async () => {
      expect(await AgentMessageService.countConsecutiveRun(POD, ME)).toBe(3);
    });
  });

  it('is 0 in an empty pod and 0 when the last speaker is someone else', async () => {
    await withRecent([], async () => {
      expect(await AgentMessageService.countConsecutiveRun(POD, ME)).toBe(0);
    });
    await withRecent([msg(ME), msg(SOMEONE_ELSE)], async () => {
      expect(await AgentMessageService.countConsecutiveRun(POD, ME)).toBe(0);
    });
  });

  it('returns 0 without an author rather than counting everything', async () => {
    // A missing userId must not match every row and refuse the whole pod.
    await withRecent([msg(ME), msg(ME), msg(ME)], async () => {
      expect(await AgentMessageService.countConsecutiveRun(POD, null)).toBe(0);
    });
  });
});

describe('resolveConsecutiveRunCap', () => {
  const original = process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
    else process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = original;
  });

  it('defaults to 3, matching the number the tool description states', () => {
    delete process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP;
    expect(AgentMessageService.resolveConsecutiveRunCap()).toBe(3);
  });

  it('is tunable without a deploy', () => {
    process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = '5';
    expect(AgentMessageService.resolveConsecutiveRunCap()).toBe(5);
  });

  it('treats 0 as disabled rather than as "refuse everything"', () => {
    // The caller gates on `runCap > 0`. If 0 fell through to the default, an
    // operator disabling the cap would silently get it back at 3.
    process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = '0';
    expect(AgentMessageService.resolveConsecutiveRunCap()).toBe(0);
  });

  it('ignores garbage and keeps the default', () => {
    process.env.AGENT_MESSAGE_CONSECUTIVE_RUN_CAP = 'lots';
    expect(AgentMessageService.resolveConsecutiveRunCap()).toBe(3);
  });
});

describe('isOneToOnePod — the cap must not fire in a 1:1', () => {
  it('exempts agent-room and agent-dm', () => {
    // Sam caught this within hours of the cap shipping: ux-lead answered a
    // three-part design question in an agent-room, hit the cap, and attached
    // its reply as a .md. A colleague's answer arriving as a file you must open
    // is worse than the monologue the cap prevents. In a 1:1 there is no room
    // to crowd — the only other participant is the person who asked.
    expect(AgentMessageService.isOneToOnePod('agent-room')).toBe(true);
    expect(AgentMessageService.isOneToOnePod('agent-dm')).toBe(true);
  });

  it('does NOT exempt agent-admin, which is N:1 and therefore a shared room', () => {
    // Matches DM_POD_TYPES_GUARD's deliberate exclusion (ADR-001 3.10):
    // several admins, one agent — so crowding is real there.
    expect(AgentMessageService.isOneToOnePod('agent-admin')).toBe(false);
  });

  it('does not exempt ordinary pods, or a missing type', () => {
    expect(AgentMessageService.isOneToOnePod('chat')).toBe(false);
    expect(AgentMessageService.isOneToOnePod(undefined)).toBe(false);
    expect(AgentMessageService.isOneToOnePod(null)).toBe(false);
  });
});
