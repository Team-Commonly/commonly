// F662: the server stamps, on each event served to an own-machine (BYO) seat,
// who asked for the turn and whose account answers it (payload.accountUse).
jest.mock('../../../models/User', () => ({ find: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn(), aggregate: jest.fn() }));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { stampAccountUse, isByoSeat } = require('../../../services/accountUseStamp');

const OWNER = '64b000000000000000000001';
const HUMAN_A = '64b000000000000000000002';
const HUMAN_B = '64b000000000000000000003';
const PEER_BOT = '64b000000000000000000004';
const PEER_OWNER = '64b000000000000000000005';
const ORPHAN_BOT = '64b000000000000000000006';
const SELF_BOT = '64b000000000000000000007';
const POD = '64c000000000000000000001';
const OPEN_POD = '64c000000000000000000002';
const GONE_POD = '64c000000000000000000003';
const ROOM = '64c000000000000000000004';
const AGENT_DM = '64c000000000000000000005';
const STRANGER = '64b000000000000000000008';
const LONER = '64b000000000000000000009';

const agentUser = {
  _id: SELF_BOT,
  username: 'claude-sam',
  isBot: true,
  botMetadata: { agentName: 'claude', instanceId: 'sam', ownerUserId: OWNER },
};
const byoInstallations = [{ podId: POD, config: { runtime: { runtimeType: 'webhook', host: 'byo' } } }];

const users = [
  { _id: OWNER, username: 'sam', isBot: false },
  { _id: HUMAN_A, username: 'ana', isBot: false },
  { _id: HUMAN_B, username: 'bo', isBot: false },
  {
    _id: PEER_BOT,
    username: 'codex-pat',
    isBot: true,
    botMetadata: { agentName: 'codex', instanceId: 'pat', ownerUserId: PEER_OWNER },
  },
  { _id: ORPHAN_BOT, username: 'stray', isBot: true, botMetadata: { agentName: 'stray', instanceId: 'default' } },
  { _id: STRANGER, username: 'cy', isBot: false },
  { _id: LONER, username: 'di', isBot: false },
];
const pods = [
  { _id: POD, type: 'chat', publicRead: false, communityListed: false, joinPolicy: 'invite-only' },
  { _id: OPEN_POD, type: 'chat', publicRead: true },
  { _id: ROOM, type: 'agent-room', publicRead: false, communityListed: false, joinPolicy: 'invite-only' },
  { _id: AGENT_DM, type: 'agent-dm', publicRead: false, communityListed: false, joinPolicy: 'invite-only' },
];
// The members of the only team pod the aggregate's $match keeps (private,
// unlisted, not a DM or admin room). HUMAN_A and PEER_BOT share it with the
// calling bot; STRANGER shares only OPEN_POD (which $match drops); LONER shares
// nothing. The real pipeline runs on Mongo in the long-poll service test.
const teamPodMembers = [SELF_BOT, HUMAN_A, PEER_BOT, OWNER];
const senderIdsInPipeline = (pipeline) => pipeline
  .find((stage) => stage.$project)?.$project.hit.$setIntersection[1] || [];
const aggregateAnswer = (pipeline) => Promise.resolve(senderIdsInPipeline(pipeline)
  .filter((id) => teamPodMembers.includes(String(id)))
  .map((id) => ({ _id: id })));

const chain = (rows) => {
  const q = {
    select: jest.fn(() => q),
    lean: jest.fn(() => Promise.resolve(rows)),
  };
  return q;
};

const ev = (payload, extra = {}) => ({ _id: 'e', type: 'chat.mention', podId: POD, payload, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  User.find.mockImplementation(() => chain(users));
  Pod.find.mockImplementation(() => chain(pods));
  Pod.aggregate.mockImplementation(aggregateAnswer);
});

const stampOne = async (event) => {
  const [out] = await stampAccountUse([event], { agentUser, installations: byoInstallations });
  return out.payload.accountUse;
};

