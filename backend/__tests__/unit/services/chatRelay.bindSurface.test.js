// F143 (Cofounder, 11-04): binding a pod to a chat surface people outside the
// pod can read takes authority over the POD — its creator or an instance
// admin. A private 1:1 with the bot stays member-level. One rule, consulted by
// every bind and retarget path; these arms pin the rule itself.
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({
  findByIdAndUpdate: jest.fn(),
  findOneAndUpdate: jest.fn(),
  aggregate: jest.fn(),
}));

const User = require('../../../models/User');
const {
  surfaceAudienceOf,
  surfaceBindDeclarations,
  canBindSurface,
  assertCanBindSurface,
  retargetsSurface,
  SurfaceBindRefusedError,
  SHARED_SURFACE_REFUSAL,
} = require('../../../services/chatRelay/bindSurface');
const { chatRelayIntegrationTypes } = require('../../../services/chatRelay/adapters');

const CREATOR = 'creator-1';
const MEMBER = 'member-1';
const ADMIN = 'admin-1';
const pod = () => ({ _id: 'pod-1', createdBy: CREATOR, members: [CREATOR, MEMBER] });
const creator = { _id: CREATOR, role: 'user' };
const member = { _id: MEMBER, role: 'user' };
const admin = { _id: ADMIN, role: 'admin' };

// Every shared surface the ruling names, and the one private surface.
const SHARED = [
  ['a Slack channel (legacy channelId)', 'slack', { channelId: 'C123' }],
  ['a Slack connector with no surface named', 'slack', {}],
  ['a Slack DM that also names a channel', 'slack', { chatType: 'im', chatId: 'D1', channelId: 'C123' }],
  ['a Discord guild channel', 'discord', { serverId: '1'.repeat(18), channelId: '2'.repeat(18) }],
  ['a Telegram group', 'telegram', { chatId: '-1', chatType: 'group' }],
  ['a Telegram supergroup', 'telegram', { chatId: '-100', chatType: 'supergroup' }],
  ['a Telegram channel', 'telegram', { chatId: '-100', chatType: 'channel' }],
  ['a GroupMe group', 'groupme', { groupId: '123', botId: 'b' }],
];

describe('surfaceAudienceOf', () => {
  it('governs every chat bridge the ruling names, GroupMe included', () => {
    expect(Object.keys(surfaceBindDeclarations).sort()).toEqual(['discord', 'groupme', 'slack', 'telegram']);
  });

  it.each(SHARED)('%s is a shared surface', (_label, type, config) => {
    expect(surfaceAudienceOf(type, config)).toBe('shared-surface');
  });

  it('a Telegram private chat and a Slack DM are private 1:1', () => {
    expect(surfaceAudienceOf('telegram', { chatId: '42', chatType: 'private' })).toBe('private-1to1');
    expect(surfaceAudienceOf('slack', { chatId: 'D1', chatType: 'im' })).toBe('private-1to1');
  });

  it.each([
    ['an unknown type', 'carrier-pigeon', { chatType: 'private' }],
    ['an unknown Telegram chatType', 'telegram', { chatId: '9', chatType: 'secret-room' }],
    ['a missing Telegram chatType', 'telegram', { chatId: '9' }],
    ['a non-string type', undefined, { chatType: 'private' }],
  ])('fails closed on %s', (_label, type, config) => {
    expect(surfaceAudienceOf(type, config)).toBe('shared-surface');
  });
});

