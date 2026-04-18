// @ts-nocheck
// ADR-003 Phase 4: agentAskService cross-agent ask/respond.
// Uses an in-memory MongoDB for AgentInstallation + AgentAsk collections.
// AgentEventService.enqueue is stubbed so we don't need the full event
// pipeline (typing service, websocket, native runtime, etc.).

const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

// Stub the event service before requiring the ask service so the require()
// chain pulls our stub. The ask service requires('./agentEventService') at
// load time.
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));

const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentAsk = require('../../../models/AgentAsk');
const {
  askAgent,
  respondToAsk,
  AgentAskError,
} = require('../../../services/agentAskService');

jest.setTimeout(30_000);

const POD = new mongoose.Types.ObjectId();
const OTHER_POD = new mongoose.Types.ObjectId();
const INSTALLER = new mongoose.Types.ObjectId();

const installAgent = (agentName, instanceId, podId = POD) => AgentInstallation.create({
  agentName: agentName.toLowerCase(),
  instanceId,
  podId,
  version: '1.0.0',
  installedBy: INSTALLER,
  status: 'active',
});

beforeAll(async () => {
  await setupMongoDb();
});

afterAll(async () => {
  await closeMongoDb();
});

beforeEach(async () => {
  await clearMongoDb();
  AgentEventService.enqueue.mockClear();
});

describe('askAgent — happy path', () => {
  it('creates an AgentAsk row and enqueues an agent.ask event', async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'one');

    const result = await askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'bob',
      targetInstanceId: 'one',
      question: 'what time is the demo?',
    });

    expect(result.requestId).toMatch(/[a-f0-9-]{36}/i);
    expect(result.expiresAt).toBeInstanceOf(Date);

    const ask = await AgentAsk.findOne({ requestId: result.requestId });
    expect(ask.status).toBe('open');
    expect(ask.fromAgent).toBe('alice');
    expect(ask.targetAgent).toBe('bob');
    expect(ask.question).toBe('what time is the demo?');

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const evtArgs = AgentEventService.enqueue.mock.calls[0][0];
    expect(evtArgs.type).toBe('agent.ask');
    expect(evtArgs.agentName).toBe('bob');
    expect(evtArgs.instanceId).toBe('one');
    expect(String(evtArgs.podId)).toBe(POD.toString());
    expect(evtArgs.payload.requestId).toBe(result.requestId);
    expect(evtArgs.payload.fromAgent).toBe('alice');
    expect(evtArgs.payload.question).toBe('what time is the demo?');
  });

  it('uses caller-supplied requestId when provided', async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'one');
    const result = await askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'bob',
      targetInstanceId: 'one',
      question: 'q',
      requestId: 'caller-supplied-id-123',
    });
    expect(result.requestId).toBe('caller-supplied-id-123');
  });

  it("defaults targetInstanceId to 'default' when omitted", async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'default');
    const result = await askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'bob',
      question: 'q',
    });
    const ask = await AgentAsk.findOne({ requestId: result.requestId });
    expect(ask.targetInstanceId).toBe('default');
  });
});

describe('askAgent — guards', () => {
  it('rejects self-ask (same agentName + instanceId)', async () => {
    await installAgent('alice', 'one');
    await expect(askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'alice',
      targetInstanceId: 'one',
      question: 'q',
    })).rejects.toMatchObject({
      status: 400,
      code: 'self_ask',
    });
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  it("normalizes self-ask: 'Alice' targeting 'alice' is still self", async () => {
    await installAgent('alice', 'default');
    await expect(askAgent({
      fromAgent: 'Alice',
      fromInstanceId: 'default',
      podId: POD.toString(),
      targetAgent: 'alice',
      // targetInstanceId omitted → defaults to 'default'
      question: 'q',
    })).rejects.toMatchObject({ code: 'self_ask' });
  });

  it('allows ask between same agentName but DIFFERENT instanceId', async () => {
    // Two distinct installations of the same agent persona — collaborative
    // multi-instance setup. These are different entities, the ask must work.
    await installAgent('alice', 'one');
    await installAgent('alice', 'two');
    const result = await askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'alice',
      targetInstanceId: 'two',
      question: 'hello other me',
    });
    expect(result.requestId).toBeTruthy();
  });

  it('rejects when target is not installed in the named pod', async () => {
    await installAgent('alice', 'one');
    // bob is installed in OTHER_POD, not POD
    await installAgent('bob', 'one', OTHER_POD);
    await expect(askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'bob',
      targetInstanceId: 'one',
      question: 'q',
    })).rejects.toMatchObject({
      status: 404,
      code: 'target_not_in_pod',
    });
  });

  it('rejects when target installation is not active', async () => {
    await installAgent('alice', 'one');
    const inst = await installAgent('bob', 'one');
    inst.status = 'paused';
    await inst.save();
    await expect(askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'bob',
      targetInstanceId: 'one',
      question: 'q',
    })).rejects.toMatchObject({ code: 'target_not_in_pod' });
  });

  it('rejects empty question / missing fields', async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'one');
    await expect(askAgent({
      fromAgent: 'alice', fromInstanceId: 'one', podId: POD.toString(), targetAgent: 'bob', question: '',
    })).rejects.toMatchObject({ code: 'question_required' });
    await expect(askAgent({
      fromAgent: '', fromInstanceId: 'one', podId: POD.toString(), targetAgent: 'bob', question: 'q',
    })).rejects.toMatchObject({ code: 'fromAgent_required' });
    await expect(askAgent({
      fromAgent: 'alice', fromInstanceId: 'one', podId: '', targetAgent: 'bob', question: 'q',
    })).rejects.toMatchObject({ code: 'podId_required' });
  });
});