describe('stampAccountUse', () => {
  it('a human sender asks as themselves; owner and owner name come from the calling bot', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A }));
    expect(stamp).toEqual({
      v: 1,
      ownerUserId: OWNER,
      ownerName: 'sam',
      requesterUserIds: [HUMAN_A],
      requesterKind: 'human',
      pod: { type: 'chat', publicRead: false, communityListed: false, joinPolicy: 'invite-only' },
      requesterSharesTeamPod: null,
    });
  });

  it('the owner asking reads as the owner', async () => {
    const stamp = await stampOne(ev({ userId: OWNER }));
    expect(stamp.requesterUserIds).toEqual([OWNER]);
    expect(stamp.requesterKind).toBe('human');
  });

  it('an agent sender is named by its own bot id, never its owner', async () => {
    const stamp = await stampOne(ev({ userId: PEER_BOT }));
    expect(stamp.requesterUserIds).toEqual([PEER_BOT]);
    expect(stamp.requesterKind).toBe('agent');
  });

  it('an agent sender with no owner on record is still that agent', async () => {
    const stamp = await stampOne(ev({ userId: ORPHAN_BOT }));
    expect(stamp.requesterUserIds).toEqual([ORPHAN_BOT]);
    expect(stamp.requesterKind).toBe('agent');
  });

  it('another agent of the same owner is not the owner', async () => {
    User.find.mockImplementation(() => chain([...users, {
      _id: '64b0000000000000000000aa', username: 'sams-other', isBot: true,
      botMetadata: { agentName: 'other', instanceId: 'default', ownerUserId: OWNER },
    }]));
    const stamp = await stampOne(ev({ userId: '64b0000000000000000000aa' }));
    expect(stamp.requesterUserIds).toEqual(['64b0000000000000000000aa']);
    expect(stamp.requesterUserIds).not.toContain(OWNER);
    expect(stamp.requesterKind).toBe('agent');
  });

  it('a sender whose row is missing is unknown', async () => {
    const stamp = await stampOne(ev({ userId: '64b0000000000000000000ff' }));
    expect(stamp.requesterUserIds).toEqual([]);
    expect(stamp.requesterKind).toBe('unknown');
  });

  it('agent.ask names fromAgent\'s own bot id', async () => {
    const stamp = await stampOne(ev(
      { fromAgent: 'codex', fromInstanceId: 'pat', question: 'q' },
      { type: 'agent.ask' },
    ));
    expect(stamp.requesterUserIds).toEqual([PEER_BOT]);
    expect(stamp.requesterKind).toBe('agent');
    // The bot is found in the same User query, by its agent name and instance.
    const filter = User.find.mock.calls[0][0];
    expect(JSON.stringify(filter)).toContain('"botMetadata.agentName":"codex"');
  });

  it('a coalesced row of two people names both', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A, coalesced: [{ userId: HUMAN_B }] }));
    expect(stamp.requesterUserIds).toEqual([HUMAN_A, HUMAN_B]);
    expect(stamp.requesterKind).toBe('human');
  });

  it('a coalesced row of a person and an agent is human, with the agent\'s bot id in the ids', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A, coalesced: [{ userId: PEER_BOT }, { userId: HUMAN_A }] }));
    expect(stamp.requesterUserIds).toEqual([HUMAN_A, PEER_BOT]);
    expect(stamp.requesterKind).toBe('human');
  });

  it('a coalesced entry that cannot be resolved makes the row unknown, keeping the rest', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A, coalesced: [{ userId: '64b0000000000000000000ff' }] }));
    expect(stamp.requesterUserIds).toEqual([HUMAN_A]);
    expect(stamp.requesterKind).toBe('unknown');
  });

  it('a plain kernel wake is kernel', async () => {
    const stamp = await stampOne(ev({ triggerAuthor: 'kernel', content: 'x' }));
    expect(stamp.requesterKind).toBe('kernel');
    expect(stamp.requesterUserIds).toEqual([]);
  });

  it('assigned-task, board and lease wakes carry text people write, so they are unknown', async () => {
    for (const flag of [{ assignedTaskWake: true }, { boardWake: true }, { leaseWarningTaskId: 'TASK-1' }]) {
      // eslint-disable-next-line no-await-in-loop
      const stamp = await stampOne(ev({ triggerAuthor: 'kernel', ...flag }));
      expect(stamp.requesterKind).toBe('unknown');
      expect(stamp.requesterUserIds).toEqual([]);
    }
  });

  it('a human board edit folded into a pending kernel boardWake row is unknown, not kernel', async () => {
    // taskEventService folds a later change into the pending boardWake row and
    // keeps triggerAuthor: 'kernel' on it.
    const stamp = await stampOne(ev({
      triggerAuthor: 'kernel',
      boardWake: true,
      content: '[Board changed]\n- TASK-9: written by a stranger',
    }));
    expect(stamp.requesterKind).toBe('unknown');
  });

  it('a heartbeat and a first_contact are kernel', async () => {
    expect((await stampOne(ev({}, { type: 'heartbeat' }))).requesterKind).toBe('kernel');
    expect((await stampOne(ev({ userId: HUMAN_A }, { type: 'first_contact' }))).requesterKind).toBe('kernel');
  });

  it('a row with no sender at all is unknown', async () => {
    const stamp = await stampOne(ev({ content: 'x' }));
    expect(stamp.requesterKind).toBe('unknown');
    expect(stamp.requesterUserIds).toEqual([]);
  });

  it('copies pod facts, with absent visibility read as false and absent joinPolicy as open', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A }, { podId: OPEN_POD }));
    expect(stamp.pod).toEqual({ type: 'chat', publicRead: true, communityListed: false, joinPolicy: 'open' });
  });

  it('a pod that no longer exists gets pod: null', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A }, { podId: GONE_POD }));
    expect(stamp.pod).toBeNull();
    expect(stamp.requesterUserIds).toEqual([HUMAN_A]);
  });

  it('an owner missing on the calling bot gives null owner fields', async () => {
    const [out] = await stampAccountUse([ev({ userId: HUMAN_A })], {
      agentUser: { ...agentUser, botMetadata: { agentName: 'claude', instanceId: 'sam' } },
      installations: byoInstallations,
    });
    expect(out.payload.accountUse.ownerUserId).toBeNull();
    expect(out.payload.accountUse.ownerName).toBeNull();
  });

  it('with no owner on the bot, the owner falls back to the runtime credential', async () => {
    const [out] = await stampAccountUse([ev({ userId: HUMAN_A })], {
      agentUser: { ...agentUser, botMetadata: { agentName: 'claude', instanceId: 'sam' } },
      credential: { ownerUserId: OWNER },
      installations: byoInstallations,
    });
    expect(out.payload.accountUse.ownerUserId).toBe(OWNER);
    expect(out.payload.accountUse.ownerName).toBe('sam');
    expect(User.find).toHaveBeenCalledTimes(1);
  });

  it('the bot\'s own owner wins over the credential\'s', async () => {
    const [out] = await stampAccountUse([ev({ userId: HUMAN_A })], {
      agentUser, credential: { ownerUserId: HUMAN_B }, installations: byoInstallations,
    });
    expect(out.payload.accountUse.ownerUserId).toBe(OWNER);
  });

  it('a lookup that throws leaves the page unstamped and does not throw', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    User.find.mockImplementation(() => { throw new Error('mongo down'); });
    const events = [ev({ userId: HUMAN_A }), ev({ userId: PEER_BOT })];
    const out = await stampAccountUse(events, { agentUser, installations: byoInstallations });
    expect(out).toHaveLength(2);
    out.forEach((e) => expect(e.payload.accountUse).toBeUndefined());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a rejected lean() leaves the page unstamped too', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    Pod.find.mockImplementation(() => ({ select: () => ({ lean: () => Promise.reject(new Error('x')) }) }));
    const out = await stampAccountUse([ev({ userId: HUMAN_A })], { agentUser, installations: byoInstallations });
    expect(out[0].payload.accountUse).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a page of many events makes one Pod.find and one User.find, both projected and lean', async () => {
    const events = [
      ev({ userId: HUMAN_A }),
      ev({ userId: PEER_BOT }, { podId: OPEN_POD }),
      ev({ fromAgent: 'codex', fromInstanceId: 'pat' }, { type: 'agent.ask' }),
      ev({ userId: HUMAN_B, coalesced: [{ userId: HUMAN_A }] }),
    ];
    await stampAccountUse(events, { agentUser, installations: byoInstallations });
    expect(Pod.find).toHaveBeenCalledTimes(1);
    expect(User.find).toHaveBeenCalledTimes(1);
    const podQuery = Pod.find.mock.results[0].value;
    const userQuery = User.find.mock.results[0].value;
    expect(podQuery.select).toHaveBeenCalled();
    expect(podQuery.lean).toHaveBeenCalled();
    expect(userQuery.select).toHaveBeenCalled();
    expect(userQuery.lean).toHaveBeenCalled();
  });

  it('an empty page makes no query', async () => {
    const out = await stampAccountUse([], { agentUser, installations: byoInstallations });
    expect(out).toEqual([]);
    expect(Pod.find).not.toHaveBeenCalled();
    expect(User.find).not.toHaveBeenCalled();
  });

  it('a hosted seat is not stamped and makes no query', async () => {
    const events = [ev({ userId: HUMAN_A })];
    const out = await stampAccountUse(events, {
      agentUser,
      installations: [{ podId: POD, config: { runtime: { runtimeType: 'native' } } }],
    });
    expect(out[0].payload.accountUse).toBeUndefined();
    expect(Pod.find).not.toHaveBeenCalled();
    expect(Pod.aggregate).not.toHaveBeenCalled();
    expect(User.find).not.toHaveBeenCalled();
  });
});

