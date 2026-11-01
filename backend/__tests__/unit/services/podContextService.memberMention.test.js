/**
 * get_context members and recent-message authors carry the @handle mention
 * routing resolves, next to the display label. Fixture: display label
 * ("Rivet"), instanceId ("swe-dogfood") and username ("codex-swe-dogfood") all
 * differ. Mention routing is the real agentMentionService over the pod's rows.
 */
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Summary', () => ({ find: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: { find: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({
  getRecentMessages: jest.fn().mockResolvedValue([]),
  // The real enrichment, so the recent-message handle is the one production gives.
  withMentionHandles: jest.fn((...args) => (
    jest.requireActual('../../../services/agentMessageService').withMentionHandles(...args)
  )),
}));
jest.mock('../../../services/podSkillService', () => ({
  isAvailable: jest.fn(() => false),
  synthesizeSkills: jest.fn().mockResolvedValue({ skills: [], warnings: [] }),
}));

const Pod = require('../../../models/Pod');
const Summary = require('../../../models/Summary');
const PodAsset = require('../../../models/PodAsset');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const AgentMessageService = require('../../../services/agentMessageService');
const PodContextService = require('../../../services/podContextService');

const BOT_ID = '6abeec74ffacf322751d7721';
const HUMAN_ID = '6a47891ee025ce2e0ca1d305';

const chain = (value) => {
  const lean = jest.fn().mockResolvedValue(value);
  const select = jest.fn().mockReturnValue({ lean });
  return { select, lean, sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean }) }) };
};

describe('pod context members', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue(chain({
      _id: 'pod-1', name: 'Team', description: '', type: 'chat', members: [BOT_ID, HUMAN_ID],
    }));
    Summary.find.mockReturnValue(chain([]));
    PodAsset.find.mockReturnValue(chain([]));
    PodAsset.findOne.mockReturnValue({ sort: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) }) });
    AgentInstallation.find.mockReturnValue(chain([
      { agentName: 'codex', instanceId: 'swe-dogfood', displayName: 'Rivet', status: 'active' },
    ]));
    AgentProfile.find.mockReturnValue(chain([]));
    User.find.mockReturnValue(chain([
      {
        _id: BOT_ID,
        username: 'codex-swe-dogfood',
        isBot: true,
        botMetadata: { displayName: 'Rivet', instanceId: 'swe-dogfood', agentName: 'codex' },
      },
      { _id: HUMAN_ID, username: 'lily-shen', isBot: false },
    ]));
  });

  it('gives each member a mention handle alongside the display label', async () => {
    const context = await PodContextService.getPodContext({
      podId: 'pod-1', userId: HUMAN_ID, skillMode: 'none',
    });

    const [bot, human] = context.members;
    expect(bot).toMatchObject({ name: 'Rivet', mention: 'codex-swe-dogfood', isAgent: true });
    expect(human).toMatchObject({ name: 'lily-shen', mention: 'lily-shen', isAgent: false });
    expect(AgentInstallation.find).toHaveBeenCalledWith({ podId: 'pod-1', status: 'active' });
  });

  it('gives a recent message the author handle from the same pod map', async () => {
    AgentMessageService.getRecentMessages.mockResolvedValueOnce([
      { id: 'm1', username: 'Rivet', userId: { _id: BOT_ID, username: 'Rivet' }, content: 'shipped' },
    ]);

    const context = await PodContextService.getPodContext({
      podId: 'pod-1', userId: HUMAN_ID, skillMode: 'none',
    });

    expect(context.recentMessages).toEqual([
      expect.objectContaining({ id: 'm1', author: 'Rivet', mention: 'codex-swe-dogfood' }),
    ]);
    // One read of the pod's installs serves members and messages.
    expect(AgentInstallation.find).toHaveBeenCalledTimes(1);
  });

  it('still lists members when the pod map cannot be read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('db down')) });

    const context = await PodContextService.getPodContext({
      podId: 'pod-1', userId: HUMAN_ID, skillMode: 'none',
    });

    const [bot, human] = context.members;
    expect(bot).toMatchObject({ name: 'Rivet', mention: '', isAgent: true });
    expect(human).toMatchObject({ name: 'lily-shen', mention: 'lily-shen', isAgent: false });
    warn.mockRestore();
  });
});
