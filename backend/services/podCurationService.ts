// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const AgentProfile = require('../models/AgentProfile');
// eslint-disable-next-line global-require
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');

const DEFAULT_SUMMARY_AGENT = 'commonly-bot';
const DEFAULT_SUMMARY_SCOPES = [
  'context:read',
  'summaries:read',
  'messages:write',
  'integration:read',
  'integration:messages:read',
  'integration:write',
];

interface ThemePreset {
  key: string;
  name: string;
  description: string;
  keywords: string[];
}

interface ThemeScore {
  theme: ThemePreset;
  score: number;
  matches: Record<string, unknown>[];
}

interface PodRecord {
  _id: unknown;
  name?: string;
  type?: string;
  members?: unknown[];
}

interface RunAutonomyOptions {
  hours?: number;
  minMatches?: number;
  source?: string;
}

interface AutonomyResult {
  scannedPosts?: number;
  createdPods: Array<{ podId: string; podName?: string; theme: string; score: number }>;
  triggeredPods: Array<{ podId: string; podName?: string; queuedTargets: number }>;
  themeMatches?: Array<{ theme: string; score: number }>;
  skipped?: string;
}

const THEME_PRESETS: ThemePreset[] = [
  {
    key: 'ai-tech',
    name: 'AI & Tech Radar',
    description: 'Curated AI and technology updates from social feeds.',
    keywords: ['ai', 'openai', 'anthropic', 'llm', 'gemini', 'agent', 'automation', 'developer', 'software'],
  },
  {
    key: 'design-ux',
    name: 'Design & UX Signals',
    description: 'Design, UX, and product craft highlights.',
    keywords: ['design', 'ux', 'ui', 'figma', 'branding', 'product design', 'typography', 'visual'],
  },
  {
    key: 'startup-market',
    name: 'Startup & Market Pulse',
    description: 'Startup, product launch, and market momentum highlights.',
    keywords: ['startup', 'funding', 'saas', 'growth', 'launch', 'product hunt', 'founder', 'vc'],
  },
];

const normalize = (value: string): string => String(value || '').toLowerCase();

const buildAgentProfileId = (agentName: string, instanceId = 'default'): string => (
  `${agentName.toLowerCase()}:${instanceId || 'default'}`
);

const ensureSummaryAgentRegistry = async (): Promise<Record<string, unknown>> => {
  let agent = await AgentRegistry.findOne({ agentName: DEFAULT_SUMMARY_AGENT });
  if (agent) return agent;

  const typeConfig = AgentIdentityService.getAgentTypeConfig(DEFAULT_SUMMARY_AGENT);
  agent = await AgentRegistry.create({
    agentName: DEFAULT_SUMMARY_AGENT,
    displayName: typeConfig?.officialDisplayName || 'Commonly Bot',
    description: typeConfig?.officialDescription
      || 'Built-in summary bot for integrations, pod activity, and digest context',
    registry: 'commonly-official',
    categories: ['automation', 'summaries', 'communication'],
    tags: ['summaries', 'digest', 'integrations'],
    verified: true,
    iconUrl: '/icons/commonly-bot.png',
    manifest: {
      name: DEFAULT_SUMMARY_AGENT,
      version: '1.0.0',
      capabilities: (typeConfig?.capabilities || ['summarize', 'digest', 'integrate'])
        .map((name: string) => ({ name, description: name })),
      context: {
        required: ['context:read', 'summaries:read', 'messages:write'],
      },
      runtime: {
        type: 'standalone',
        connection: 'rest',
      },
    },
    latestVersion: '1.0.0',
    versions: [{ version: '1.0.0', publishedAt: new Date() }],
    stats: { installs: 0, rating: 0, ratingCount: 0 },
  });

  return agent;
};

const ensureSummaryAgentInstalled = async ({
  pod, userId,
}: { pod: PodRecord; userId: unknown }): Promise<void> => {
  const agent = await ensureSummaryAgentRegistry();
  const instanceId = 'default';
  const alreadyInstalled = await AgentInstallation.isInstalled(
    (agent as Record<string, unknown>).agentName, pod._id, instanceId,
  );
  if (alreadyInstalled) return;

  const manifest = (agent as Record<string, unknown>).manifest as Record<string, unknown> | undefined;
  const context = manifest?.context as Record<string, unknown> | undefined;
  const requiredScopes: string[] = (context?.required as string[]) || [];
  const scopes = Array.from(new Set([...requiredScopes, ...DEFAULT_SUMMARY_SCOPES]));

  const installation = await AgentInstallation.install(
    (agent as Record<string, unknown>).agentName, pod._id, {
      version: (agent as Record<string, unknown>).latestVersion || '1.0.0',
      config: {
        preset: 'themed-pod-default',
        autoInstalled: true,
        themedPodAutoInstall: true,
      },
      scopes,
      installedBy: userId,
      instanceId,
      displayName: (agent as Record<string, unknown>).displayName || 'Commonly Bot',
    },
  );

  await AgentRegistry.incrementInstalls((agent as Record<string, unknown>).agentName);
  await AgentProfile.updateOne(
    {
      podId: pod._id,
      agentName: (agent as Record<string, unknown>).agentName,
      instanceId,
    },
    {
      $setOnInsert: {
        agentId: buildAgentProfileId(
          (agent as Record<string, unknown>).agentName as string, instanceId,
        ),
        name: installation.displayName || (agent as Record<string, unknown>).displayName || 'Commonly Bot',
        purpose: 'Social helper that summarizes pod and integration activity, curates highlights, and contributes digest context.',
        instructions: 'You summarize key activity, share concise social highlights, and suggest what members should discuss next.',
        createdBy: userId,
      },
      $set: {
        status: 'active',
        persona: {
          tone: 'friendly',
          specialties: ['summarization', 'social highlights', 'conversation prompts', 'digest updates'],
        },
      },
    },
    { upsert: true },
  );

  try {
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(
      (agent as Record<string, unknown>).agentName, {
        instanceId,
        displayName: installation.displayName || (agent as Record<string, unknown>).displayName || 'Commonly Bot',
      },
    );
    await AgentIdentityService.ensureAgentInPod(agentUser, pod._id);
  } catch (error) {
    console.warn('[pod-curation] failed to ensure commonly-bot identity in themed pod:', (error as Error).message);
  }
};

