/**
 * Channel mode, unaddressed questions (COMMONLY_MCP_CHANNEL_QUESTIONS=1): a
 * question an allowed person asks the pod without naming anyone reaches the
 * session; routine chatter, someone else's thread, agents and a burst past the
 * per-pod cap don't. Off by default: mention-only stays what it was.
 */

import {
  QUESTION_CAP,
  QUESTION_WINDOW_MS,
  channelEventFor,
  decide,
  isQuestion,
  questionsRequested,
  startChannel,
} from '../src/channel.js';

const cfg = { baseUrl: 'https://x.example', token: 'cm_agent_t' };
const OWNER = 'a'.repeat(24);
const STRANGER = 'b'.repeat(24);
const ON = { COMMONLY_MCP_CHANNEL_QUESTIONS: '1' };
const gate = { allowed: new Set([OWNER]), explicit: new Set() };

const posted = (over = {}, payload = {}) => ({
  _id: over._id || 'q1',
  type: 'message.posted',
  deliveryMode: 'wake',
  podId: 'p1',
  ...over,
  payload: {
    messageId: '601',
    userId: OWNER,
    senderIsHuman: true,
    rawContent: 'can someone check the deploy?',
    content: '[frames]\n\ncan someone check the deploy?',
    deliveryId: 'd1',
    ...payload,
  },
});

const fakeApi = (pages, { installations = [] } = {}) => {
  const calls = [];
  let page = 0;
  const requestImpl = async (_config, { method, path, body }) => {
    calls.push({ method, path, body });
    if (path === '/api/agents/runtime/installations') return { installations, ownerUserId: OWNER };
    if (path === '/api/agents/runtime/events') {
      const next = pages[page];
      page += 1;
      return { events: next || [] };
    }
    if (path.endsWith('/ack')) return { success: true };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { requestImpl, acks: () => calls.filter((c) => c.path.endsWith('/ack')) };
};

const waitFor = async (check, ms = 2000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => { setTimeout(r, 5); });
  }
};

const drive = async ({ api, env = ON, acks, now }) => {
  const pushed = [];
  const logs = [];
  const channel = startChannel({
    config: cfg,
    env,
    notify: async (params) => { pushed.push(params); },
    log: (line) => logs.push(line),
    requestImpl: api.requestImpl,
    intervalMs: 5,
    busyDelayMs: 1,
    ...(now ? { now } : {}),
  });
  await waitFor(() => api.acks().length >= acks);
  channel.stop();
  await channel.done;
  return { pushed, logs };
};

describe('opt-in', () => {
  it('is off unless COMMONLY_MCP_CHANNEL_QUESTIONS is set', () => {
    expect(questionsRequested({ env: {} })).toBe(false);
    expect(questionsRequested({ env: { COMMONLY_MCP_CHANNEL_QUESTIONS: '0' } })).toBe(false);
    expect(questionsRequested({ env: ON })).toBe(true);
  });

  it('with it off, a question is acked without a push, as before', () => {
    expect(decide(posted(), gate)).toEqual({ push: false, reason: 'message.posted is not a mention' });
  });
});

describe('what counts as a question (structural, no model call)', () => {
  it.each([
    ['can someone check the deploy?', true],
    ['部署好了吗？', true],
    ['(is it down?) asking for a friend', true],
    ['能帮我看下部署吗？我这边报错了', true],
    ['is prod down?!', true],
    ['**anyone free?**', true],
    ['done, see https://x.example/a?b=1', false],
    ['try `a?.b` there', false],
    ['```\nwhy?\n```', false],
    ['shipped it', false],
    ['', false],
  ])('%j -> %s', (text, expected) => {
    expect(isQuestion(text)).toBe(expected);
  });
});

describe('which question is pushed', () => {
  const on = { questions: true };

  it('pushes an allowed person\'s question that named nobody', () => {
    expect(decide(posted(), gate, on)).toEqual({ push: true, question: true });
  });

  it('reads the author\'s own words, not the kernel frames', () => {
    expect(decide(posted({}, { rawContent: 'shipped it', content: 'frame? \n\nshipped it' }), gate, on).reason).toBe('not a question');
  });

  it.each([
    ['a digest row', posted({ deliveryMode: 'digest' })],
    ['not from a person', posted({}, { senderIsHuman: false })],
    ['not from a person', posted({}, { senderIsHuman: undefined })],
    ['sender is not allowed', posted({}, { userId: STRANGER })],
    ['a wake the kernel wrote', posted({}, { triggerAuthor: 'kernel' })],
    ["a reply in someone else's thread", posted({}, { threadRootId: 55 })],
    ['it joins more than one message', posted({}, { coalesced: [{ messageId: '602', userId: OWNER }] })],
    ['not a question', posted({}, { rawContent: 'shipped it' })],
  ])('refuses: %s', (reason, event) => {
    expect(decide(event, gate, on)).toEqual({ push: false, reason });
  });

  it('pushes a question in a thread that replies to this agent', () => {
    expect(decide(posted({}, { threadRootId: 55, repliesToYourMessage: true }), gate, on).push).toBe(true);
  });

  it('pushes a question in a thread the kernel addressed to this agent', () => {
    expect(decide(posted({}, { threadRootId: 55, addressed: true }), gate, on).push).toBe(true);
  });

  it('leaves mentions exactly as they were', () => {
    const mention = posted({ type: 'chat.mention' }, { rawContent: 'no question mark' });
    expect(decide(mention, gate, on)).toEqual({ push: true });
  });
});

