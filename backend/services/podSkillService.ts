// eslint-disable-next-line global-require
const PodAssetService = require('./podAssetService');
// eslint-disable-next-line global-require
const { generateText } = require('./llmService');

const MODEL_NAME = 'gemini-2.5-flash';
const MAX_REFERENCES = 14;

interface ReferenceEntry {
  refId: string;
  type: string;
  id: unknown;
  title: string;
  createdAt: unknown;
  tags: string[];
  content: string;
}

interface SummaryLike {
  _id?: unknown;
  title?: string;
  createdAt?: unknown;
  tags?: string[];
  content?: string;
}

interface AssetLike {
  _id?: unknown;
  type?: string;
  title?: string;
  createdAt?: unknown;
  tags?: string[];
  content?: string;
}

interface PodDescriptor {
  id: string;
  name: string;
  description?: string;
}

interface RawSkill {
  name?: unknown;
  summary?: unknown;
  whenToUse?: unknown;
  steps?: unknown[];
  tags?: unknown[];
  references?: unknown[];
}

interface NormalizedSkill {
  name: string;
  summary: string;
  whenToUse: string;
  steps: string[];
  tags: string[];
}

interface GenerateSkillsResult {
  skills: RawSkill[];
  warnings: string[];
}

interface SynthesizeSkillsOptions {
  pod: PodDescriptor;
  task?: string | null;
  summaries?: SummaryLike[];
  assets?: AssetLike[];
  skillLimit?: number;
  taskTokens?: Set<string>;
}

interface SynthesizeSkillsResult {
  skills: unknown[];
  warnings: string[];
}

function safeDate(value: unknown): Date | null {
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date;
}

function recencyBoost(dateValue: unknown): number {
  const date = safeDate(dateValue);
  if (!date) return 0;
  const diffDays = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays <= 1) return 3;
  if (diffDays <= 3) return 2;
  if (diffDays <= 7) return 1.5;
  if (diffDays <= 30) return 1;
  return 0.25;
}

function extractJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  return fallback;
}

function normalizeList(value: unknown, { limit = 8 } = {}): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, limit);
}

function buildReferenceEntries({
  summaries = [], assets = [],
}: { summaries?: SummaryLike[]; assets?: AssetLike[] }): ReferenceEntry[] {
  const summaryEntries: ReferenceEntry[] = summaries.map((summary, index) => ({
    refId: `S${index + 1}`,
    type: 'summary',
    id: summary._id,
    title: summary.title || 'Untitled summary',
    createdAt: summary.createdAt,
    tags: summary.tags || [],
    content: summary.content || '',
  }));

  const assetEntries: ReferenceEntry[] = assets.map((asset, index) => ({
    refId: `A${index + 1}`,
    type: asset.type || 'asset',
    id: asset._id,
    title: asset.title || 'Untitled asset',
    createdAt: asset.createdAt,
    tags: asset.tags || [],
    content: asset.content || '',
  }));

  return [...summaryEntries, ...assetEntries]
    .filter((entry) => entry.content || entry.title)
    .slice(0, MAX_REFERENCES);
}

function referenceEntriesToPrompt(referenceEntries: ReferenceEntry[]): string {
  return referenceEntries
    .map((entry) => {
      const createdAt = safeDate(entry.createdAt);
      const dateLabel = createdAt ? createdAt.toISOString() : 'unknown-date';
      const tags = (entry.tags || []).slice(0, 8).join(', ');
      const content = normalizeText(entry.content).slice(0, 800);
      return [
        `${entry.refId} | ${entry.type} | ${entry.title} | ${dateLabel}`,
        `Tags: ${tags || 'none'}`,
        `Content: ${content || 'n/a'}`,
      ].join('\n');
    })
    .join('\n\n');
}

function buildSkillPrompt({
  pod, task, referenceEntries, skillLimit,
}: {
  pod: PodDescriptor;
  task?: string | null;
  referenceEntries: ReferenceEntry[];
  skillLimit: number;
}): string {
  const referencesBlock = referenceEntriesToPrompt(referenceEntries);
  const taskLine = task ? `Task focus: ${task}` : 'Task focus: general pod memory';

  return `You are synthesizing a SMALL set of reusable skills for an AI agent working inside a pod.

Pod: ${pod.name}
Description: ${pod.description || 'n/a'}
${taskLine}

You are given pod references. Each reference has a stable refId like S1 or A2.
Use those refIds in your references output.

Pod references:
${referencesBlock}

Return STRICT JSON only, with this shape:
{
  "skills": [
    {
      "name": "short skill name",
      "summary": "1-2 sentence TL;DR",
      "whenToUse": "when this applies",
      "steps": ["step 1", "step 2"],
      "references": ["S1", "A2"],
      "tags": ["tag-a", "tag-b"]
    }
  ]
}

Constraints:
- Generate between 2 and ${skillLimit} skills.
- Prefer durable team knowledge, procedures, checklists, and decision rules.
- Avoid filler words, greetings, and generic chat artifacts.
- Avoid using people's names as skill names unless essential.
- Every skill should cite 1-4 references by refId.
- Skills should be distinct and non-overlapping.`;
}

function resolveReferences(
  referenceIds: unknown,
  referenceMap: Map<string, ReferenceEntry>,
): { validIds: string[]; references: ReferenceEntry[] } {
  const ids: unknown[] = Array.isArray(referenceIds) ? referenceIds : [];
  const validIds = (ids as string[]).filter((refId) => referenceMap.has(refId));
  const references = validIds.map((refId) => referenceMap.get(refId)!);
  return { validIds, references };
}

