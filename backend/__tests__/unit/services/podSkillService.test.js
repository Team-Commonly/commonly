// Hoisted mock — podSkillService destructures generateText at require time,
// so a post-require spy on the module object would never be seen.
jest.mock('../../../services/llmService', () => ({
  generateText: jest.fn(),
}));

jest.mock('../../../services/podAssetService', () => ({
  extractKeywords: (text = '') => text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean),
  upsertSkillAsset: jest.fn(),
}));

const PodAssetService = require('../../../services/podAssetService');
const PodSkillService = require('../../../services/podSkillService');
const llmService = require('../../../services/llmService');

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

  // #651: a permanently-dead credential (Gemini 401) used to be retried on
  // every context poll (~1,600 log lines/day). A 401/403 must disable
  // synthesis for the process lifetime; transient errors must not.
  describe('permanent credential failure guard', () => {
    const baseArgs = {
      pod: { id: 'pod-1', name: 'Pod', description: '' },
      referenceEntries: [{
        refId: 'S1', type: 'summary', id: 's1', title: 'T', createdAt: new Date(), tags: [], content: 'c',
      }],
      skillLimit: 4,
    };

    beforeEach(() => {
      // The singleton's availability was computed from env at require time;
      // force it on so the guard (not missing config) is what we exercise.
      PodSkillService.available = true;
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      PodSkillService.available = true;
    });

    it('disables synthesis for the process lifetime after a Gemini-style 401', async () => {
      llmService.generateText.mockRejectedValue(
        new Error('[GoogleGenerativeAI Error]: Error fetching from https://...: [401 Unauthorized] API key not valid'),
      );

      const first = await PodSkillService.generateSkillsWithLLM(baseArgs);
      expect(first.warnings).toEqual(['LLM skill synthesis disabled: credential rejected (401/403).']);
      expect(PodSkillService.isAvailable()).toBe(false);

      await PodSkillService.generateSkillsWithLLM(baseArgs);
      expect(llmService.generateText).toHaveBeenCalledTimes(1);
    });

    it('disables synthesis on a structured 401/403 status', async () => {
      llmService.generateText.mockRejectedValue(
        Object.assign(new Error('Request failed'), { response: { status: 401 } }),
      );

      await PodSkillService.generateSkillsWithLLM(baseArgs);
      expect(PodSkillService.isAvailable()).toBe(false);
    });

    it('stays available after a transient (non-auth) failure', async () => {
      llmService.generateText.mockRejectedValue(
        new Error('timeout of 30000ms exceeded'),
      );

      const first = await PodSkillService.generateSkillsWithLLM(baseArgs);
      expect(first.warnings).toEqual(['LLM skill synthesis failed.']);
      expect(PodSkillService.isAvailable()).toBe(true);

      await PodSkillService.generateSkillsWithLLM(baseArgs);
      expect(llmService.generateText).toHaveBeenCalledTimes(2);
    });
  });
});