describe('isByoSeat', () => {
  it('reads host byo and the unstamped polling-webhook shape as BYO', () => {
    expect(isByoSeat([{ config: { runtime: { host: 'byo', runtimeType: 'claude' } } }])).toBe(true);
    expect(isByoSeat([{ config: { runtime: { runtimeType: 'webhook' } } }])).toBe(true);
  });

  it('does not read hosted, native, push-webhook or empty seats as BYO', () => {
    expect(isByoSeat([{ config: { runtime: { runtimeType: 'native' } } }])).toBe(false);
    expect(isByoSeat([{ config: { runtime: { runtimeType: 'moltbot', host: 'cloud' } } }])).toBe(false);
    expect(isByoSeat([{ config: { runtime: { runtimeType: 'webhook', webhookUrl: 'https://x' } } }])).toBe(false);
    expect(isByoSeat([])).toBe(false);
    expect(isByoSeat(undefined)).toBe(false);
  });
});

describe('requesterSharesTeamPod (DMs)', () => {
  const OWNERS_OTHER_BOT = '64b0000000000000000000aa';

  it('a teammate in an agent-room shares a team pod, found by one aggregate', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A }, { podId: ROOM }));
    expect(stamp.requesterSharesTeamPod).toBe(true);
    expect(Pod.aggregate).toHaveBeenCalledTimes(1);
    const [pipeline] = Pod.aggregate.mock.calls[0];
    expect(pipeline.map((stage) => Object.keys(stage)[0])).toEqual(['$match', '$project', '$unwind', '$group']);
    const [{ $match }, { $project }, { $unwind }, { $group }] = pipeline;
    // Aggregates are not cast by the schema: ids go in as ObjectIds.
    expect($match.$and.map((term) => String(term.members.$in ? term.members.$in[0] : term.members)))
      .toEqual([SELF_BOT, HUMAN_A]);
    expect($match.publicRead).toEqual({ $ne: true });
    expect($match.communityListed).toEqual({ $ne: true });
    expect($match.type).toEqual({ $nin: ['agent-room', 'agent-dm', 'agent-admin'] });
    expect($project.hit.$setIntersection[0]).toBe('$members');
    expect($project.hit.$setIntersection[1].map(String)).toEqual([HUMAN_A]);
    expect($project.hit.$setIntersection[1][0].constructor.name).toBe('ObjectId');
    expect($unwind).toBe('$hit');
    expect($group).toEqual({ _id: '$hit' });
  });

  it('a peer agent in an agent-dm is checked by its own bot id', async () => {
    const stamp = await stampOne(ev({ userId: PEER_BOT }, { podId: AGENT_DM }));
    expect(stamp.requesterSharesTeamPod).toBe(true);
    expect(Pod.aggregate.mock.calls[0][0][1].$project.hit.$setIntersection[1].map(String)).toEqual([PEER_BOT]);
  });

  it('the owner\'s other agent in a DM is checked, not passed as the owner', async () => {
    User.find.mockImplementation(() => chain([...users, {
      _id: OWNERS_OTHER_BOT, username: 'sams-other', isBot: true,
      botMetadata: { agentName: 'other', instanceId: 'default', ownerUserId: OWNER },
    }]));
    const stamp = await stampOne(ev({ userId: OWNERS_OTHER_BOT }, { podId: ROOM }));
    expect(Pod.aggregate).toHaveBeenCalledTimes(1);
    expect(stamp.requesterSharesTeamPod).toBe(false);
  });

  it('a stranger who shares only a public or listed pod does not', async () => {
    const stamp = await stampOne(ev({ userId: STRANGER }, { podId: ROOM }));
    expect(stamp.requesterSharesTeamPod).toBe(false);
  });

  it('a sender who shares nothing does not', async () => {
    const stamp = await stampOne(ev({ userId: LONER }, { podId: ROOM }));
    expect(stamp.requesterSharesTeamPod).toBe(false);
  });

  it('every non-owner sender must share one: a teammate joined by a stranger is false', async () => {
    const stamp = await stampOne(ev({ userId: HUMAN_A, coalesced: [{ userId: STRANGER }] }, { podId: ROOM }));
    expect(stamp.requesterSharesTeamPod).toBe(false);
  });

  it('a sender whose row is missing is false', async () => {
    const stamp = await stampOne(ev({ userId: '64b0000000000000000000ff' }, { podId: ROOM }));
    expect(stamp.requesterSharesTeamPod).toBe(false);
  });

  it('the owner alone in a DM leaves it null and makes no team-pod query', async () => {
    const stamp = await stampOne(ev({ userId: OWNER }, { podId: ROOM }));
    expect(stamp.requesterSharesTeamPod).toBeNull();
    expect(Pod.aggregate).not.toHaveBeenCalled();
  });

  // Runtime auth leaves agentUser unset when no bot row matches the
  // installation: no lookup can run, so nothing may be asserted either way.
  it('with no bot user on the request, a DM row stays null, not false, and no query runs', async () => {
    const [out] = await stampAccountUse([ev({ userId: HUMAN_A }, { podId: ROOM })], {
      agentUser: undefined, credential: { ownerUserId: OWNER }, installations: byoInstallations,
    });
    expect(out.payload.accountUse.requesterSharesTeamPod).toBeNull();
    expect(Pod.aggregate).not.toHaveBeenCalled();
  });

  it('a page with no DM row makes no team-pod query', async () => {
    await stampAccountUse(
      [ev({ userId: STRANGER }), ev({ userId: LONER }, { podId: OPEN_POD })],
      { agentUser, installations: byoInstallations },
    );
    expect(Pod.find).toHaveBeenCalledTimes(1);
    expect(Pod.aggregate).not.toHaveBeenCalled();
  });

  it('a page of several DM rows makes one team-pod query', async () => {
    const out = await stampAccountUse([
      ev({ userId: HUMAN_A }, { podId: ROOM }),
      ev({ userId: STRANGER }, { podId: ROOM }),
      ev({ fromAgent: 'codex', fromInstanceId: 'pat' }, { type: 'agent.ask', podId: AGENT_DM }),
      ev({ userId: HUMAN_B }),
    ], { agentUser, installations: byoInstallations });
    expect(Pod.find).toHaveBeenCalledTimes(1);
    expect(Pod.aggregate).toHaveBeenCalledTimes(1);
    expect(User.find).toHaveBeenCalledTimes(1);
    expect(out.map((e) => e.payload.accountUse.requesterSharesTeamPod)).toEqual([true, false, true, null]);
  });

  it('a failed team-pod lookup leaves it null and keeps the rest of the stamp', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    Pod.aggregate.mockImplementation(() => Promise.reject(new Error('x')));
    const stamp = await stampOne(ev({ userId: HUMAN_A }, { podId: ROOM }));
    expect(stamp.requesterSharesTeamPod).toBeNull();
    expect(stamp.requesterUserIds).toEqual([HUMAN_A]);
    expect(stamp.pod.type).toBe('agent-room');
    warn.mockRestore();
  });
});

