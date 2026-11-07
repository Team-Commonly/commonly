/**
 * CLIs on the compat matrix that cannot be pointed at the run's provider.
 * Each detects its pinned binary like any other target, and every turn fails
 * as RunFailure provider_unsupported naming why, so the matrix shows a named
 * red row rather than a skip. The reasons were read from each CLI's own
 * --help and docs at the pinned version; a release that adds a custom
 * OpenAI- or Anthropic-compatible base URL should get a real adapter.
 */
import { createProviderUnsupportedAdapter } from './headless.js';

export const createGeminiAdapter = createProviderUnsupportedAdapter({
  name: 'gemini',
  cli: 'gemini',
  command: 'gemini',
  versionPattern: /(\d+\.\d+\.\d+[^\s]*)/,
  detail: 'Gemini CLI speaks only the Gemini API (GOOGLE_GEMINI_BASE_URL and Vertex both expect a Gemini endpoint); '
    + 'it has no OpenAI- or Anthropic-compatible provider route',
});

export const createCursorAdapter = createProviderUnsupportedAdapter({
  name: 'cursor',
  cli: 'cursor-agent',
  command: 'cursor-agent',
  versionPattern: /(\d{4}\.\d+\.\d+-[0-9a-f]+)/,
  detail: "cursor-agent sends every model call through Cursor's own backend (--endpoint names Cursor's API, not a model provider) "
    + 'and signs in with CURSOR_API_KEY; it has no OpenAI- or Anthropic-compatible base URL',
});

export const createAmpAdapter = createProviderUnsupportedAdapter({
  name: 'amp',
  cli: 'amp',
  command: 'amp',
  versionPattern: /(\d+\.\d+\.\d+-g[0-9a-f]+)/,
  detail: 'Amp sends every model call through the Amp service (AMP_URL names an Amp server, not a model provider) '
    + 'and signs in with AMP_API_KEY; it has no OpenAI- or Anthropic-compatible base URL',
});
