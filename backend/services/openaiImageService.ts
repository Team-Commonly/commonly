/**
 * OpenAI Image Generation Service
 *
 * Thin wrapper around the OpenAI SDK's `images.generate` endpoint.
 * Used by the agent avatar generation flow and the generate-team-avatars script.
 *
 * Supports `gpt-image-1` (newer, unified) and `dall-e-3` as a fallback. Initializes
 * the client lazily so unit tests and environments without OPENAI_API_KEY do not
 * crash on import.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type OpenAIImageModel = 'gpt-image-1' | 'dall-e-3' | 'dall-e-2';
type OpenAIImageSize =
  | '1024x1024'
  | '1792x1024'
  | '1024x1792'
  | '512x512'
  | '256x256';
type OpenAIImageStyle = 'vivid' | 'natural';
type OpenAIImageQuality = 'standard' | 'hd';

export interface GenerateImageParams {
  prompt: string;
  size?: OpenAIImageSize;
  model?: OpenAIImageModel;
  style?: OpenAIImageStyle;
  quality?: OpenAIImageQuality;
}

export interface GeneratedImage {
  dataUri: string;
  revisedPrompt?: string;
  model: string;
  costEstimateUsd?: number;
  createdAt: Date;
}

class OpenAIImageError extends Error {
  kind:
    | 'auth'
    | 'rate_limit'
    | 'network'
    | 'safety'
    | 'server'
    | 'not_installed'
    | 'unknown';

  status?: number;

  constructor(
    message: string,
    kind: OpenAIImageError['kind'] = 'unknown',
    status?: number,
  ) {
    super(message);
    this.name = 'OpenAIImageError';
    this.kind = kind;
    this.status = status;
  }
}

export { OpenAIImageError };

const DEFAULT_MODEL: OpenAIImageModel = 'gpt-image-1';
const DEFAULT_SIZE: OpenAIImageSize = '1024x1024';
const MAX_RETRIES_RATE_LIMIT = 1;
const MAX_RETRIES_SERVER = 1;
const RATE_LIMIT_BACKOFF_MS = 2_000;

let cachedClient: any = null;
let cachedClientKey: string | null = null;

const loadOpenAIModule = (): any => {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const mod = require('openai');
    return mod?.default || mod?.OpenAI || mod;
  } catch (error: any) {
    throw new OpenAIImageError(
      'openai SDK not installed — run `npm install` in backend/',
      'not_installed',
    );
  }
};

const getClient = (): any => {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    throw new OpenAIImageError(
      'OPENAI_API_KEY is not set; cannot call OpenAI image API',
      'auth',
    );
  }
  if (cachedClient && cachedClientKey === apiKey) {
    return cachedClient;
  }
  const OpenAI = loadOpenAIModule();
  cachedClient = new OpenAI({ apiKey });
  cachedClientKey = apiKey;
  return cachedClient;
};

export function isOpenAIImageAvailable(): boolean {
  return Boolean((process.env.OPENAI_API_KEY || '').trim());
}

/**
 * Returns an approximate USD cost estimate for a given model/size/quality.
 * OpenAI revises prices frequently — these are April 2026 published list prices
 * and may drift.
 */
const estimateCostUsd = (
  model: OpenAIImageModel,
  size: OpenAIImageSize,
  quality: OpenAIImageQuality,
): number => {
  if (model === 'dall-e-3') {
    if (size === '1792x1024' || size === '1024x1792') {
      return quality === 'hd' ? 0.12 : 0.08;
    }
    return quality === 'hd' ? 0.08 : 0.04;
  }
  if (model === 'gpt-image-1') {
    // gpt-image-1 pricing is usage-based; use a rough parity estimate with dall-e-3.
    return quality === 'hd' ? 0.08 : 0.04;
  }
  // dall-e-2
  if (size === '512x512') return 0.018;
  if (size === '256x256') return 0.016;
  return 0.02;
};

const classifyError = (err: any): OpenAIImageError => {
  const status: number | undefined = err?.status || err?.response?.status;
  const code: string | undefined =
    err?.code || err?.error?.code || err?.response?.data?.error?.code;
  const msg: string =
    err?.message ||
    err?.error?.message ||
    err?.response?.data?.error?.message ||
    'Unknown OpenAI image error';

  if (status === 401 || status === 403 || code === 'invalid_api_key') {
    return new OpenAIImageError(`OpenAI auth failed: ${msg}`, 'auth', status);
  }
  if (status === 429 || code === 'rate_limit_exceeded') {
    return new OpenAIImageError(
      `OpenAI rate limit: ${msg}`,
      'rate_limit',
      status,
    );
  }
  if (
    code === 'content_policy_violation' ||
    /safety|policy/i.test(msg)
  ) {
    return new OpenAIImageError(
      `OpenAI safety policy blocked the prompt: ${msg}`,
      'safety',
      status,
    );
  }
  if (typeof status === 'number' && status >= 500) {
    return new OpenAIImageError(
      `OpenAI server error (${status}): ${msg}`,
      'server',
      status,
    );
  }
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.code === 'ENOTFOUND') {
    return new OpenAIImageError(
      `Network error reaching OpenAI: ${msg}`,
      'network',
    );
  }
  return new OpenAIImageError(msg, 'unknown', status);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const toDataUriFromB64 = (b64: string): string => `data:image/png;base64,${b64}`;

