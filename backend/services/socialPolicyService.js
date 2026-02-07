const SystemSetting = require('../models/SystemSetting');

const SOCIAL_POLICY_KEY = 'social.publishPolicy';

const DEFAULT_POLICY = {
  socialMode: 'repost', // repost | rewrite
  publishEnabled: false,
  strictAttribution: true,
};

const normalizeMode = (mode) => {
  const value = String(mode || '').toLowerCase();
  if (value === 'rewrite') return 'rewrite';
  return 'repost';
};

const sanitizePolicy = (candidate = {}) => ({
  socialMode: normalizeMode(candidate.socialMode || DEFAULT_POLICY.socialMode),
  publishEnabled: Boolean(candidate.publishEnabled),
  strictAttribution: Boolean(
    typeof candidate.strictAttribution === 'boolean'
      ? candidate.strictAttribution
      : DEFAULT_POLICY.strictAttribution,
  ),
});

class SocialPolicyService {
  static defaults() {
    return { ...DEFAULT_POLICY };
  }

  static async getPolicy() {
    const setting = await SystemSetting.findOne({ key: SOCIAL_POLICY_KEY }).lean();
    if (!setting?.value || typeof setting.value !== 'object') {
      return SocialPolicyService.defaults();
    }
    return sanitizePolicy({
      ...DEFAULT_POLICY,
      ...setting.value,
    });
  }

  static async setPolicy(policy, userId = null) {
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

module.exports = SocialPolicyService;
