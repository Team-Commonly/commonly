/**
 * F662 in the run loop: a wrapped Claude Code or Codex agent that runs on its
 * owner's account refuses, before anything spawns, a turn someone else started
 * in a pod open to strangers or in a DM, and warns once in any other pod. It
 * works from the server's `payload.accountUse` stamp, and from one
 * `/installations` read per batch against an older server that sends none.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const sessionsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-account-use-'));

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
const { commonlyMcpServer } = await import('../src/lib/default-environment.js');

const drain = async () => {
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

const POD = 'pod-acct';
const OWNER = 'owner-1';
const STRANGER = 'stranger-2';
const TEAM = { type: 'chat', publicRead: false, communityListed: false, joinPolicy: 'open' };
const LISTED = { type: 'chat', publicRead: false, communityListed: true, joinPolicy: 'open' };
const ROOM = { type: 'agent-room', publicRead: false, communityListed: false, joinPolicy: 'invite-only' };

let seq = 0;
const mention = ({
  from = STRANGER, pod = LISTED, stamp = true, type = 'chat.mention', content, shares = null, payload = {},
} = {}) => {
  seq += 1;
  return {
    _id: `evt-${seq}`,
    type,
    podId: POD,
    agentName: 'seat',
    instanceId: 'default',
    payload: {
      content: content || `@seat request ${seq} from ${from}`,
      messageId: `m-${seq}`,
      userId: from,
      senderIsHuman: true,
      ...(stamp ? {
        accountUse: {
          v: 1,
          ownerUserId: OWNER,
          ownerName: 'sam',
          requesterUserIds: [from],
          requesterKind: 'human',
          requesterSharesTeamPod: shares,
          pod,
        },
      } : {}),
      ...payload,
    },
  };
};

// One run over one page. `installations` is the /installations answer, or an
// Error to throw. `claimed: false` loses every message claim to a peer.
// `environment` defaults to a confined seat, whose placement reads no pods.
// `installations` may also be a list, one answer per read, the last repeating.
// `podMessages: true` serves this agent's own posts back from the pod's message
// read, marked `self`, as a current server does. `failAcks` makes every ack throw.
const run = async ({
  events, adapterName = 'claude', installations = null, claimed = true,
  environment = { model: 'm', sandbox: { trust: 'public' } }, workspacePath, podMessages = false, failAcks = false,
}) => {
  let polls = 0;
  let reads = 0;
  const posted = [];
  const get = jest.fn(async (route) => {
    if (route === '/api/agents/runtime/events') {
      polls += 1;
      return { events: polls === 1 ? events : [] };
    }
    if (route === '/api/agents/runtime/installations') {
      const answer = Array.isArray(installations) ? installations[Math.min(reads, installations.length - 1)] : installations;
      reads += 1;
      if (answer instanceof Error) throw answer;
      return answer || { installations: [] };
    }
    if (route.endsWith('/messages')) return { messages: podMessages ? [...posted] : [] };
    return {};
  });
  const post = jest.fn(async (route, body) => {
    if (failAcks && String(route).endsWith('/ack')) throw new Error('ack lost');
    if (podMessages && route === `/api/agents/runtime/pods/${POD}/messages`) {
      posted.push({
        _id: `own-${posted.length + 1}`, content: body.content, isBot: true, self: true, username: 'seat',
      });
    }
    if (!String(route).endsWith('/claim')) return {};
    return claimed ? { claimed: true, expiresAt: 'later' } : { claimed: false, holder: { agentName: 'peer', instanceId: 'default' } };
  });
  const logs = [];
  createClient.mockReturnValue({ get, post, del: jest.fn().mockResolvedValue({}) });
  const spawn = jest.fn(async () => ({ text: 'done' }));
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    adapter: { name: adapterName, detect: stubAdapter.detect, spawn },
    agentName: 'seat',
    environment,
    ...(workspacePath ? { workspacePath } : {}),
    log: (line) => logs.push(String(line)),
    retryJitterRatio: 0,
    claimYieldDelayMs: 0,
    sleepImpl: async () => {},
    setTimeoutImpl: () => 0,
  });
  await drain();
  handle.stop();
  const podPosts = post.mock.calls
    .filter(([route]) => route === `/api/agents/runtime/pods/${POD}/messages`)
    .map(([, body]) => body.content);
  return {
    spawn,
    get,
    acks: post.mock.calls.filter(([route]) => String(route).endsWith('/ack'))
      .map(([route, body]) => ({ id: String(route).split('/').at(-2), result: body.result })),
    notices: podPosts.filter((content) => /I run on|Heads up: I run on/.test(content)),
    replies: podPosts.filter((content) => content === 'done'),
    installationReads: get.mock.calls.filter(([route]) => route === '/api/agents/runtime/installations').length,
    logs,
  };
};

const REFUSED_ACK = { outcome: 'no_action', reason: 'account-not-owner' };

test('a stranger in a listed pod never reaches the adapter, and is acked as refused', async () => {
  const event = mention();
  const out = await run({ events: [event] });
  expect(out.spawn).not.toHaveBeenCalled();
  expect(out.acks).toEqual([{ id: event._id, result: REFUSED_ACK }]);
  expect(out.notices).toEqual([expect.stringMatching(/^I run on sam's own Claude Code account, and this pod is open/)]);
  expect(out.installationReads).toBe(0);
});

test('the refusal notice posts once per pod and requester within the window', async () => {
  const first = await run({ events: [mention()] });
  expect(first.notices).toHaveLength(1);
  const again = await run({ events: [mention()] });
  expect(again.notices).toEqual([]);
  expect(again.acks[0].result).toEqual(REFUSED_ACK);
  const other = await run({ events: [mention({ from: 'stranger-3' })] });
  expect(other.notices).toHaveLength(1);
});

test('two refused items from one person in a batch post one notice', async () => {
  const out = await run({ events: [mention(), mention()] });
  expect(out.notices).toHaveLength(1);
  expect(out.acks.map((ack) => ack.result)).toEqual([REFUSED_ACK, REFUSED_ACK]);
});

test('an ambient message nobody waits on is refused silently', async () => {
  const event = mention({ type: 'message.posted' });
  const out = await run({ events: [event] });
  expect(out.spawn).not.toHaveBeenCalled();
  expect(out.notices).toEqual([]);
  expect(out.acks).toEqual([{ id: event._id, result: REFUSED_ACK }]);
});

test('a mixed batch runs the owner\'s item and refuses the other', async () => {
  const mine = mention({ from: OWNER, content: '@seat the owner asks' });
  const theirs = mention({ content: '@seat a stranger asks' });
  const out = await run({ events: [mine, theirs] });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  const prompt = JSON.stringify(out.spawn.mock.calls[0]);
  expect(prompt).toContain('the owner asks');
  expect(prompt).not.toContain('a stranger asks');
  expect(out.acks.find((ack) => ack.id === theirs._id).result).toEqual(REFUSED_ACK);
  expect(out.acks.find((ack) => ack.id === mine._id).result.reason).not.toBe('account-not-owner');
});

test('a team pod warns once, across a restart, and the turn runs', async () => {
  const first = await run({ events: [mention({ pod: TEAM })] });
  expect(first.spawn).toHaveBeenCalledTimes(1);
  expect(first.notices).toEqual([expect.stringMatching(/^Heads up: I run on sam's own Claude Code account, so requests from others in this pod/)]);
  // Same sessions dir, new process.
  const second = await run({ events: [mention({ pod: TEAM, from: 'stranger-3' })] });
  expect(second.spawn).toHaveBeenCalledTimes(1);
  expect(second.notices).toEqual([]);
});

test('a pod that turns open after the warn refuses the next event', async () => {
  await run({ events: [mention({ pod: TEAM })] });
  const out = await run({ events: [mention({ pod: LISTED })] });
  expect(out.spawn).not.toHaveBeenCalled();
  expect(out.acks[0].result).toEqual(REFUSED_ACK);
});

test('in a DM, a sender who shares a team pod is warned once and answered', async () => {
  const first = await run({ events: [mention({ type: 'dm.message', pod: ROOM, shares: true })] });
  expect(first.spawn).toHaveBeenCalledTimes(1);
  expect(first.notices).toEqual([expect.stringMatching(/^Heads up: .* so your requests here use their login/)]);
  const second = await run({ events: [mention({ type: 'dm.message', pod: ROOM, shares: true })] });
  expect(second.spawn).toHaveBeenCalledTimes(1);
  expect(second.notices).toEqual([]);
});

test('in a DM, a stranger is refused with the DM line', async () => {
  const out = await run({ events: [mention({ type: 'dm.message', pod: ROOM, shares: false })] });
  expect(out.spawn).not.toHaveBeenCalled();
  expect(out.acks[0].result).toEqual(REFUSED_ACK);
  expect(out.notices).toEqual([expect.stringMatching(/so in direct messages I only take requests from sam and people who share a team pod/)]);
});

// A board wake carries task text people wrote, so it isn't a kernel wake.
const boardWake = (pod) => {
  const event = mention({ pod, payload: { triggerAuthor: 'kernel', boardWake: true, senderIsHuman: undefined, userId: undefined } });
  Object.assign(event.payload.accountUse, { requesterKind: 'unknown', requesterUserIds: [] });
  return event;
};

test('a board wake is refused in an open pod', async () => {
  const out = await run({ events: [boardWake(LISTED)] });
  expect(out.spawn).not.toHaveBeenCalled();
  expect(out.acks[0].result).toEqual(REFUSED_ACK);
});

test('a board wake is warned once in a team pod and runs', async () => {
  const out = await run({ events: [boardWake(TEAM)] });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  expect(out.notices).toEqual([expect.stringMatching(/^Heads up: I run on sam's own Claude Code account/)]);
});

test('an agent sender in a team pod is warned, even the owner\'s own other agent', async () => {
  const event = mention({ pod: TEAM, from: 'owners-other-bot', payload: { senderIsHuman: false } });
  event.payload.accountUse.requesterKind = 'agent';
  const out = await run({ events: [event] });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  expect(out.notices).toHaveLength(1);
});

test('the stub adapter makes no reads and posts no notices', async () => {
  const out = await run({ events: [mention(), mention({ stamp: false })], adapterName: 'stub' });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  expect(out.notices).toEqual([]);
  expect(out.installationReads).toBe(0);
  expect(out.acks.every((ack) => ack.result.reason !== 'account-not-owner')).toBe(true);
});

describe('against a server with no stamp', () => {
  const identity = (pod, ownerUserId = OWNER) => ({
    ownerUserId,
    installations: [{
      podId: POD, podType: pod.type, publicRead: pod.publicRead, communityListed: pod.communityListed, joinPolicy: pod.joinPolicy,
    }],
  });

  test('it reads /installations once per batch, and warns in a team pod', async () => {
    const out = await run({ events: [mention({ stamp: false }), mention({ stamp: false })], installations: identity(TEAM) });
    expect(out.installationReads).toBe(1);
    expect(out.spawn).toHaveBeenCalledTimes(1);
    expect(out.notices).toEqual([expect.stringMatching(/^Heads up: I run on the owner's own Claude Code account/)]);
  });

  test('a person in a pod known open is refused, and the owner is answered', async () => {
    const out = await run({
      events: [mention({ stamp: false }), mention({ stamp: false, from: OWNER })], installations: identity(LISTED),
    });
    expect(out.installationReads).toBe(1);
    expect(out.spawn).toHaveBeenCalledTimes(1);
    expect(out.acks.filter((ack) => ack.result.reason === 'account-not-owner')).toHaveLength(1);
  });

  test('a DM is refused, since nothing says the sender shares a team pod', async () => {
    const out = await run({ events: [mention({ stamp: false, type: 'dm.message', pod: ROOM })], installations: identity(ROOM) });
    expect(out.spawn).not.toHaveBeenCalled();
    expect(out.acks[0].result).toEqual(REFUSED_ACK);
  });

  test('a failed read leaves the event unacked to retry', async () => {
    const out = await run({ events: [mention({ stamp: false })], installations: new Error('socket hang up') });
    expect(out.spawn).not.toHaveBeenCalled();
    expect(out.acks).toEqual([]);
    expect(out.notices).toEqual([]);
  });

  test('a heartbeat needs no read', async () => {
    const out = await run({ events: [{ _id: 'hb-1', type: 'heartbeat', podId: POD, payload: {} }] });
    expect(out.installationReads).toBe(0);
    expect(out.spawn).toHaveBeenCalledTimes(1);
  });
});

test('the turn\'s count leaves the refused item out', async () => {
  const out = await run({ events: [mention({ from: OWNER }), mention()] });
  const prompt = String(out.spawn.mock.calls[0][0]);
  expect(prompt).toContain('[Inbox batch: 1 new event in this pod.');
  expect(out.spawn.mock.calls[0][1].metadata.event.payload.batchEventIds).toHaveLength(1);
});

test('an ask from an agent with another owner in a listed pod is answered with the refusal, not run', async () => {
  const ask = mention({ type: 'agent.ask', payload: { requestId: 'req-1', fromAgent: 'peer', question: 'review this?' } });
  ask.payload.accountUse.requesterKind = 'agent';
  let polls = 0;
  const post = jest.fn(async () => ({}));
  createClient.mockReturnValue({
    get: jest.fn(async (route) => {
      if (route === '/api/agents/runtime/events') {
        polls += 1;
        return { events: polls === 1 ? [ask] : [] };
      }
      return { messages: [] };
    }),
    post,
    del: jest.fn(),
  });
  const spawn = jest.fn(async () => ({ text: 'done' }));
  const handle = performRun({
    instanceUrl: 'http://localhost:5000',
    token: 'cm_agent_test',
    agentName: 'seat',
    adapter: { name: 'codex', detect: stubAdapter.detect, spawn },
    environment: { model: 'm', sandbox: { trust: 'public' } },
    setTimeoutImpl: () => 0,
  });
  await drain();
  handle.stop();
  expect(spawn).not.toHaveBeenCalled();
  const respond = post.mock.calls.find(([route]) => route === '/api/agents/runtime/asks/req-1/respond');
  expect(respond[1].content).toMatch(/^I run on sam's own Codex account, and this pod is open/);
  const ack = post.mock.calls.find(([route]) => String(route).endsWith(`/events/${ask._id}/ack`));
  expect(ack[1].result).toEqual(REFUSED_ACK);
});

// `agent run` is a long action with no harness of its own, so the boot line is
// pinned as text.
test('the agent run boot prints the account line once, for claude and codex only', () => {
  const source = fs.readFileSync(new URL('../src/commands/agent.js', import.meta.url), 'utf8');
  const boot = source.match(/if \(ACCOUNT_BOUND_ADAPTERS\.has\(adapter\.name\)\) \{\n\s*console\.log\(`\$\{stamp\(\)\} \[\$\{name\}\] \$\{accountUseSetupLine\(/g) || [];
  expect(boot).toHaveLength(1);
});

// Review follow-ups.

test('a refused item does not count toward the batch\'s flags: a heartbeat beside it stays heartbeat-only', async () => {
  const heartbeat = { _id: 'hb-flags', type: 'heartbeat', podId: POD, payload: {} };
  // A seat with the commonly tools posts for itself, so its heartbeat's final
  // text is narration and is dropped, unless someone is waiting.
  const out = await run({
    events: [heartbeat, mention()],
    environment: { model: 'm', sandbox: { trust: 'public' }, mcp: [commonlyMcpServer()] },
  });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  const { payload } = out.spawn.mock.calls[0][1].metadata.event;
  expect(payload.onlyHeartbeat).toBe(true);
  expect(payload.hasHeartbeat).toBe(true);
  expect(payload.someoneWaiting).toBe(false);
  // A heartbeat's final text is never posted.
  expect(out.replies).toEqual([]);
});

test('a refused agent is not told: the notice would wake it into a paid turn', async () => {
  const event = mention({ from: 'peer-bot', payload: { senderIsHuman: false } });
  event.payload.accountUse.requesterKind = 'agent';
  const out = await run({ events: [event] });
  expect(out.spawn).not.toHaveBeenCalled();
  expect(out.acks).toEqual([{ id: event._id, result: REFUSED_ACK }]);
  expect(out.notices).toEqual([]);
});

test('without the stamp, a sender not known to be a person is not told either', async () => {
  const identity = {
    ownerUserId: OWNER,
    installations: [{ podId: POD, podType: 'chat', publicRead: false, communityListed: true, joinPolicy: 'open' }],
  };
  const event = mention({ stamp: false, from: 'peer-bot', payload: { senderIsHuman: false } });
  const out = await run({ events: [event], installations: identity });
  expect(out.acks).toEqual([{ id: event._id, result: REFUSED_ACK }]);
  expect(out.notices).toEqual([]);
});

test('a lost claim does not spend the once-per-pod warn', async () => {
  const ambient = () => mention({ pod: TEAM, type: 'message.posted' });
  const lost = await run({ events: [ambient()], claimed: false });
  expect(lost.spawn).not.toHaveBeenCalled();
  expect(lost.notices).toEqual([]);
  const won = await run({ events: [ambient()] });
  expect(won.spawn).toHaveBeenCalledTimes(1);
  expect(won.notices).toHaveLength(1);
});

test('placement reads the pods fresh: a pod private at judgment and public at placement gets the scratch folder', async () => {
  const workspaceDir = fs.mkdtempSync(path.join(sessionsTmpDir, 'workspace-'));
  const row = (publicRead) => ({
    ownerUserId: OWNER,
    installations: [{ podId: POD, podType: 'chat', publicRead, communityListed: false, joinPolicy: 'invite-only' }],
  });
  const out = await run({
    events: [mention({ stamp: false, from: OWNER })],
    installations: [row(false), row(true)],
    environment: { model: 'm', sandbox: { trust: 'workspace' } },
    workspacePath: workspaceDir,
  });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  const ctx = out.spawn.mock.calls[0][1];
  expect(ctx.cwd).not.toBe(workspaceDir);
  expect(ctx.environment.sandbox.trust).toBe('public');
  // One read for the guard, one fresh read for the placement.
  expect(out.installationReads).toBe(2);
});

test('a refusal whose ack was lost stays out of the turn when it is redelivered beside the owner\'s request', async () => {
  const theirs = mention({ content: '@seat a stranger asks for the secret plan' });
  const first = await run({ events: [theirs], failAcks: true });
  expect(first.spawn).not.toHaveBeenCalled();
  const mine = mention({ from: OWNER, content: '@seat the owner asks' });
  const out = await run({ events: [mine, theirs] });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  const prompt = JSON.stringify(out.spawn.mock.calls[0]);
  expect(prompt).toContain('the owner asks');
  expect(prompt).not.toContain('a stranger asks for the secret plan');
  const { payload } = out.spawn.mock.calls[0][1].metadata.event;
  expect(payload.batchEventIds).toEqual([mine._id]);
  expect(String(out.spawn.mock.calls[0][0])).toContain('[Inbox batch: 1 new event in this pod.');
});

test('the one-time warning is not taken for the model\'s own post: its answer is still delivered', async () => {
  const out = await run({ events: [mention({ pod: TEAM })], podMessages: true });
  expect(out.spawn).toHaveBeenCalledTimes(1);
  expect(out.notices).toHaveLength(1);
  expect(out.replies).toEqual(['done']);
});

describe('a ruling, against a server with no stamp', () => {
  const ruled = (ruler) => {
    seq += 1;
    return {
      _id: `evt-${seq}`,
      type: 'decision.ruled',
      podId: POD,
      agentName: 'seat',
      instanceId: 'default',
      payload: {
        decisionId: `d-${seq}`,
        pick: 'ship it',
        ruledBy: { userId: ruler, username: ruler },
        ruledAt: '2026-11-27T00:00:00.000Z',
        rulingMessageId: `m-${seq}`,
        podId: POD,
      },
    };
  };
  const identity = (pod) => ({
    ownerUserId: OWNER,
    installations: [{
      podId: POD, podType: pod.type, publicRead: pod.publicRead, communityListed: pod.communityListed, joinPolicy: pod.joinPolicy,
    }],
  });

  test.each([['an open pod', LISTED], ['a DM', ROOM]])('the owner\'s ruling runs in %s', async (_label, pod) => {
    const event = ruled(OWNER);
    const out = await run({ events: [event], installations: identity(pod) });
    expect(out.spawn).toHaveBeenCalledTimes(1);
    expect(out.acks.find((ack) => ack.id === event._id).result.reason).not.toBe('account-not-owner');
  });

  test.each([['an open pod', LISTED], ['a DM', ROOM]])('someone else\'s ruling is refused in %s', async (_label, pod) => {
    const event = ruled(STRANGER);
    const out = await run({ events: [event], installations: identity(pod) });
    expect(out.spawn).not.toHaveBeenCalled();
    expect(out.acks).toEqual([{ id: event._id, result: REFUSED_ACK }]);
  });

  test('someone else\'s ruling in a team pod runs, with the warning', async () => {
    const out = await run({ events: [ruled(STRANGER)], installations: identity(TEAM) });
    expect(out.spawn).toHaveBeenCalledTimes(1);
    expect(out.notices).toEqual([expect.stringMatching(/^Heads up: I run on the owner's own Claude Code account/)]);
  });
});

test('no owner on record is said once in the log, never in the pod', async () => {
  const identity = {
    ownerUserId: null,
    installations: [{ podId: POD, podType: 'chat', publicRead: false, communityListed: false, joinPolicy: 'open' }],
  };
  const out = await run({ events: [mention({ stamp: false, from: OWNER }), mention({ stamp: false, from: OWNER })], installations: identity });
  const line = 'No owner is on record for this agent, so it treats every message as someone else\'s. '
    + 'Run `commonly agent attach` again to fix it.';
  expect(out.logs.filter((entry) => entry.includes(line))).toHaveLength(1);
  expect(out.notices.join('\n')).not.toContain('No owner is on record');
});
