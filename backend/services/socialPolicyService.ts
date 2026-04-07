import SystemSetting from '../models/SystemSetting';

const SOCIAL_POLICY_KEY = 'social.publishPolicy';

export interface SocialPolicy {
  socialMode: 'repost' | 'rewrite';
  publishEnabled: boolean;
  strictAttribution: boolean;
}

const DEFAULT_POLICY: SocialPolicy = {
  socialMode: 'repost',
  publishEnabled: false,
  strictAttribution: true,
};

const normalizeMode = (mode: unknown): 'repost' | 'rewrite' => {
  const value = String(mode || '').toLowerCase();
  if (value === 'rewrite') return 'rewrite';
  return 'repost';
};

const sanitizePolicy = (candidate: Partial<SocialPolicy> = {}): SocialPolicy => ({
  socialMode: normalizeMode(candidate.socialMode || DEFAULT_POLICY.socialMode),
  publishEnabled: Boolean(candidate.publishEnabled),
  strictAttribution: Boolean(
    typeof candidate.strictAttribution === 'boolean'
      ? candidate.strictAttribution
      : DEFAULT_POLICY.strictAttribution,
  ),
});

class SocialPolicyService {
  static defaults(): SocialPolicy {
    return { ...DEFAULT_POLICY };
  }

  static async getPolicy(): Promise<SocialPolicy> {
    const setting = await SystemSetting.findOne({ key: SOCIAL_POLICY_KEY }).lean() as Record<string, unknown> | null;
    if (!setting?.value || typeof setting.value !== 'object') {
      return SocialPolicyService.defaults();
    }
    return sanitizePolicy({
      ...DEFAULT_POLICY,
      ...(setting.value as Partial<SocialPolicy>),
    });
  }

  static async setPolicy(policy: Partial<SocialPolicy>, userId: string | null = null): Promise<SocialPolicy> {
    const next = sanitizePolicy(policy);
    await SystemSetting.findOneAndUpdate(
      { key: SOCIAL_POLICY_KEY },
      {
        $set: {
          value: next,
          updatedBy: userId || null,
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
    return next;
  }
}

export default SocialPolicyService;