function scoreSkill(
  skill: { name: string; tags: string[]; steps: string[] },
  references: ReferenceEntry[],
  taskTokens: Set<string>,
): number {
  const latestRefDate = references
    .map((ref) => safeDate(ref.createdAt))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const referenceScore = references.length * 3;
  const stepsScore = (skill.steps || []).length;
  const recencyScore = recencyBoost(latestRefDate);

  const nameTokens: string[] = PodAssetService.extractKeywords(skill.name || '', { limit: 6 });
  const tagTokens = (skill.tags || []).map((tag) => String(tag).toLowerCase());
  const taskMatchCount = [...taskTokens].reduce((count, token) => (
    nameTokens.includes(token) || tagTokens.includes(token) ? count + 1 : count
  ), 0);

  const taskScore = taskMatchCount * 2;
  const total = referenceScore + stepsScore + recencyScore + taskScore;
  return Number(total.toFixed(2));
}

function buildSkillMarkdown(
  skill: NormalizedSkill,
  references: ReferenceEntry[],
): string {
  const steps = (skill.steps || []).map((step, index) => `${index + 1}. ${step}`).join('\n');
  const sources = references
    .map((ref) => {
      const date = safeDate(ref.createdAt);
      const dateLabel = date ? date.toISOString().slice(0, 10) : 'unknown-date';
      return `- ${ref.refId} · ${ref.title} (${dateLabel})`;
    })
    .join('\n');

  const fallbackSteps = [
    '1. Review the referenced context.',
    '2. Apply the guidance carefully.',
  ].join('\n');

  return [
    `### ${skill.name}`,
    '',
    '**TL;DR**',
    skill.summary,
    '',
    '**When To Use**',
    skill.whenToUse,
    '',
    '**Steps**',
    steps || fallbackSteps,
    '',
    '**Sources**',
    sources || '- None cited',
  ].join('\n');
}

class PodSkillService {
  private available: boolean;

  constructor() {
    this.available = Boolean(process.env.LITELLM_BASE_URL || process.env.GEMINI_API_KEY);
  }

  isAvailable(): boolean {
    return this.available;
  }

  async generateSkillsWithLLM({
    pod, task, referenceEntries, skillLimit,
  }: {
    pod: PodDescriptor;
    task?: string | null;
    referenceEntries: ReferenceEntry[];
    skillLimit: number;
  }): Promise<GenerateSkillsResult> {
    if (!this.isAvailable()) {
      return { skills: [], warnings: ['LLM is not configured (set LITELLM_BASE_URL or GEMINI_API_KEY).'] };
    }

    const prompt = buildSkillPrompt({
      pod, task, referenceEntries, skillLimit,
    });

    try {
      const text: string = await generateText(prompt, { model: MODEL_NAME, temperature: 0.2 });
      const parsed = extractJson(text);
      if (!parsed || !Array.isArray(parsed.skills)) {
        return { skills: [], warnings: ['LLM response was not valid JSON.'] };
      }
      return { skills: parsed.skills as RawSkill[], warnings: [] };
    } catch (error) {
      console.error('Failed to synthesize pod skills with LLM:', error);
      return { skills: [], warnings: ['LLM skill synthesis failed.'] };
    }
  }

  async synthesizeSkills({
    pod, task, summaries = [], assets = [], skillLimit = 6, taskTokens = new Set(),
  }: SynthesizeSkillsOptions): Promise<SynthesizeSkillsResult> {
    const referenceEntries = buildReferenceEntries({ summaries, assets });
    if (!referenceEntries.length) {
      return { skills: [], warnings: ['No references available to synthesize skills.'] };
    }

    const referenceMap = new Map<string, ReferenceEntry>(
      referenceEntries.map((entry) => [entry.refId, entry]),
    );

    const { skills: rawSkills, warnings } = await this.generateSkillsWithLLM({
      pod, task, referenceEntries, skillLimit,
    });

    const limitedSkills = rawSkills.slice(0, skillLimit);
    const skillPromises = limitedSkills.map(async (rawSkill) => {
      const name = normalizeText(rawSkill.name);
      if (!name) return null;

      const summary = normalizeText(rawSkill.summary, 'No TL;DR provided.');
      const whenToUse = normalizeText(rawSkill.whenToUse, 'Use when this topic appears.');
      const steps = normalizeList(rawSkill.steps, { limit: 8 });
      const tags = normalizeList(rawSkill.tags, { limit: 10 });
      const { validIds, references } = resolveReferences(rawSkill.references, referenceMap);

      const score = scoreSkill({ name, tags, steps }, references, taskTokens);
      const markdown = buildSkillMarkdown({ name, summary, whenToUse, steps, tags }, references);

      return PodAssetService.upsertSkillAsset({
        podId: pod.id,
        name,
        markdown,
        tags,
        metadata: {
          score,
          summary,
          whenToUse,
          steps,
          references: validIds,
          referenceDetails: references.map((ref) => ({
            refId: ref.refId,
            id: ref.id,
            type: ref.type,
            title: ref.title,
            createdAt: ref.createdAt || null,
          })),
          generatedAt: new Date(),
          generator: 'gemini',
        },
      });
    });

    const upsertedSkills = (await Promise.all(skillPromises)).filter(Boolean);

    return {
      skills: upsertedSkills,
      warnings,
    };
  }
}

export default new PodSkillService();
