jest.mock('../../../services/podAssetService', () => ({
  extractKeywords: (text = '') => text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean),
  upsertSkillAsset: jest.fn(),
}));

const PodAssetService = require('../../../services/podAssetService');
const PodSkillService = require('../../../services/podSkillService');

describe('PodSkillService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('turns LLM skill output into markdown skill assets', async () => {
    const llmSpy = jest
      .spyOn(PodSkillService, 'generateSkillsWithLLM')
      .mockResolvedValue({
        skills: [
          {
            name: 'Incident triage',
            summary: 'Use the incident runbook to triage alerts.',
            whenToUse: 'When new alerts arrive in the incident channel.',
            steps: ['Check severity', 'Assign owner', 'Follow runbook'],
            references: ['S1', 'A1'],
            tags: ['incident', 'triage'],
          },
        ],
        warnings: [],
      });

    PodAssetService.upsertSkillAsset.mockResolvedValue({
      _id: 'skill-1',
      title: 'Skill: Incident triage',
      content: '### Incident triage',
      metadata: { score: 10 },
    });

    const result = await PodSkillService.synthesizeSkills({
      pod: {
        id: 'pod-1',
        name: 'Incident Pod',
        description: 'Handles incidents',
      },
      task: 'Need incident triage guidance',
      taskTokens: new Set(['incident', 'triage']),
      skillLimit: 4,
      summaries: [
        {
          _id: 'summary-1',
          title: 'Incident alignment',
          content: 'We reviewed the incident triage runbook.',
          tags: ['incident', 'runbook'],
          createdAt: new Date('2026-01-20T10:00:00Z'),
        },
      ],
      assets: [
        {
          _id: 'asset-1',
          type: 'integration-summary',
          title: 'Discord incidents',
          content: 'Alerts were triaged and resolved.',
          tags: ['incident', 'alerts'],
          createdAt: new Date('2026-01-20T11:00:00Z'),
        },
      ],
    });

    expect(llmSpy).toHaveBeenCalled();
    expect(PodAssetService.upsertSkillAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        podId: 'pod-1',
        name: 'Incident triage',
      }),
    );
    expect(result.skills).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });
});
