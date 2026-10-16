// Campaign ref codes for visit counting (routes/attribution.ts): a
// system_settings row { key: 'attribution.refs', value: [...] }, added to
// without a deploy (docs/runbooks/ref-links.md). A listed code always keeps its
// own visit row. Each entry passes the ref rule or is ignored, and a missing,
// unreadable or empty row means ['x'], never "allow all".
//
// Read at most once a minute per process: the endpoint takes every first visit,
// and the list changes a few times a quarter. A failed read is not cached, so
// the next visit tries again.
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const SystemSetting = require('../models/SystemSetting');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { cleanSignupRef } = require('../utils/signupRef');

const ATTRIBUTION_REFS_KEY = 'attribution.refs';
const DEFAULT_CAMPAIGN_REFS = ['x'];
const CACHE_MS = 60 * 1000;

let cached: { at: number; refs: Set<string> } | null = null;

const campaignRefs = async (): Promise<Set<string>> => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.refs;
  try {
    const row = await SystemSetting.findOne({ key: ATTRIBUTION_REFS_KEY }).lean() as { value?: unknown } | null;
    const entries: unknown[] = Array.isArray(row?.value) ? row?.value as unknown[] : [];
    const listed = entries.map((entry) => cleanSignupRef(entry) as string | undefined)
      .filter((ref): ref is string => Boolean(ref));
    const refs = new Set<string>(listed.length ? listed : DEFAULT_CAMPAIGN_REFS);
    cached = { at: Date.now(), refs };
    return refs;
  } catch {
    return new Set(DEFAULT_CAMPAIGN_REFS);
  }
};

const clearCampaignRefsCache = (): void => { cached = null; };

module.exports = {
  ATTRIBUTION_REFS_KEY, CACHE_MS, campaignRefs, clearCampaignRefsCache,
};

export {};
