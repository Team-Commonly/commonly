/**
 * get_context members carry the @handle mention routing resolves, next to the
 * display label. Fixture: display label ("Rivet"), instanceId ("swe-dogfood")
 * and username ("codex-swe-dogfood") all differ.
 */
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Summary', () => ({ find: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({
  getRecentMessages: jest.fn().mockResolvedValue([]),
  withMentionHandles: jest.fn(async (messages) => messages),
}));
jest.mock('../../../services/podSkillService', () => ({
  isAvailable: jest.fn(() => false),
  synthesizeSkills: jest.fn().mockResolvedValue({ skills: [], warnings: [] }),
}));

const Pod = require('../../../models/Pod');
const Summary = require('../../../models/Summary');
const PodAsset = require('../../../models/PodAsset');
const User = require('../../../models/User');
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
  });
});