describe('the pushed event', () => {
  it('answers a top-level question in its own thread and says nobody was named', () => {
    const { content, meta } = channelEventFor(posted());
    expect(meta.thread_root_id).toBe('601');
    expect(meta.event_type).toBe('message.posted');
    expect(content).toMatch(/No agent was named/);
    expect(content).toMatch(/otherwise post nothing/);
  });

  it('answers a question inside a thread in that thread', () => {
    expect(channelEventFor(posted({}, { threadRootId: 55, repliesToYourMessage: true })).meta.thread_root_id).toBe('55');
  });

  it('leaves a mention without the question note', () => {
    expect(channelEventFor(posted({ type: 'chat.mention' })).content).not.toMatch(/No agent was named/);
  });
});

describe('poll loop', () => {
  it('pushes a question and acks it as delivered, and says at start that questions are on', async () => {
    const api = fakeApi([[posted()]]);
    const { pushed, logs } = await drive({ api, acks: 1 });
    expect(pushed).toHaveLength(1);
    expect(api.acks()[0].body.result.outcome).toBe('acknowledged');
    expect(logs.join('\n')).toMatch(/questions are on/);
    expect(logs.join('\n')).toMatch(/Messages from people/);
  });

  it('names each shared pod set to Mentions only, and the setting to change', async () => {
    const api = fakeApi([[posted()]], {
      installations: [
        { type: 'installation', podId: 'p1', podName: 'Release', podType: 'chat', messageWake: 'mentions' },
        { type: 'installation', podId: 'p2', podName: 'Design', podType: 'chat', messageWake: 'human' },
        { type: 'installation', podId: 'p3', podName: 'Me', podType: 'agent-room', messageWake: 'mentions' },
        { type: 'dm', podId: 'p4', podName: 'Admin', podType: 'agent-admin' },
      ],
    });
    const { logs } = await drive({ api, acks: 1 });
    const text = logs.join('\n');
    expect(text).toMatch(/won't arrive from "Release": set to "Mentions only"/);
    expect(text).toMatch(/"Messages from people"/);
    expect(text).not.toMatch(/"Design"|"Me"|"Admin"/);
  });

  it('says nothing per pod when every shared pod already hears people', async () => {
    const api = fakeApi([[posted()]], {
      installations: [{ type: 'installation', podId: 'p2', podName: 'Design', podType: 'chat', messageWake: 'human' }],
    });
    const { logs } = await drive({ api, acks: 1 });
    expect(logs.join('\n')).not.toMatch(/won't arrive from/);
  });

  it('reads the setting even with an explicit allowlist, and falls back to the general hint on an older server', async () => {
    const api = fakeApi([[posted()]], { installations: [{ type: 'installation', podId: 'p1', podName: 'Release', podType: 'chat' }] });
    const { logs } = await drive({ api, env: { ...ON, COMMONLY_MCP_CHANNEL_ALLOW: OWNER }, acks: 1 });
    const text = logs.join('\n');
    expect(text).toMatch(/arrives only from a pod where/);
    expect(text).not.toMatch(/won't arrive from/);
  });

  it('with the flag unset, acks the question with no push and no questions line', async () => {
    const api = fakeApi([[posted()]]);
    const { pushed, logs } = await drive({ api, env: {}, acks: 1 });
    expect(pushed).toHaveLength(0);
    expect(api.acks()[0].body.result).toEqual({ outcome: 'no_action', reason: 'channel mode: message.posted is not a mention' });
    expect(logs.join('\n')).not.toMatch(/questions are on/);
  });

  it(`caps questions at ${QUESTION_CAP} per pod per window, and the window reopens`, async () => {
    let clock = 1_000_000;
    const burst = Array.from({ length: QUESTION_CAP + 1 }, (_, i) => posted({ _id: `q${i}` }, { messageId: String(700 + i) }));
    const other = posted({ _id: 'other', podId: 'p2' });
    const later = posted({ _id: 'later' }, { messageId: '800' });
    const api = fakeApi([burst, [other]]);
    const pages = api.requestImpl;
    let polls = 0;
    api.requestImpl = async (config, opts) => {
      if (opts.path === '/api/agents/runtime/events') {
        polls += 1;
        // After the burst and the other pod, the window has passed.
        if (polls === 3) { clock += QUESTION_WINDOW_MS + 1; return { events: [later] }; }
      }
      return pages(config, opts);
    };
    const { pushed, logs } = await drive({ api, acks: QUESTION_CAP + 3, now: () => clock });

    const ids = pushed.map((p) => p.meta.event_id);
    expect(ids).toEqual([...burst.slice(0, QUESTION_CAP).map((e) => e._id), 'other', 'later']);
    const capped = api.acks().find((a) => a.path.includes(`/q${QUESTION_CAP}/`));
    expect(capped.body.result.outcome).toBe('no_action');
    expect(logs.join('\n')).toMatch(/questions already pushed from this pod/);
  });
});
