const mongoose = require('mongoose');

jest.mock('../../../models/PodMemberFirstMessage', () => ({
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

const PodMemberFirstMessage = require('../../../models/PodMemberFirstMessage');
const AgentEventService = require('../../../services/agentEventService');
const {
  maybeFireWelcomeWake,
  isDesignatedGreeter,
  findGreeters,
} = require('../../../services/welcomeWakeService');

const POD_ID = new mongoose.Types.ObjectId().toString();
const USER_ID = new mongoose.Types.ObjectId().toString();

// The driver's `updatedExisting` flag is the entire decision: false means this
// call performed the insert and therefore owns the one wake for this member.
const firstInsert = () => ({ value: null, lastErrorObject: { updatedExisting: false } });
const alreadySpoken = () => ({ value: { _id: 'm-1' }, lastErrorObject: { updatedExisting: true } });

const greeter = (over = {}) => ({
  agentName: 'commonly-support',
  instanceId: 'default',
  config: { welcomeWake: { enabled: true } },
  ...over,
});
const plainInstall = (over = {}) => ({
  agentName: 'codex',
  instanceId: 'default',
  config: {},
  ...over,
});

const opts = (over = {}) => ({
  podId: POD_ID,
  userId: USER_ID,
  username: 'user-9228',
  content: '这个是什么',
  messageId: '52630',
  isRouted: false,
  installations: [greeter()],
  ...over,
});

describe('welcomeWakeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    PodMemberFirstMessage.findOneAndUpdate.mockResolvedValue(firstInsert());
    AgentEventService.enqueue.mockResolvedValue(undefined);
  });

  afterEach(() => { console.warn.mockRestore(); });

  describe('greeter designation is opt-in and never inferred', () => {
    test('only an install with config.welcomeWake.enabled === true is a greeter', () => {
      expect(isDesignatedGreeter(greeter())).toBe(true);
      expect(isDesignatedGreeter(plainInstall())).toBe(false);
      expect(isDesignatedGreeter(null)).toBe(false);
    });

    // Guards against a future "helpfully" inferring the greeter — the sole
    // install, the oldest one, the one named like support. Each of those makes
    // the wake target drift silently as installs change.
    test('a lone install is NOT a greeter by virtue of being alone', () => {
      expect(findGreeters([plainInstall()])).toHaveLength(0);
    });

    test('truthy-but-not-true does not designate', () => {
      expect(isDesignatedGreeter({ config: { welcomeWake: { enabled: 'yes' } } })).toBe(false);
      expect(isDesignatedGreeter({ config: { welcomeWake: { enabled: 1 } } })).toBe(false);
    });
  });

  describe('the wake fires once, on an unaddressed first message', () => {
    test('wakes the designated greeter and reports it', async () => {
      const res = await maybeFireWelcomeWake(opts());
      expect(res).toEqual({ claimed: true, woke: ['commonly-support'] });
      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    });

    test('a second message from the same member in the same pod wakes nobody', async () => {
      PodMemberFirstMessage.findOneAndUpdate.mockResolvedValue(alreadySpoken());
      const res = await maybeFireWelcomeWake(opts());
      expect(res.claimed).toBe(false);
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    });

    // The bound that lets this ship before ADR-017's budget layer: fires are
    // capped by (member x pod), not by traffic. If this ever fires twice for
    // one member the whole spam argument collapses.
    test('only the winning insert wakes — the concurrent loser is silent', async () => {
      const dupKey = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      PodMemberFirstMessage.findOneAndUpdate.mockRejectedValue(dupKey);
      const res = await maybeFireWelcomeWake(opts());
      expect(res.claimed).toBe(false);
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('an addressed first message claims the marker but wakes nobody', () => {
    // Without this, a member whose opener is "@codex help" is not yet marked,
    // so their SECOND message trips the welcome — a greeting that arrives
    // after the conversation already started.
    test('routed first message claims without waking', async () => {
      const res = await maybeFireWelcomeWake(opts({ isRouted: true }));
      expect(res).toEqual({ claimed: true, woke: [], reason: 'routed' });
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(PodMemberFirstMessage.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    test('the claim records that no greeter was woken', async () => {
      await maybeFireWelcomeWake(opts({ isRouted: true }));
      const [, update] = PodMemberFirstMessage.findOneAndUpdate.mock.calls[0];
      expect(update.$setOnInsert.wokeGreeter).toBe(false);
    });

    // The positive half. Without it, `wokeGreeter: false` passes trivially and
    // the field is never proven to record anything — the audit trail for
    // "why was this member never welcomed" would be uniformly false.
    test('an unaddressed first message with a greeter records wokeGreeter true', async () => {
      await maybeFireWelcomeWake(opts());
      const [, update] = PodMemberFirstMessage.findOneAndUpdate.mock.calls[0];
      expect(update.$setOnInsert.wokeGreeter).toBe(true);
    });

    test('unaddressed but with no greeter records wokeGreeter false', async () => {
      await maybeFireWelcomeWake(opts({ installations: [plainInstall()] }));
      const [, update] = PodMemberFirstMessage.findOneAndUpdate.mock.calls[0];
      expect(update.$setOnInsert.wokeGreeter).toBe(false);
    });
  });

  describe('no designated greeter is a loud no-op, not a silent one', () => {
    test('claims the marker, warns, and wakes nobody', async () => {
      const res = await maybeFireWelcomeWake(opts({ installations: [plainInstall()] }));
      expect(res).toEqual({ claimed: true, woke: [], reason: 'no-greeter' });
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('config.welcomeWake.enabled'),
        expect.objectContaining({ pod: POD_ID }),
      );
    });

    // Claiming even with no greeter is deliberate: otherwise designating a
    // greeter later would welcome every existing member on their next message.
    test('still claims, so designating a greeter later does not welcome the backlog', async () => {
      await maybeFireWelcomeWake(opts({ installations: [] }));
      expect(PodMemberFirstMessage.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('the enqueued event is one every deployed wrapper already handles', () => {
    // A bespoke type would be dropped: the CLI wrapper's extractPrompt returns
    // null for anything outside PROMPT_EVENT_TYPES, so every wrapper shipped
    // before this feature would silently ignore the wake.
    test('type is chat.mention, flagged additively', async () => {
      await maybeFireWelcomeWake(opts());
      const [event] = AgentEventService.enqueue.mock.calls[0];
      expect(event.type).toBe('chat.mention');
      expect(event.payload.welcomeWake).toBe(true);
    });

    test('the cue rides inline in content, ahead of the member message', async () => {
      await maybeFireWelcomeWake(opts());
      const [event] = AgentEventService.enqueue.mock.calls[0];
      expect(event.payload.content).toContain('First message from a new member');
      expect(event.payload.content).toContain('这个是什么');
      expect(event.payload.content.indexOf('First message'))
        .toBeLessThan(event.payload.content.indexOf('这个是什么'));
    });

    test('routes to the greeter identity, not the sender', async () => {
      await maybeFireWelcomeWake(opts());
      const [event] = AgentEventService.enqueue.mock.calls[0];
      expect(event.agentName).toBe('commonly-support');
      expect(event.instanceId).toBe('default');
    });
  });

  describe('never turns a successful human send into a failure', () => {
    test('an enqueue failure still reports the claim', async () => {
      AgentEventService.enqueue.mockRejectedValue(new Error('queue down'));
      const res = await maybeFireWelcomeWake(opts());
      expect(res.claimed).toBe(true);
      expect(res.woke).toEqual([]);
    });

    test('a non-duplicate marker error resolves rather than throwing', async () => {
      PodMemberFirstMessage.findOneAndUpdate.mockRejectedValue(new Error('mongo down'));
      await expect(maybeFireWelcomeWake(opts())).resolves.toEqual(
        { claimed: false, woke: [], reason: 'error' },
      );
    });

    test('a malformed id is ignored rather than thrown', async () => {
      const res = await maybeFireWelcomeWake(opts({ podId: 'not-an-objectid' }));
      expect(res.claimed).toBe(false);
      expect(PodMemberFirstMessage.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