describe('askAgent — rate limiting', () => {
  it('returns 429 when fromAgent exceeds 30 asks/hour in same pod', async () => {
    await installAgent('chatty', 'one');
    await installAgent('victim', 'one');

    // Pre-seed 30 recent asks from chatty in this pod so the next call
    // crosses the limit.
    const seed = [];
    for (let i = 0; i < 30; i += 1) {
      seed.push({
        requestId: `seed-${i}`,
        podId: POD,
        fromAgent: 'chatty',
        fromInstanceId: 'one',
        targetAgent: 'victim',
        targetInstanceId: 'one',
        question: 'q',
        status: 'open',
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    await AgentAsk.insertMany(seed);

    await expect(askAgent({
      fromAgent: 'chatty',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'victim',
      targetInstanceId: 'one',
      question: 'one too many',
    })).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('rate-limit key is normalized — varying fromInstanceId does NOT bypass', async () => {
    // Defense against trivial bypass: "rotate instanceId" is not a way out
    // of the rate limit. The limit key is (fromAgent, podId), instanceId is
    // intentionally excluded.
    await installAgent('chatty', 'one');
    await installAgent('chatty', 'two');
    await installAgent('victim', 'default');

    const seed = [];
    for (let i = 0; i < 30; i += 1) {
      seed.push({
        requestId: `seed-${i}`,
        podId: POD,
        fromAgent: 'chatty',
        fromInstanceId: i % 2 === 0 ? 'one' : 'two',
        targetAgent: 'victim',
        targetInstanceId: 'default',
        question: 'q',
        status: 'open',
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    await AgentAsk.insertMany(seed);

    // Even from a fresh instanceId, the agentName is the same → blocked.
    await expect(askAgent({
      fromAgent: 'chatty',
      fromInstanceId: 'two',
      podId: POD.toString(),
      targetAgent: 'victim',
      targetInstanceId: 'default',
      question: 'bypass attempt',
    })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('does not count asks older than 1 hour', async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'one');

    // Insert 30 stale asks (well outside the 1h window) — these must NOT
    // count toward the limit.
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const seed = [];
    for (let i = 0; i < 30; i += 1) {
      seed.push({
        requestId: `stale-${i}`,
        podId: POD,
        fromAgent: 'alice',
        fromInstanceId: 'one',
        targetAgent: 'bob',
        targetInstanceId: 'one',
        question: 'q',
        status: 'responded',
        createdAt: stale,
        expiresAt: new Date(stale.getTime() + 60_000),
      });
    }
    await AgentAsk.insertMany(seed);

    const result = await askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'bob',
      targetInstanceId: 'one',
      question: 'fresh ask',
    });
    expect(result.requestId).toBeTruthy();
  });
});

describe('respondToAsk', () => {
  const setup = async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'one');
    const { requestId } = await askAgent({
      fromAgent: 'alice',
      fromInstanceId: 'one',
      podId: POD.toString(),
      targetAgent: 'bob',
      targetInstanceId: 'one',
      question: 'hi',
    });
    AgentEventService.enqueue.mockClear();
    return requestId;
  };

  it('marks the ask responded and enqueues agent.ask.response back to sender', async () => {
    const requestId = await setup();
    await respondToAsk({
      fromAgent: 'bob',
      fromInstanceId: 'one',
      requestId,
      content: '2pm pacific',
    });

    const ask = await AgentAsk.findOne({ requestId });
    expect(ask.status).toBe('responded');
    expect(ask.response).toBe('2pm pacific');
    expect(ask.respondedAt).toBeInstanceOf(Date);

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const evt = AgentEventService.enqueue.mock.calls[0][0];
    expect(evt.type).toBe('agent.ask.response');
    expect(evt.agentName).toBe('alice');     // back to original sender
    expect(evt.instanceId).toBe('one');
    expect(evt.payload.response).toBe('2pm pacific');
    expect(evt.payload.requestId).toBe(requestId);
    expect(evt.payload.fromAgent).toBe('bob'); // responder identity
  });

  it('rejects respond from someone other than the original target', async () => {
    const requestId = await setup();
    await installAgent('eve', 'one');
    await expect(respondToAsk({
      fromAgent: 'eve',
      fromInstanceId: 'one',
      requestId,
      content: 'hijack',
    })).rejects.toMatchObject({ status: 403, code: 'not_target' });

    // ask still open
    const ask = await AgentAsk.findOne({ requestId });
    expect(ask.status).toBe('open');
  });

  it('rejects responding twice to the same ask', async () => {
    const requestId = await setup();
    await respondToAsk({
      fromAgent: 'bob', fromInstanceId: 'one', requestId, content: 'first',
    });
    await expect(respondToAsk({
      fromAgent: 'bob', fromInstanceId: 'one', requestId, content: 'second',
    })).rejects.toMatchObject({ status: 409, code: 'already_responded' });
  });

  it('rejects responding to an unknown requestId', async () => {
    await expect(respondToAsk({
      fromAgent: 'bob', fromInstanceId: 'one', requestId: 'not-a-real-id', content: 'x',
    })).rejects.toMatchObject({ status: 404, code: 'ask_not_found' });
  });

  it('rejects responding to an expired ask', async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'one');
    // Insert an ask that's already past its expiry.
    const ask = await AgentAsk.create({
      requestId: 'expired-1',
      podId: POD,
      fromAgent: 'alice',
      fromInstanceId: 'one',
      targetAgent: 'bob',
      targetInstanceId: 'one',
      question: 'q',
      status: 'open',
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(respondToAsk({
      fromAgent: 'bob', fromInstanceId: 'one', requestId: ask.requestId, content: 'x',
    })).rejects.toMatchObject({ status: 410, code: 'ask_expired' });

    // Side effect: ask status flipped to 'expired' so future polls see it.
    const reloaded = await AgentAsk.findOne({ requestId: ask.requestId });
    expect(reloaded.status).toBe('expired');
  });

  it('rejects empty/missing content', async () => {
    const requestId = await setup();
    await expect(respondToAsk({
      fromAgent: 'bob', fromInstanceId: 'one', requestId, content: '',
    })).rejects.toMatchObject({ code: 'content_required' });
  });
});

describe('askAgent — requestId validation (DoS surface)', () => {
  beforeEach(async () => {
    await installAgent('alice', 'one');
    await installAgent('bob', 'one');
  });

  it('rejects requestId longer than 128 chars before reaching Mongo', async () => {
    const overlong = 'x'.repeat(129);
    await expect(askAgent({
      fromAgent: 'alice', fromInstanceId: 'one',
      podId: POD.toString(), targetAgent: 'bob', targetInstanceId: 'one',
      question: 'q', requestId: overlong,
    })).rejects.toMatchObject({ status: 400, code: 'invalid_request_id' });
    // Confirm no record landed in Mongo despite the reject — the guard has
    // to trip BEFORE the DB write, otherwise the DoS payload is already in
    // the unique index and subsequent inserts would 11000.
    const stored = await AgentAsk.findOne({ requestId: overlong });
    expect(stored).toBeNull();
  });

  it('accepts requestId at exactly 128 chars (boundary)', async () => {
    const at = 'a'.repeat(128);
    const res = await askAgent({
      fromAgent: 'alice', fromInstanceId: 'one',
      podId: POD.toString(), targetAgent: 'bob', targetInstanceId: 'one',
      question: 'q', requestId: at,
    });
    expect(res.requestId).toBe(at);
  });

  it('rejects requestId with control characters', async () => {
    await expect(askAgent({
      fromAgent: 'alice', fromInstanceId: 'one',
      podId: POD.toString(), targetAgent: 'bob', targetInstanceId: 'one',
      question: 'q', requestId: 'has-newline\nbad',
    })).rejects.toMatchObject({ status: 400, code: 'invalid_request_id' });
  });
});
