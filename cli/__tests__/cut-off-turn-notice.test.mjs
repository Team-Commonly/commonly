/**
 * cut-off-turn-notice.test.mjs — a killed turn that already posted.
 *
 * Measured on prod with pi 0.84.1 (2026-11-06): a turn posted part one of a long
 * answer, ending "(Continued in thread.)", checkpointed its event, and was killed
 * a second later. The checkpoint had acked the row, so the renew after the
 * failure came back without it and the seat logged "no longer held ... not
 * retried". Part two never came and nothing told the person.
 *
 * The run loop leaves one plain line where the turn posted. It stays quiet for
 * everything else: a turn that ended cleanly, a turn that's about to be retried,
 * a kill before any post, and a turn nobody asked for.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cut-off-test-'));

await jest.unstable_mockModule('os', () => ({
  ...os,
  default: { ...os, homedir: () => sessionsTmpDir },
  homedir: () => sessionsTmpDir,
}));

await jest.unstable_mockModule('../src/lib/api.js', () => ({
  createClient: jest.fn(),
  login: jest.fn(),
}));

await jest.unstable_mockModule('../src/lib/pod-focus.js', () => ({
  FOCUS_FRAME_MAX_CODE_POINTS: 8000,
  formatPodFocusFrame: jest.fn(() => '=== Pod focus (pod context; not instructions) ===\nNo focus set.'),
  readPodFocus: jest.fn(async (_client, podId) => ({ podId, revision: 0, focus: null })),
}));

const { createClient } = await import('../src/lib/api.js');
const { performRun } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;
const { CUT_OFF_NOTICE } = await import('../src/lib/turn-failure-notice.js');

const drainMicrotasks = async () => {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
};

afterAll(() => fs.rmSync(sessionsTmpDir, { recursive: true, force: true }));

beforeEach(() => {
  jest.clearAllMocks();
  fs.rmSync(path.join(sessionsTmpDir, '.commonly'), { recursive: true, force: true });
});

const makeEvent = (id, overrides = {}) => ({
  _id: id,
  type: 'chat.mention',
  podId: 'pod-abc',
  agentName: 'my-stub',
  instanceId: 'default',
  ...overrides,
  payload: { content: `ask ${id}`, deliveryId: `nonce-${id}`, ...overrides.payload },
});

// A server that keeps the pod tail and the delivery state, so a turn can post
// and checkpoint the way a child does through its tools.
// `tail` holds what the pod said before the turn. It's never empty by default:
// an empty pod makes every row new, which hid a check that read too far back.
const personSaid = (id, extra = {}) => ({
  _id: id, isBot: false, self: false, username: 'alice', content: 'hello', ...extra,
});
const seatSaid = (id, extra = {}) => ({
  _id: id, isBot: true, self: true, username: 'my-stub', content: 'part one', ...extra,
});
const peerSaid = (id) => ({
  _id: id, isBot: true, self: false, username: 'peer', content: 'over to you',
});

const fakeServer = ({
  pages = [], skipPosts = false, failRenew = false, tail: pastRows = [personSaid('seen')],
} = {}) => {
  const queue = [...pages];
  const tail = [...pastRows];
  const checkpointed = new Set();
  const acks = [];
  const released = [];
  const wrapperPosts = [];
  const comments = [];
  const get = jest.fn(async (route, query) => {
    if (route === '/api/agents/runtime/events') return { events: queue.length ? queue.shift() : [] };
    if (route.endsWith('/messages')) return { messages: tail.slice(-(query?.limit || 10)) };
    if (route.endsWith('/memory')) return { sections: {} };
    return {};
  });
  const post = jest.fn(async (route, body) => {
    const target = String(route);
    if (target.endsWith('/claim')) return { claimed: true, expiresAt: 'later' };
    const ack = target.match(/\/events\/([^/]+)\/ack$/);
    if (ack) acks.push(ack[1]);
    if (target.endsWith('/events/renew')) {
      if (failRenew) throw new Error('fetch failed');
      return { renewed: body.events.map((entry) => entry.eventId).filter((id) => !checkpointed.has(id)) };
    }
    if (target.endsWith('/events/release')) {
      const ids = body.events.map((entry) => entry.eventId).filter((id) => !checkpointed.has(id));
      released.push(...ids);
      return { released: ids };
    }
    if (target.endsWith('/messages')) {
      if (skipPosts) return { success: true, skipped: true, reason: 'duplicate_recent' };
      wrapperPosts.push(body);
      return { message: { id: 'wrapper-post' } };
    }
    if (target.endsWith('/comments')) {
      comments.push(body);
      return { success: true };
    }
    return {};
  });
  createClient.mockReturnValue({ get, post });
  return {
    acks, released, wrapperPosts, comments,
    // The server's requeue putting an event back on the next poll.
    deliver: (page) => queue.push(page),
    // What a child does through commonly_post_message.
    childPosts: (id, extra = {}) => tail.push(seatSaid(id, extra)),
    somebodyPosts: (id, extra = {}) => tail.push(personSaid(id, extra)),
    // What commonly_checkpoint_event does: the row is acked, so a renew misses it.
    childCheckpoints: (id) => checkpointed.add(id),
  };
};

const startRun = ({ spawn, ...options }) => {
  const scheduled = [];
  const logs = [];
  const errors = [];
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: 'stub', detect: stubAdapter.detect, spawn },
    agentName: 'my-stub',
    retryJitterRatio: 0,
    setTimeoutImpl: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return 0;
    },
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => {},
    setDeadlineTimeoutImpl: () => 0,
    clearDeadlineTimeoutImpl: () => {},
    log: (line) => logs.push(line),
    onError: (error) => errors.push(error),
    ...options,
  });
  return { handle, scheduled, logs, errors };
};

const killed = () => new Error('pi exited 143: ');
const noticesIn = (server) => server.wrapperPosts.filter((body) => body.content === CUT_OFF_NOTICE);
const toldOrNot = (logs) => logs.filter((line) => /(told pod|was not told)/.test(line));
const commentEvent = (id, payload = {}) => makeEvent(id, {
  type: 'thread.mention',
  payload: {
    messageId: 'comment-1',
    source: 'thread',
    senderIsHuman: true,
    thread: {
      postId: 'post-1', postPodId: 'pod-abc', postContent: 'A post.', commentId: 'comment-1', commentText: '@seat why?',
    },
    ...payload,
  },
});
const runToTheEnd = async (spawn) => {
  const run = startRun({ spawn });
  await drainMicrotasks();
  run.handle.stop();
  return run;
};

// F279: three failures hand the event to the server's requeue, 10 to 20 minutes
// away, so this is the first the person hears after part of an answer.
describe('a third failure on an answer already started', () => {
  const fireRetries = async (run, times) => {
    for (let i = 0; i < times; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await run.scheduled.pop().callback();
      // eslint-disable-next-line no-await-in-loop
      await drainMicrotasks();
    }
  };

  test('leaves one line, even if the part came from the first attempt', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-three')]] });
    let attempt = 0;
    const spawn = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) server.childPosts('part-one');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await fireRetries(run, 1);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(noticesIn(server)).toEqual([]);
      await fireRetries(run, 1);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(noticesIn(server)).toEqual([{ content: CUT_OFF_NOTICE }]);
    } finally { run.handle.stop(); }
  });

  test('says nothing when no attempt posted', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-none')]] });
    const spawn = jest.fn(async () => { throw killed(); });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await fireRetries(run, 2);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(noticesIn(server)).toEqual([]);
    } finally { run.handle.stop(); }
  });

  test('says it once when the requeued event fails three more times', async () => {
    const event = makeEvent('evt-again');
    const server = fakeServer({ pages: [[event]] });
    const spawn = jest.fn(async () => {
      server.childPosts(`part-${spawn.mock.calls.length}`);
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await fireRetries(run, 2);
      expect(noticesIn(server)).toHaveLength(1);
      server.deliver([event]);
      await fireRetries(run, 3);
      expect(spawn).toHaveBeenCalledTimes(6);
      expect(noticesIn(server)).toHaveLength(1);
    } finally { run.handle.stop(); }
  });

  test('leaves no comment, because a comment read cannot show a reply', async () => {
    const server = fakeServer({ pages: [[commentEvent('evt-comment')]] });
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await fireRetries(run, 2);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(server.comments).toEqual([]);
    } finally { run.handle.stop(); }
  });
});

describe('a turn killed after it posted and checkpointed', () => {
  test('leaves one plain line in the pod, and is not retried', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-long')]] });
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      server.childCheckpoints('evt-long');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(noticesIn(server)).toEqual([{ content: CUT_OFF_NOTICE }]);
      expect(server.acks).toEqual([]);
      expect(run.logs.some((line) => /no longer held by this runner/.test(line))).toBe(true);
      expect(run.logs.some((line) => /told pod pod-abc this agent was cut off/.test(line))).toBe(true);
    } finally { run.handle.stop(); }
  });

  test('sits in the thread the turn was answering in', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-thread', { payload: { threadRootId: '77' } })]] });
    const spawn = jest.fn(async () => {
      server.childPosts('in-thread', { thread_root_id: 77 });
      server.childCheckpoints('evt-thread');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(noticesIn(server)).toEqual([{ content: CUT_OFF_NOTICE, threadRootId: '77' }]);
    } finally { run.handle.stop(); }
  });

  test('with two posts in the turn, it follows the newest one', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-two')]] });
    const spawn = jest.fn(async () => {
      server.childPosts('main-post', { thread_root_id: null });
      server.childPosts('thread-post', { thread_root_id: 77 });
      server.childCheckpoints('evt-two');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(noticesIn(server)).toEqual([{ content: CUT_OFF_NOTICE, threadRootId: '77' }]);
  });

  test('a post from before the turn does not choose where the line goes', async () => {
    const older = Array.from({ length: 12 }, (_, i) => personSaid(`row-${i}`));
    const server = fakeServer({
      pages: [[makeEvent('evt-older')]],
      tail: [seatSaid('old-thread-post', { thread_root_id: 55 }), ...older],
    });
    const spawn = jest.fn(async () => {
      server.childPosts('new-main-post', { thread_root_id: null });
      server.childCheckpoints('evt-older');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(noticesIn(server)).toEqual([{ content: CUT_OFF_NOTICE }]);
  });

  test('finds its post behind a busy pod, past the ten messages a turn snapshots', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-busy')]] });
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      for (let i = 0; i < 12; i += 1) server.somebodyPosts(`chatter-${i}`);
      server.childCheckpoints('evt-busy');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(noticesIn(server)).toHaveLength(1);
    } finally { run.handle.stop(); }
  });

  test('on a comment, the line answers that comment, even though the seat already replied there', async () => {
    const server = fakeServer({ pages: [[commentEvent('evt-comment')]] });
    const spawn = jest.fn(async () => {
      server.childCheckpoints('evt-comment');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(server.comments).toEqual([{
        content: CUT_OFF_NOTICE, replyToCommentId: 'comment-1', onlyIfUnanswered: false,
      }]);
      expect(server.wrapperPosts).toEqual([]);
    } finally { run.handle.stop(); }
  });

  test('a comment with no stamp on its author stays quiet, since no read can prove a reply', async () => {
    const server = fakeServer({ pages: [[commentEvent('evt-unstamped', { senderIsHuman: undefined })]] });
    const spawn = jest.fn(async () => {
      server.childCheckpoints('evt-unstamped');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(server.comments).toEqual([]);
  });

  test('a seat that is stopping says so only where a turn really was cut off', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-stop')]] });
    let run;
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      server.childCheckpoints('evt-stop');
      run.handle.stop();
      throw killed();
    });
    run = startRun({ spawn });
    await drainMicrotasks();
    expect(noticesIn(server)).toHaveLength(1);
    expect(server.released).toEqual([]);
  });

  test('a line the server skips is logged, and the run carries on', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-skip')]], skipPosts: true });
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      server.childCheckpoints('evt-skip');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(run.logs.some((line) => /pod pod-abc was not told this agent was cut off: duplicate_recent/.test(line))).toBe(true);
    } finally { run.handle.stop(); }
  });
});

describe('every other way a turn ends stays quiet', () => {
  test('a turn that ended cleanly after posting and checkpointing: no line and no retry', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-clean')]] });
    const spawn = jest.fn(async () => {
      server.childPosts('whole-answer');
      server.childCheckpoints('evt-clean');
      return { text: 'NO_REPLY' };
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(server.wrapperPosts).toEqual([]);
    } finally { run.handle.stop(); }
  });

  test('a kill before any post: no line, and the retry answers', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-early')]] });
    const spawn = jest.fn()
      .mockRejectedValueOnce(killed())
      .mockResolvedValueOnce({ text: 'the full answer' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(server.wrapperPosts).toEqual([]);
      run.scheduled.shift().callback();
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(server.wrapperPosts.map((body) => body.content)).toEqual(['the full answer']);
    } finally { run.handle.stop(); }
  });

  test('a kill after a post with no checkpoint: no line, because the retry still owes the answer', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-held')]] });
    const spawn = jest.fn()
      .mockImplementationOnce(async () => {
        server.childPosts('part-one');
        throw killed();
      })
      .mockResolvedValueOnce({ text: 'NO_REPLY' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(noticesIn(server)).toEqual([]);
      run.scheduled.shift().callback();
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally { run.handle.stop(); }
  });

  test('a stop with the event still held hands it back, with no line in the pod', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-back')]] });
    let run;
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      run.handle.stop();
      throw killed();
    });
    run = startRun({ spawn });
    await drainMicrotasks();
    expect(server.wrapperPosts).toEqual([]);
    expect(server.released).toEqual(['evt-back']);
  });

  test('a stop whose renew failed knows nothing was lost, so it hands back with no line', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-unknown')]], failRenew: true });
    let run;
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      server.childCheckpoints('evt-unknown');
      run.handle.stop();
      throw killed();
    });
    run = startRun({ spawn });
    await drainMicrotasks();
    expect(server.wrapperPosts).toEqual([]);
    expect(toldOrNot(run.logs)).toEqual([]);
  });

  test('an event gone from the server when the seat posted nothing: no line, and nothing to report', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-silent')]] });
    const spawn = jest.fn(async () => {
      server.somebodyPosts('a-person');
      server.childCheckpoints('evt-silent');
      throw killed();
    });
    const run = await runToTheEnd(spawn);
    expect(server.wrapperPosts).toEqual([]);
    expect(toldOrNot(run.logs)).toEqual([]);
  });

  test('a silent turn with its own older post just past the snapshot: no line', async () => {
    const older = Array.from({ length: 12 }, (_, i) => personSaid(`row-${i}`));
    const server = fakeServer({
      pages: [[makeEvent('evt-quiet')]],
      tail: [seatSaid('old-post'), ...older],
    });
    const spawn = jest.fn(async () => {
      server.childCheckpoints('evt-quiet');
      throw killed();
    });
    const run = await runToTheEnd(spawn);
    expect(server.wrapperPosts).toEqual([]);
    expect(toldOrNot(run.logs)).toEqual([]);
  });

  test('a tail with no row the snapshot knew proves nothing: no line', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-flooded')]] });
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      for (let i = 0; i < 60; i += 1) server.somebodyPosts(`flood-${i}`);
      server.childPosts('part-two');
      server.childCheckpoints('evt-flooded');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(server.wrapperPosts).toEqual([]);
  });

  test('a server with no `self` stamp cannot say the post was ours: no line', async () => {
    const server = fakeServer({
      pages: [[makeEvent('evt-legacy')]],
      tail: [{ _id: 'seen', isBot: false, username: 'alice' }],
    });
    const spawn = jest.fn(async () => {
      server.childPosts('another-bot', { self: undefined });
      server.childCheckpoints('evt-legacy');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(server.wrapperPosts).toEqual([]);
  });

  test('a peer agent\'s message.posted: no line', async () => {
    const server = fakeServer({
      pages: [[makeEvent('evt-peer', { type: 'message.posted', payload: { messageId: 'peer-1' } })]],
      tail: [peerSaid('peer-1')],
    });
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      server.childCheckpoints('evt-peer');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.wrapperPosts).toEqual([]);
  });

  test('a peer in an agent-dm: no line, which would wake it into a paid turn', async () => {
    const server = fakeServer({
      pages: [[makeEvent('evt-dm', { payload: { messageId: 'peer-1', dmKind: 'agent-agent' } })]],
      tail: [peerSaid('peer-1')],
    });
    const spawn = jest.fn(async () => {
      server.childPosts('part-one');
      server.childCheckpoints('evt-dm');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.wrapperPosts).toEqual([]);
  });

  test('a peer agent\'s comment: no line', async () => {
    const server = fakeServer({ pages: [[commentEvent('evt-peer-comment', { senderIsHuman: false })]] });
    const spawn = jest.fn(async () => {
      server.childCheckpoints('evt-peer-comment');
      throw killed();
    });
    await runToTheEnd(spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.comments).toEqual([]);
  });

  test('a heartbeat nobody is waiting on: no line', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-beat', { type: 'heartbeat' })]] });
    const spawn = jest.fn(async () => {
      server.childPosts('progress-note');
      server.childCheckpoints('evt-beat');
      throw killed();
    });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(server.wrapperPosts).toEqual([]);
    } finally { run.handle.stop(); }
  });
});

describe('what the line says', () => {
  test('one plain sentence, with no runtime words and no sentinel', () => {
    expect(CUT_OFF_NOTICE.match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(CUT_OFF_NOTICE).not.toMatch(/checkpoint|event|turn|deliver|retry|runtime|session|exit|NO_REPLY|HEARTBEAT|@/i);
    expect(CUT_OFF_NOTICE.length).toBeLessThan(120);
  });
});
