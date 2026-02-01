jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/Summary', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/PodAsset', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../../../services/podSkillService', () => ({
  isAvailable: jest.fn(() => true),
  synthesizeSkills: jest.fn().mockResolvedValue({ skills: [], warnings: [] }),
}));

const Pod = require('../../../models/Pod');
const Summary = require('../../../models/Summary');
const PodAsset = require('../../../models/PodAsset');
const PodSkillService = require('../../../services/podSkillService');
const PodContextService = require('../../../services/podContextService');

function mockPodFindById(pod) {
  const lean = jest.fn().mockResolvedValue(pod);
  const select = jest.fn().mockReturnValue({ lean });
  Pod.findById.mockReturnValue({ select });
  return { select, lean };
}

function buildFindChain(data) {
  const lean = jest.fn().mockResolvedValue(data);
  const limit = jest.fn().mockReturnValue({ lean });
  const sort = jest.fn().mockReturnValue({ limit });
  return { sort };
}

function mockSummaryFind(data) {
  Summary.find.mockReturnValue(buildFindChain(data));
}

function mockPodAssetFind({ assets, skills }) {
  PodAsset.find.mockImplementation((query) => {
    if (query?.type === 'skill') {
      return buildFindChain(skills);
    }
    return buildFindChain(assets);
  });
}

function mockLatestSkill(updatedAt) {
  const lean = jest.fn().mockResolvedValue(updatedAt ? { updatedAt } : null);
  const select = jest.fn().mockReturnValue({ lean });
  const sort = jest.fn().mockReturnValue({ select });
  PodAsset.findOne.mockReturnValue({ sort });
}

describe('PodContextService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns structured pod context with LLM-generated skill assets', async () => {
    mockPodFindById({
      _id: 'pod-1',
      name: 'Incident Pod',
      description: 'Handles incidents',
      type: 'chat',
      members: ['user-1', 'user-2'],
    });

    mockSummaryFind([
      {
        _id: 'summary-1',
        podId: 'pod-1',
        type: 'chats',
        title: 'Incident response alignment',
        content: 'The team discussed incident response checklists and on-call runbooks.',
        metadata: { topUsers: ['alice'], topTags: [] },
        createdAt: new Date('2026-01-20T10:00:00Z'),
      },
      {
        _id: 'summary-2',
        podId: 'pod-1',
        type: 'chats',
        title: 'Release prep',
        content: 'We reviewed the release process and deployment checklist.',
        metadata: { topUsers: ['bob'], topTags: [] },
        createdAt: new Date('2026-01-19T10:00:00Z'),
      },
    ]);

    const assets = [
      {
        _id: 'asset-1',
        podId: 'pod-1',
        type: 'integration-summary',
        title: 'Discord Summary · incidents',
        content: 'Several incident alerts were triaged and resolved.',
        tags: ['incident', 'runbook', 'alerts'],
        createdAt: new Date('2026-01-20T11:00:00Z'),
      },
    ];

    const skills = [
      {
        _id: 'skill-1',
        podId: 'pod-1',
        type: 'skill',
        title: 'Skill: incident triage',
        content: '### incident triage\n\n**TL;DR**\nUse the runbook.',
        tags: ['incident', 'triage'],
        metadata: { score: 9.5, skillKey: 'incident-triage' },
        updatedAt: new Date('2026-01-20T12:00:00Z'),
        createdAt: new Date('2026-01-20T12:00:00Z'),
      },
    ];

    mockPodAssetFind({ assets, skills });
    mockLatestSkill(new Date('2026-01-10T00:00:00Z'));

    const context = await PodContextService.getPodContext({
      podId: 'pod-1',
      userId: 'user-1',
      task: 'Need the incident response checklist and runbook',
      summaryLimit: 5,
      assetLimit: 5,
      tagLimit: 10,
      skillLimit: 6,
      skillMode: 'llm',
      skillRefreshHours: 6,
    });

    expect(PodSkillService.synthesizeSkills).toHaveBeenCalled();
    expect(context.pod).toEqual({
      id: 'pod-1',
      name: 'Incident Pod',
      description: 'Handles incidents',
      type: 'chat',
    });

    expect(context.assets[0]._id).toBe('asset-1');
    expect(context.assets[0].relevanceScore).toBeGreaterThan(0);

    const tagNames = context.tags.map((tag) => tag.tag);
    expect(tagNames).toContain('incident');

    expect(context.skills.length).toBeGreaterThan(0);
    expect(context.skills[0].title).toContain('Skill:');
    expect(context.stats.skills).toBeGreaterThan(0);
    expect(context.skillModeUsed).toBe('llm');
  });

  it('throws a 403 error when the user is not a pod member', async () => {
    mockPodFindById({
      _id: 'pod-1',
      name: 'Private Pod',
      description: '',
      type: 'chat',
      members: ['user-2'],
    });

    mockSummaryFind([]);
    mockPodAssetFind({ assets: [], skills: [] });
    mockLatestSkill(null);

    await expect(
      PodContextService.getPodContext({ podId: 'pod-1', userId: 'user-1' }),
    ).rejects.toMatchObject({ status: 403, code: 'NOT_A_MEMBER' });
  });

  it('filters agent-scoped assets to the requesting agent instance', async () => {
    mockPodFindById({
      _id: 'pod-1',
      name: 'Agent Pod',
      description: '',
      type: 'chat',
      members: ['agent-user'],
    });

    mockSummaryFind([]);
    mockLatestSkill(null);

    const queries = [];
    PodAsset.find.mockImplementation((query) => {
      queries.push(query);
      return buildFindChain([]);
    });

    await PodContextService.getPodContext({
      podId: 'pod-1',
      userId: 'agent-user',
      agentContext: { agentName: 'openclaw', instanceId: 'inst-a' },
      summaryLimit: 1,
      assetLimit: 1,
      tagLimit: 1,
      skillLimit: 1,
      skillMode: 'none',
    });

    const assetQuery = queries.find((query) => query?.type?.$ne === 'skill');
    expect(assetQuery).toBeTruthy();
    expect(assetQuery.$and).toBeDefined();
    const visibilityFilter = assetQuery.$and.find((entry) => entry.$or);
    expect(visibilityFilter).toBeDefined();
    const agentClause = visibilityFilter.$or.find((entry) => entry['metadata.scope'] === 'agent');
    expect(agentClause).toMatchObject({
      'metadata.scope': 'agent',
      'metadata.agentName': 'openclaw',
      'metadata.instanceId': 'inst-a',
    });
  });
});