// Typed events that name who triggered them in their own field, not userId.
describe('who triggered a typed event', () => {
  const ruled = (ruledBy, extra = {}) => ev({
    decisionId: 'd1', pick: 'Yes', ...(ruledBy ? { ruledBy } : {}),
  }, { type: 'decision.ruled', ...extra });

  it('the owner ruling on their own agent\'s decision is the owner, as a person', async () => {
    const stamp = await stampOne(ruled({ userId: OWNER, username: 'sam' }));
    expect(stamp.requesterUserIds).toEqual([OWNER]);
    expect(stamp.requesterKind).toBe('human');
  });

  it('the owner ruling in a DM with their agent needs no team-pod check', async () => {
    const stamp = await stampOne(ruled({ userId: OWNER, username: 'sam' }, { podId: ROOM }));
    expect(stamp.requesterUserIds).toEqual([OWNER]);
    expect(stamp.requesterKind).toBe('human');
    expect(stamp.requesterSharesTeamPod).toBeNull();
    expect(Pod.aggregate).not.toHaveBeenCalled();
  });

  it('a teammate ruling in an agent-room is that teammate, and the team-pod check runs', async () => {
    const stamp = await stampOne(ruled({ userId: HUMAN_A, username: 'ana' }, { podId: ROOM }));
    expect(stamp.requesterUserIds).toEqual([HUMAN_A]);
    expect(stamp.requesterKind).toBe('human');
    expect(Pod.aggregate).toHaveBeenCalledTimes(1);
    expect(Pod.aggregate.mock.calls[0][0][1].$project.hit.$setIntersection[1].map(String)).toEqual([HUMAN_A]);
    expect(stamp.requesterSharesTeamPod).toBe(true);
  });

  it('a stranger ruling in an agent-room shares no team pod', async () => {
    const stamp = await stampOne(ruled({ userId: STRANGER, username: 'cy' }, { podId: ROOM }));
    expect(stamp.requesterUserIds).toEqual([STRANGER]);
    expect(stamp.requesterSharesTeamPod).toBe(false);
  });

  it('a ruler that resolves to a bot is that agent, never its owner', async () => {
    const stamp = await stampOne(ruled({ userId: PEER_BOT, username: 'codex-pat' }));
    expect(stamp.requesterUserIds).toEqual([PEER_BOT]);
    expect(stamp.requesterKind).toBe('agent');
  });

  it('a ruling with no ruledBy stays unknown', async () => {
    const stamp = await stampOne(ruled(null));
    expect(stamp.requesterUserIds).toEqual([]);
    expect(stamp.requesterKind).toBe('unknown');
  });

  it('approval.resolved names the person who approved', async () => {
    const stamp = await stampOne(ev(
      { approvalId: 'a1', decision: 'approved', approvedBy: { userId: OWNER, username: 'sam' } },
      { type: 'approval.resolved' },
    ));
    expect(stamp.requesterUserIds).toEqual([OWNER]);
    expect(stamp.requesterKind).toBe('human');
  });

  it('an approval.resolved with no approver (an expired parked call) stays unknown', async () => {
    const stamp = await stampOne(ev(
      { approvalId: 'a1', actionType: 'tool_call', ending: 'expired' },
      { type: 'approval.resolved' },
    ));
    expect(stamp.requesterUserIds).toEqual([]);
    expect(stamp.requesterKind).toBe('unknown');
  });

  it('handback.received names the handing agent by its bot id and the person who accepted', async () => {
    const stamp = await stampOne(ev({
      handBackId: 'h1',
      from: { agentName: 'codex', instanceId: 'pat', agentUserId: PEER_BOT },
      acceptedBy: { userId: HUMAN_A, reason: 'ok' },
    }, { type: 'handback.received' }));
    expect(stamp.requesterUserIds).toEqual([PEER_BOT, HUMAN_A]);
    expect(stamp.requesterKind).toBe('human');
  });

  it('these fields are read only on their own event type', async () => {
    const stamp = await stampOne(ev({ ruledBy: { userId: OWNER }, approvedBy: { userId: OWNER } }));
    expect(stamp.requesterUserIds).toEqual([]);
    expect(stamp.requesterKind).toBe('unknown');
  });
});
