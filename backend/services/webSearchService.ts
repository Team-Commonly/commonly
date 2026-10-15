/**
 * Web search for native turns (TASK-267a).
 *
 * One function, two providers. `SEARCH_PROVIDER` picks `exa` (the default) or
 * `tavily`, so the provider is a configuration choice, not a dependency
 * (Cofounder, 2026-10-15). Exa was chosen on the numbers: a no-card free tier,
 * the cheapest per search after it, and page text an agent can cite.
 *
 * Results are third-party text and may carry injected instructions. The
 * caller (the native runtime) marks them untrusted and narrows the rest of
 * the turn to in-pod read and post, the same boundary as connector results
 * (TASK-224). This module only fetches and shapes them.
 *
 * The query is sent to the provider. It is model-written, so it can contain
 * whatever the turn has read; this is the same exposure as the model call,
 * and the tool is opt-in per agent.
 */
import axios from 'axios';

const RESULT_LIMIT = 5;
const TEXT_LIMIT = 1500;
const QUERY_LIMIT = 400;
const TIMEOUT_MS = 15_000;

export interface WebResult {
  title: string;
  url: string;
  text: string;
  published?: string;
}

export interface WebSearchOutcome {
  provider: string;
  results: WebResult[];
}

const clip = (value: unknown, limit: number): string => {
  // Drop control characters except newline and tab, then clip.
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const httpUrl = (value: unknown): string | null => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

type Adapter = (query: string, apiKey: string) => Promise<WebResult[]>;

const exa: Adapter = async (query, apiKey) => {
  const { data } = await axios.post('https://api.exa.ai/search', {
    query,
    numResults: RESULT_LIMIT,
    type: 'auto',
    contents: { text: { maxCharacters: TEXT_LIMIT } },
  }, { headers: { 'x-api-key': apiKey }, timeout: TIMEOUT_MS });
  return (Array.isArray(data?.results) ? data.results : []).map((row: any) => ({
    title: clip(row?.title, 200),
    url: httpUrl(row?.url) || '',
    text: clip(row?.text, TEXT_LIMIT),
    ...(row?.publishedDate ? { published: clip(row.publishedDate, 40) } : {}),
  }));
};

const tavily: Adapter = async (query, apiKey) => {
  const { data } = await axios.post('https://api.tavily.com/search', {
    query,
    max_results: RESULT_LIMIT,
    search_depth: 'basic',
    include_raw_content: false,
  }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: TIMEOUT_MS });
  return (Array.isArray(data?.results) ? data.results : []).map((row: any) => ({
    title: clip(row?.title, 200),
    url: httpUrl(row?.url) || '',
    text: clip(row?.content, TEXT_LIMIT),
  }));
};

const ADAPTERS: Record<string, Adapter> = { exa, tavily };

export const searchProvider = (): string => String(process.env.SEARCH_PROVIDER || 'exa').trim().toLowerCase();

/** Configured when there is a key and the provider is one we have an adapter for. */
export const isSearchConfigured = (): boolean => Boolean(process.env.SEARCH_API_KEY) && Boolean(ADAPTERS[searchProvider()]);

export const searchWeb = async (rawQuery: string): Promise<WebSearchOutcome> => {
  const provider = searchProvider();
  const adapter = ADAPTERS[provider];
  const apiKey = process.env.SEARCH_API_KEY || '';
  if (!adapter || !apiKey) throw new Error('web search is not configured on this instance');
  const query = clip(rawQuery, QUERY_LIMIT);
  if (!query) throw new Error('query is empty');
  const results = (await adapter(query, apiKey)).filter((row) => row.url).slice(0, RESULT_LIMIT);
  return { provider, results };
};
