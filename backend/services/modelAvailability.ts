import axios from 'axios';

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  available: boolean;
  reason: string | null;
}
export interface ModelCatalog { models: ModelOption[]; checkedAt: string; }

// Retain the choices users have already been offered, even if a route disappears.
const offeredModels: Record<string, string> = {
  'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
  'google/gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
  'google/gemini-2.0-flash': 'Gemini 2.0 Flash',
  'openai/gpt-5.4': 'GPT-5.4',
  'openai/gpt-4o': 'GPT-4o',
  'openai/gpt-4o-mini': 'GPT-4o Mini',
  'openai/gpt-4.1': 'GPT-4.1',
  'openai-codex/gpt-5.4': 'GPT-5.4 (OAuth)',
  'openai-codex/gpt-5.3-codex': 'GPT-5.3 Codex (OAuth, legacy)',
  'anthropic/claude-opus-4-6': 'Claude Opus 4.6',
  'anthropic/claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'anthropic/claude-haiku-4-5': 'Claude Haiku 4.5',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron 120B (OpenRouter free)',
  'openrouter/arcee-ai/trinity-large-preview:free': 'Trinity Large (OpenRouter free)',
};
const knownModels = new Map(Object.entries(offeredModels));
const CACHE_MS = 300_000;
let cached: ModelCatalog | null = null;
let pending: Promise<ModelCatalog> | null = null;
let cachedAt = 0;

const providerFor = (id: string) => {
  const prefix = id.split('/')[0];
  return ['google', 'openai', 'openai-codex', 'anthropic', 'openrouter'].includes(prefix) ? prefix : 'custom';
};
const unavailable = (id: string, reason: string): ModelOption => ({
  id, label: knownModels.get(id) || id, provider: providerFor(id), available: false, reason,
});

export const modelAvailability = (catalog: ModelCatalog, model: unknown): ModelOption => {
  const id = String(model || '');
  return catalog.models.find((option) => option.id === id)
    || unavailable(id, 'This model has no configured route on this instance');
};

// Raw health errors may include keys, URLs or provider request bodies. Only
// fixed, actionable classifications cross the user-facing API boundary.
const failureReason = (endpoint: any): string => {
  const error = String(endpoint.error || endpoint.mode_error || '');
  if (/401|403|auth|expired|api.?key/i.test(error)) return 'The upstream rejected this route’s credentials';
  if (/429|rate.?limit|quota|budget/i.test(error)) return 'This route is currently rate limited or out of quota';
  return 'This route failed its latest health check';
};

const refresh = async (): Promise<ModelCatalog> => {
  const checkedAt = new Date().toISOString();
  const base = (process.env.LITELLM_BASE_URL || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const key = process.env.LITELLM_MASTER_KEY || process.env.LITELLM_API_KEY;
  if (!base || !key) {
    return {
      checkedAt,
      models: [...knownModels.keys()].map((id) => unavailable(id, 'The instance model gateway is not configured')),
    };
  }
  try {
    const config = { headers: { Authorization: `Bearer ${key}` }, timeout: 10_000 };
    const { data } = await axios.get(`${base}/model/info`, config);
    const info = data?.data;
    const routes: any[] = Array.isArray(info) ? info.filter((route: any) => (
      typeof route.model_name === 'string'
      && (!route.model_info?.mode
        || ['chat', 'completion', 'responses', 'anthropic_messages'].includes(route.model_info.mode))
    )) : [];
    routes.forEach((route) => {
      knownModels.set(route.model_name, knownModels.get(route.model_name) || route.model_name);
    });
    // Probe chat deployments separately: one stalled route must not erase all
    // healthy results, and this screen must not probe image/embedding routes.
    const healthResults = await Promise.allSettled(routes.map((route) => axios.get(`${base}/health`, {
      ...config,
      params: route.model_info?.id != null
        ? { model_id: route.model_info.id } : { model: route.model_name },
    })));
    const health = healthResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value.data] : []));
    const healthy = health.flatMap((entry) => (Array.isArray(entry?.healthy_endpoints) ? entry.healthy_endpoints : []));
    const unhealthy = health.flatMap((entry) => (Array.isArray(entry?.unhealthy_endpoints) ? entry.unhealthy_endpoints : []));
    const matches = (endpoint: any, route: any) => {
      if (endpoint.model_id != null && route.model_info?.id != null) {
        return String(endpoint.model_id) === String(route.model_info.id);
      }
      // Older proxies lack deployment ids. A model-only result is safe only
      // when it identifies a single deployment; different keys may disagree.
      return endpoint.model === route.litellm_params?.model
        && routes.filter((entry) => entry.litellm_params?.model === endpoint.model).length === 1;
    };
    const models = [...knownModels.keys()].map((id) => {
      const deployments = routes.filter((route) => route.model_name === id);
      if (!Array.isArray(info)) return unavailable(id, 'The instance model list could not be checked');
      if (!deployments.length) {
        return unavailable(id, 'This model has no configured route on this instance');
      }
      if (deployments.some((route) => healthy.some((entry: any) => matches(entry, route)))) {
        return { ...unavailable(id, ''), available: true, reason: null };
      }
      const failed = unhealthy.find((entry: any) => deployments.some((route) => matches(entry, route)));
      return unavailable(id, failed ? failureReason(failed) : 'This route’s health could not be confirmed');
    });
    return { checkedAt, models };
  } catch {
    return {
      checkedAt,
      models: [...knownModels.keys()].map((id) => unavailable(id, 'The instance model gateway could not be checked')),
    };
  }
};

// One refresh for concurrent readers. Failed refreshes also expire: stale green
// status must never survive an outage, nor should an outage cause a probe storm.
export const getModelCatalog = async (): Promise<ModelCatalog> => {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  if (!pending) {
    pending = refresh().then((value) => {
      cached = value;
      cachedAt = Date.now();
      return value;
    }).finally(() => { pending = null; });
  }
  return pending;
};