const getSeedUser = async (): Promise<unknown> => {
  const admin = await User.findOne({ role: 'admin' }).select('_id').lean() as { _id: unknown } | null;
  if (admin?._id) return admin._id;
  const anyUser = await User.findOne({}).select('_id').lean() as { _id: unknown } | null;
  return anyUser?._id || null;
};

const getRecentSocialPosts = async ({
  hours = 12, limit = 300,
} = {}): Promise<Record<string, unknown>[]> => {
  const since = new Date(Date.now() - (hours * 60 * 60 * 1000));
  return Post.find({
    createdAt: { $gte: since },
    $or: [
      { category: 'Social' },
      { 'source.provider': { $in: ['x', 'instagram'] } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

const scoreTheme = (theme: ThemePreset, posts: Record<string, unknown>[]): ThemeScore => {
  const keywords = theme.keywords.map(normalize);
  const matches = posts.filter((post) => {
    const tags = (post.tags as string[] || []).join(' ');
    const haystack = normalize(`${post.content || ''} ${tags}`);
    return keywords.some((keyword) => haystack.includes(keyword));
  });
  return {
    theme,
    score: matches.length,
    matches,
  };
};

const createThemedPod = async ({
  theme, createdBy,
}: { theme: ThemePreset; createdBy: unknown }): Promise<{ pod: PodRecord; created: boolean }> => {
  const existing = await Pod.findOne({ name: theme.name }).lean() as PodRecord | null;
  if (existing) {
    return { pod: existing, created: false };
  }

  const pod = await Pod.create({
    name: theme.name,
    description: theme.description,
    type: 'chat',
    createdBy,
    members: [createdBy],
  }) as PodRecord;

  return { pod, created: true };
};

const enqueueCurateEvent = async ({
  podId, source = 'themed-pod-autonomy',
}: { podId: unknown; source?: string }): Promise<number> => {
  const installations = await AgentInstallation.find({
    agentName: DEFAULT_SUMMARY_AGENT,
    podId,
    status: 'active',
  }).select('instanceId').lean() as Array<{ instanceId?: string }>;

  if (!installations.length) return 0;

  await Promise.all(
    installations.map((installation) => (
      AgentEventService.enqueue({
        agentName: DEFAULT_SUMMARY_AGENT,
        instanceId: installation.instanceId || 'default',
        podId,
        type: 'curate',
        payload: {
          source,
          topN: 3,
          limit: 40,
        },
      })
    )),
  );

  return installations.length;
};

class PodCurationService {
  static async runThemedPodAutonomy({
    hours = 12, minMatches = 4, source = 'themed-pod-autonomy',
  }: RunAutonomyOptions = {}): Promise<AutonomyResult> {
    const seedUserId = await getSeedUser();
    if (!seedUserId) {
      return { createdPods: [], triggeredPods: [], skipped: 'no-seed-user' };
    }

    const posts = await getRecentSocialPosts({ hours });
    if (!posts.length) {
      return { createdPods: [], triggeredPods: [], scannedPosts: 0 };
    }

    const themeScores = THEME_PRESETS
      .map((theme) => scoreTheme(theme, posts))
      .filter((result) => result.score >= minMatches);

    const createdPods: AutonomyResult['createdPods'] = [];
    const triggeredPods: AutonomyResult['triggeredPods'] = [];

    for (const themeResult of themeScores) {
      const { pod, created } = await createThemedPod({
        theme: themeResult.theme,
        createdBy: seedUserId,
      });
      if (!pod?._id) continue;

      await ensureSummaryAgentInstalled({
        pod,
        userId: seedUserId,
      });

      const queuedTargets = await enqueueCurateEvent({ podId: pod._id, source });
      if (queuedTargets > 0) {
        triggeredPods.push({
          podId: String(pod._id),
          podName: pod.name,
          queuedTargets,
        });
      }

      if (created) {
        createdPods.push({
          podId: String(pod._id),
          podName: pod.name,
          theme: themeResult.theme.key,
          score: themeResult.score,
        });
      }
    }

    return {
      scannedPosts: posts.length,
      createdPods,
      triggeredPods,
      themeMatches: themeScores.map((item) => ({
        theme: item.theme.key,
        score: item.score,
      })),
    };
  }
}

export default PodCurationService;
