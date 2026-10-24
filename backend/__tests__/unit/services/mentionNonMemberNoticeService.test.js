jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn() },
}));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { findNonMemberMentionNotices } = require('../../../services/mentionNonMemberNoticeService');

const rows = (value) => ({ select: () => ({ lean: async () => value }) });

describe('non-member mention feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue(rows({ members: ['member-user'] }));
    User.find.mockReturnValue(rows([
      { _id: 'member-user', username: 'sam' },
      { _id: 'other-user', username: 'Lily' },
    ]));
    AgentInstallation.find.mockReturnValue(rows([
      { podId: 'pod-1', agentName: 'nova', instanceId: 'nova', displayName: 'Nova' },
      { podId: 'pod-2', agentName: 'rhea', instanceId: 'rhea', displayName: 'Rhea' },
      { podId: 'pod-2', agentName: 'scout', instanceId: 'scout', displayName: '' },
    ]));
    AgentProfile.find.mockReturnValue(rows([
      { podId: 'pod-2', agentName: 'scout', instanceId: 'scout', name: 'Friendly Scout' },
    ]));
  });

  it('notifies for known outsiders but not members or unknown handles', async () => {
    const notices = await findNonMemberMentionNotices(
      'pod-1', '@rhea @lily @nova @sam @notarealhandle @rhea @guide @friendly-scout',
    );
    expect(notices).toEqual([
      { code: 'MENTION_NOT_IN_POD', handle: 'rhea', message: "rhea isn't in this pod. Invite them, or ask in a pod they're in." },
      { code: 'MENTION_NOT_IN_POD', handle: 'lily', message: "lily isn't in this pod. Invite them, or ask in a pod they're in." },
      { code: 'MENTION_NOT_IN_POD', handle: 'guide', message: "guide isn't in this pod. Invite them, or ask in a pod they're in." },
      { code: 'MENTION_NOT_IN_POD', handle: 'friendly-scout', message: "friendly-scout isn't in this pod. Invite them, or ask in a pod they're in." },
    ]);
    expect(User.find).toHaveBeenCalledWith({
      $or: expect.arrayContaining([{ username: /^lily$/i }]),
    });
  });

  it('skips all lookups when there is no mention', async () => {
    expect(await findNonMemberMentionNotices('pod-1', 'hello')).toEqual([]);
    expect(Pod.findById).not.toHaveBeenCalled();
  });

  it('recognizes an in-pod legacy alias and profile display slug as delivered', async () => {
    AgentInstallation.find.mockReturnValue(rows([
      { podId: 'pod-1', agentName: 'scout', instanceId: 'scout', displayName: '' },
    ]));
    AgentProfile.find.mockReturnValue(rows([
      { podId: 'pod-1', agentName: 'scout', instanceId: 'scout', name: 'Friendly Scout' },
    ]));

    expect(await findNonMemberMentionNotices('pod-1', '@guide @friendly-scout')).toEqual([]);
  });
});