describe('canBindSurface', () => {
  it.each(SHARED)('refuses a plain member binding %s', (_label, type, config) => {
    expect(canBindSurface({
      user: member, pod: pod(), type, config, 
    })).toBe(false);
  });

  it.each(SHARED)('lets the pod creator bind %s', (_label, type, config) => {
    expect(canBindSurface({
      user: creator, pod: pod(), type, config, 
    })).toBe(true);
  });

  it.each(SHARED)('lets an instance admin bind %s on a pod they did not create', (_label, type, config) => {
    expect(canBindSurface({
      user: admin, pod: pod(), type, config, 
    })).toBe(true);
  });

  it('refuses a creator who has left the pod (TASK-168)', () => {
    const left = { ...pod(), members: [MEMBER] };
    expect(canBindSurface({
      user: creator, pod: left, type: 'discord', config: {},
    })).toBe(false);
  });

  it('refuses an unknown type even for the pod creator\'s co-member', () => {
    expect(canBindSurface({
      user: member, pod: pod(), type: 'carrier-pigeon', config: { chatType: 'private' },
    })).toBe(false);
    expect(canBindSurface({
      user: creator, pod: pod(), type: 'carrier-pigeon', config: {},
    })).toBe(true);
  });

  it('lets a plain member bind a Telegram private chat and a Slack DM', () => {
    expect(canBindSurface({
      user: member, pod: pod(), type: 'telegram', config: { chatId: '42', chatType: 'private' },
    })).toBe(true);
    expect(canBindSurface({
      user: member, pod: pod(), type: 'slack', config: { chatId: 'D1', chatType: 'im' },
    })).toBe(true);
  });

  it('defers a Telegram row with no chat yet to the redemption', () => {
    expect(canBindSurface({
      user: member, pod: pod(), type: 'telegram', config: {},
    })).toBe(true);
  });

  it('refuses with no user or no pod', () => {
    expect(canBindSurface({
      user: null, pod: pod(), type: 'discord', config: {},
    })).toBe(false);
    expect(canBindSurface({
      user: admin, pod: null, type: 'discord', config: {},
    })).toBe(false);
    expect(canBindSurface({
      user: creator, pod: null, type: 'discord', config: {},
    })).toBe(false);
  });
});

describe('assertCanBindSurface', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws one 403 with one message for a plain member on a shared surface', async () => {
    User.findById.mockResolvedValue(member);
    const refusal = await assertCanBindSurface({
      userId: MEMBER, pod: pod(), type: 'slack', config: { channelId: 'C1' },
    }).catch((error) => error);
    expect(refusal).toBeInstanceOf(SurfaceBindRefusedError);
    expect(refusal.status).toBe(403);
    expect(refusal.body).toEqual(SHARED_SURFACE_REFUSAL);
    expect(refusal.body.message).toBe('Only the pod creator can connect a shared channel to this pod');
  });

  it('reads the role from the database, not the caller', async () => {
    User.findById.mockResolvedValue({ _id: MEMBER, role: 'admin' });
    await expect(assertCanBindSurface({
      userId: MEMBER, pod: pod(), type: 'discord', config: {},
    })).resolves.toBeUndefined();
    expect(User.findById).toHaveBeenCalledWith(MEMBER);
  });

  it('refuses a user the database does not know', async () => {
    User.findById.mockResolvedValue(null);
    await expect(assertCanBindSurface({
      userId: CREATOR, pod: pod(), type: 'discord', config: {},
    })).rejects.toBeInstanceOf(SurfaceBindRefusedError);
  });

  it('settles a private surface without a user lookup', async () => {
    await assertCanBindSurface({
      userId: MEMBER, pod: pod(), type: 'telegram', config: { chatId: '42', chatType: 'private' },
    });
    expect(User.findById).not.toHaveBeenCalled();
  });
});

describe('retargetsSurface', () => {
  it('sees a Slack channel added to a DM row', () => {
    expect(retargetsSurface('slack', { chatType: 'im', chatId: 'D1' }, { chatType: 'im', chatId: 'D1', channelId: 'C1' })).toBe(true);
  });

  it('ignores a write that leaves the surface fields alone', () => {
    expect(retargetsSurface('slack', { chatType: 'im', chatId: 'D1' }, { chatType: 'im', chatId: 'D1', liveRelay: true })).toBe(false);
  });

  it('treats any write on an unknown type as a retarget', () => {
    expect(retargetsSurface('carrier-pigeon', {}, {})).toBe(true);
  });
});

describe('every relay adapter declares its audience', () => {
  it('covers each type the dispatcher relays through', () => {
    const declared = Object.keys(surfaceBindDeclarations);
    expect(chatRelayIntegrationTypes().filter((type) => !declared.includes(type))).toEqual([]);
  });
});
