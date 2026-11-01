/**
 * GitHub Copilot CLI, one headless turn per process:
 *   copilot --output-format json --allow-all-tools [--resume <id>] < prompt
 *
 * Copilot reaches the run's provider through its BYOK variables
 * (COPILOT_PROVIDER_BASE_URL with type openai). With COPILOT_OFFLINE set it
 * makes no GitHub call at all, so no GitHub sign-in is needed. The key goes
 * in COPILOT_PROVIDER_API_KEY, never argv; the prompt goes on stdin.
 *
 * stdout is JSONL: assistant.message_delta / assistant.message carry the
 * reply, session.error carries a provider failure with its HTTP status, and
 * the closing `result` event carries the session id a resume names.
 */
import { join } from 'node:path';
import { createHeadlessAdapter } from './headless.js';

const parse = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

export const readCopilotEvent = (line, state) => {
  const event = parse(line);
  if (!event || typeof event !== 'object') return;
  const data = event.data || {};
  switch (event.type) {
    case 'assistant.message_delta':
      if (typeof data.deltaContent === 'string' && data.deltaContent) state.chunks.push(data.deltaContent);
      break;
    case 'assistant.message':
      // A turn with tool calls has several assistant messages; the reply is
      // the last one that says something.
      if (typeof data.content === 'string' && data.content) state.text = data.content;
      break;
    case 'session.error':
      state.error = String(data.message || data.errorType || 'session.error');
      break;
    case 'result':
      if (typeof event.sessionId === 'string' && event.sessionId) state.sessionId = event.sessionId;
      break;
    default:
  }
};

export const createCopilotAdapter = createHeadlessAdapter({
  name: 'copilot',
  cli: 'copilot',
  command: 'copilot',
  versionPattern: /Copilot CLI\s+v?(\d+\.\d+\.\d+[^\s.]*)/,
  async launch(prompt, ctx, { provider, env, home }) {
    return {
      args: [
        '--output-format', 'json', '--allow-all-tools',
        ...(ctx.sessionId ? [`--resume=${ctx.sessionId}`] : []),
      ],
      stdin: prompt,
      env: {
        ...env,
        COPILOT_HOME: join(home, '.copilot'),
        COPILOT_OFFLINE: 'true',
        COPILOT_AUTO_UPDATE: 'false',
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_PROVIDER_BASE_URL: provider.baseURL,
        COPILOT_PROVIDER_API_KEY: provider.apiKey,
        COPILOT_MODEL: provider.model,
      },
    };
  },
  read: readCopilotEvent,
});

export default createCopilotAdapter;
