/**
 * retry-knows-its-post.test.mjs — F335: a retry is told what its failed attempt posted.
 *
 * A turn that posts through a tool and then fails is retried with the same
 * prompt, often in a fresh session, so the retry used to answer the person a
 * second time. The retry prompt now names the earlier post.
 *
 * The harness is copied from cut-off-turn-notice.test.mjs, whose header follows.
 *
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

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retry-post-test-'));

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
const { performRun, earlierAttemptPosted } = await import('../src/commands/agent.js');
const stubAdapter = (await import('../src/lib/adapters/stub.js')).default;
const { CUT_OFF_NOTICE, WONT_START_NOTICE } = await import('../src/lib/turn-failure-notice.js');

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
      tail.push(seatSaid(`wrapper-${wrapperPosts.length}`, { content: body.content }));
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
const REFUSAL_TEXT = 'codex turn failed: This content was flagged for possible cybersecurity risk.';
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


const EARLIER = 'An earlier attempt at this item failed after it posted in this pod';
const retryOnce = async (run) => {
  await run.scheduled.shift().callback();
  await drainMicrotasks();
};

describe('a retry after an attempt that posted', () => {
  test('names the post and says not to repeat it', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-dup')]] });
    const spawn = jest.fn()
      .mockImplementationOnce(async () => {
        server.childPosts('part-one', { content: 'Here is the answer: use the staging key.' });
        throw killed();
      })
      .mockResolvedValueOnce({ text: 'NO_REPLY' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      expect(spawn.mock.calls[0][0]).not.toContain(EARLIER);
      await retryOnce(run);
      expect(spawn).toHaveBeenCalledTimes(2);
      const prompt = spawn.mock.calls[1][0];
      expect(prompt).toContain(`${EARLIER} (message part-one)`);
      expect(prompt).toContain('"Here is the answer: use the staging key."');
      expect(prompt).toContain("don't post it again");
      expect(noticesIn(server)).toEqual([]);
    } finally { run.handle.stop(); }
  });

  test('says nothing extra when the failed attempt posted nothing', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-quiet')]] });
    const spawn = jest.fn()
      .mockImplementationOnce(async () => { throw killed(); })
      .mockResolvedValueOnce({ text: 'NO_REPLY' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await retryOnce(run);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][0]).not.toContain(EARLIER);
    } finally { run.handle.stop(); }
  });

  test("doesn't count a person's message, or its own post from before the turn", async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-other')]], tail: [seatSaid('old'), personSaid('seen')] });
    const spawn = jest.fn()
      .mockImplementationOnce(async () => {
        server.somebodyPosts('person-mid-turn');
        throw killed();
      })
      .mockResolvedValueOnce({ text: 'NO_REPLY' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await retryOnce(run);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][0]).not.toContain(EARLIER);
    } finally { run.handle.stop(); }
  });

  test('a later attempt still hears it, and names the newest post', async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-twice')]] });
    const spawn = jest.fn()
      .mockImplementationOnce(async () => {
        server.childPosts('part-one', { content: 'Part one.' });
        throw killed();
      })
      .mockImplementationOnce(async () => {
        server.childPosts('part-two', { content: 'Part two.' });
        throw killed();
      })
      .mockResolvedValueOnce({ text: 'NO_REPLY' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await retryOnce(run);
      expect(spawn.mock.calls[1][0]).toContain(`${EARLIER} (message part-one)`);
      await retryOnce(run);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn.mock.calls[2][0]).toContain(`${EARLIER} (message part-two)`);
      expect(spawn.mock.calls[2][0]).not.toContain('(message part-one)');
    } finally { run.handle.stop(); }
  });
});

describe('a batch', () => {
  test("doesn't claim the post answered each item, since the attempt can't say which", async () => {
    const server = fakeServer({ pages: [[makeEvent('evt-a'), makeEvent('evt-b')]] });
    const spawn = jest.fn()
      .mockImplementationOnce(async () => {
        server.childPosts('answer-a', { content: 'Answer for a.' });
        throw killed();
      })
      .mockResolvedValue({ text: 'NO_REPLY' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await retryOnce(run);
      const prompt = spawn.mock.calls[1][0];
      expect(prompt).toContain('An earlier attempt at this batch failed after it posted in this pod (message answer-a)');
      expect(prompt).toContain('It may answer this item or another one here.');
      expect(prompt).toContain('end with NO_REPLY only once every item is handled.');
      expect(prompt).not.toContain('checkpoint it and end with NO_REPLY');
      expect(prompt).not.toContain(EARLIER);
    } finally { run.handle.stop(); }
  });

  test("a peer's read-only item isn't told to add to the earlier post", async () => {
    const server = fakeServer({ pages: [[
      makeEvent('evt-ro', { type: 'message.posted', payload: { messageId: 'msg-ro' } }),
      makeEvent('evt-b'),
    ]] });
    const client = createClient();
    const serve = client.post.getMockImplementation();
    let peerWins = false;
    client.post.mockImplementation(async (route, body) => (String(route).endsWith('/claim') && peerWins
      ? { claimed: false, holder: { agentName: 'peer', instanceId: 'default' } }
      : serve(route, body)));
    const spawn = jest.fn()
      .mockImplementationOnce(async () => {
        server.childPosts('answer-b', { content: 'Answer for b.' });
        peerWins = true;
        throw killed();
      })
      .mockResolvedValue({ text: 'NO_REPLY' });
    // The yield before a binding claim, skipped so the test doesn't wait it out.
    const run = startRun({ spawn, sleepImpl: async () => {} });
    try {
      await drainMicrotasks();
      await retryOnce(run);
      const prompt = spawn.mock.calls[1][0];
      const [readOnly, writable] = prompt.split(/\n\nEvent \d\/\d: /).slice(1);
      expect(readOnly).toContain('This item is read-only context');
      expect(readOnly).not.toContain('An earlier attempt');
      expect(writable).toContain('An earlier attempt at this batch failed after it posted in this pod (message answer-b)');
    } finally { run.handle.stop(); }
  });
});

describe('a comment wake', () => {
  test("isn't told a pod post answered the comment", async () => {
    const server = fakeServer({ pages: [[commentEvent('evt-comment')]] });
    const spawn = jest.fn()
      .mockImplementationOnce(async () => {
        server.childPosts('pod-post', { content: 'Answered in the pod instead.' });
        throw killed();
      })
      .mockResolvedValueOnce({ text: 'Because of the post.' });
    const run = startRun({ spawn });
    try {
      await drainMicrotasks();
      await retryOnce(run);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls[1][0]).not.toContain('An earlier attempt');
    } finally { run.handle.stop(); }
  });
});

describe('what the line says', () => {
  test('a long post is cut, and its whitespace folds to one line', () => {
    const line = earlierAttemptPosted({ id: 'm1', content: `first\n\nsecond ${'x'.repeat(400)}` });
    expect(line).toContain('beginning "first second x');
    expect(line).toContain('…"');
    expect(line).toContain('Read that message in full before you decide.');
    expect(line).not.toMatch(/\n/);
    expect(line.length).toBeLessThan(700);
  });

  test('a post with no text still names its id', () => {
    expect(earlierAttemptPosted({ id: 'm2', content: '' }))
      .toBe('[An earlier attempt at this item failed after it posted in this pod (message m2). '
        + "That post is already there: don't post it again. Add only what this item still lacks, then checkpoint. "
        + 'If it already answers this item, checkpoint it and end with NO_REPLY.]');
  });
});