const fetchUrlToDataUri = async (url: string): Promise<string> => {
  // Node 18+ has global fetch; fall back to node-fetch if not available.
  const fetcher: any = (global as any).fetch
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    || require('node-fetch');
  const response = await fetcher(url);
  if (!response.ok) {
    throw new OpenAIImageError(
      `Failed to download image from OpenAI CDN (${response.status})`,
      'network',
      response.status,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:image/png;base64,${buffer.toString('base64')}`;
};

const callOpenAIOnce = async (
  client: any,
  model: OpenAIImageModel,
  params: GenerateImageParams,
): Promise<{ dataUri: string; revisedPrompt?: string }> => {
  const size = params.size || DEFAULT_SIZE;
  const quality = params.quality || 'standard';
  const style = params.style || 'vivid';

  // Shape the request body differently for gpt-image-1 vs dall-e-3.
  // dall-e-3 supports `response_format: 'b64_json'`; gpt-image-1 may or may not
  // depending on SDK version — try b64_json first, fall back to URL fetch.
  const baseBody: any = {
    model,
    prompt: params.prompt,
    size,
    n: 1,
  };
  if (model === 'dall-e-3') {
    baseBody.quality = quality;
    baseBody.style = style;
    baseBody.response_format = 'b64_json';
  } else if (model === 'gpt-image-1') {
    // gpt-image-1: SDK returns b64 by default when supported.
    baseBody.quality = quality === 'hd' ? 'high' : 'medium';
  }

  const response = await client.images.generate(baseBody);
  const item = response?.data?.[0];
  if (!item) {
    throw new OpenAIImageError(
      'OpenAI returned no image payload',
      'unknown',
    );
  }
  const revisedPrompt: string | undefined =
    item.revised_prompt || item.revisedPrompt || undefined;

  if (item.b64_json) {
    return { dataUri: toDataUriFromB64(item.b64_json), revisedPrompt };
  }
  if (item.url) {
    const dataUri = await fetchUrlToDataUri(item.url);
    return { dataUri, revisedPrompt };
  }
  throw new OpenAIImageError(
    'OpenAI response missing both b64_json and url',
    'unknown',
  );
};

/**
 * Generate an image via OpenAI. Returns a base64 data URI suitable for storing
 * directly on User.profilePicture. Falls back from gpt-image-1 -> dall-e-3 if
 * the SDK version rejects gpt-image-1 as a model name.
 */
export async function generateImage(
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  if (!params?.prompt || !params.prompt.trim()) {
    throw new OpenAIImageError('prompt is required', 'unknown');
  }

  const client = getClient();
  const requestedModel = params.model || DEFAULT_MODEL;
  const size = params.size || DEFAULT_SIZE;
  const quality = params.quality || 'standard';

  const attemptModels: OpenAIImageModel[] = [requestedModel];
  if (requestedModel === 'gpt-image-1' && !attemptModels.includes('dall-e-3')) {
    attemptModels.push('dall-e-3');
  }

  let lastError: OpenAIImageError | null = null;

  // eslint-disable-next-line no-restricted-syntax
  for (const model of attemptModels) {
    let rateLimitRetries = 0;
    let serverRetries = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await callOpenAIOnce(client, model, params);
        const costEstimateUsd = estimateCostUsd(model, size, quality);
        // eslint-disable-next-line no-console
        console.log(
          `[openaiImageService] generated ${model} ${size} ${quality} `
          + `~$${costEstimateUsd.toFixed(4)} (estimate, may drift)`,
        );
        return {
          dataUri: result.dataUri,
          revisedPrompt: result.revisedPrompt,
          model,
          costEstimateUsd,
          createdAt: new Date(),
        };
      } catch (rawError: any) {
        const classified = classifyError(rawError);
        lastError = classified;

        // Retry once on rate limit
        if (
          classified.kind === 'rate_limit'
          && rateLimitRetries < MAX_RETRIES_RATE_LIMIT
        ) {
          rateLimitRetries += 1;
          // eslint-disable-next-line no-console
          console.warn(
            `[openaiImageService] rate-limited on ${model}; retrying in ${RATE_LIMIT_BACKOFF_MS}ms`,
          );
          // eslint-disable-next-line no-await-in-loop
          await sleep(RATE_LIMIT_BACKOFF_MS);
          // eslint-disable-next-line no-continue
          continue;
        }

        // Retry once on 5xx
        if (classified.kind === 'server' && serverRetries < MAX_RETRIES_SERVER) {
          serverRetries += 1;
          // eslint-disable-next-line no-console
          console.warn(
            `[openaiImageService] server error on ${model}; retrying once`,
          );
          // eslint-disable-next-line no-await-in-loop
          await sleep(500);
          // eslint-disable-next-line no-continue
          continue;
        }

        // If the model itself is rejected (e.g. unknown model name on older SDK),
        // break out of the retry loop so the outer loop can try the next model.
        const looksLikeModelRejection = /model|not.*found|does.*not.*exist/i.test(
          classified.message,
        ) && (classified.status === 400 || classified.status === 404);
        if (looksLikeModelRejection) {
          // eslint-disable-next-line no-console
          console.warn(
            `[openaiImageService] model '${model}' rejected; trying next model`,
          );
          break;
        }

        // Non-retriable error — rethrow
        throw classified;
      }
    }
  }

  throw (
    lastError
    || new OpenAIImageError('OpenAI image generation failed for all model candidates', 'unknown')
  );
}

// CJS compat — match the idiom used elsewhere in backend/services so
// `require('./openaiImageService')` returns the named exports directly.
export default { generateImage, isOpenAIImageAvailable, OpenAIImageError };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
