/**
 * Qwen Code, one headless turn per process:
 *   qwen --bare --safe-mode --auth-type openai -m <model> -o stream-json [--resume <id>] < prompt
 *
 * The same invocation the CLI's production qwen adapter uses. The provider
 * goes in OPENAI_BASE_URL / OPENAI_API_KEY; QWEN_HOME is the run's HOME so a
 * resume finds the session the first turn recorded.
 *
 * stdout is stream-json: `system/init` and every later event carry
 * session_id; `assistant` carries text blocks; `result` closes the turn and
 * says is_error, with the provider's text in error.message.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHeadlessAdapter } from './headless.js';

const parse = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

export const readQwenEvent = (line, state) => {
  const event = parse(line);
  if (!event || typeof event !== 'object') return;
  if (typeof event.session_id === 'string' && event.session_id) state.sessionId = event.session_id;
  if (event.type === 'assistant') {
    const text = (event.message?.content || [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text).join('');
    if (text) state.chunks.push(text);
  } else if (event.type === 'result') {
    if (event.is_error) state.error = String(event.error?.message || event.result || `qwen result ${event.subtype || 'error'}`);
    else if (typeof event.result === 'string') state.text = event.result;
  }
};

export const createQwenAdapter = createHeadlessAdapter({
  name: 'qwen',
  cli: 'qwen',
  command: 'qwen',
  versionPattern: /(\d+\.\d+\.\d+[^\s]*)/,
  async launch(prompt, ctx, { provider, env, home }) {
    const qwenHome = join(home, '.qwen');
    await mkdir(qwenHome, { recursive: true, mode: 0o700 });
    const settingsPath = join(qwenHome, 'system-settings.json');
    await writeFile(settingsPath, JSON.stringify({
      privacy: { usageStatisticsEnabled: false },
      general: { enableAutoUpdate: false },
    }), { mode: 0o600 });
    return {
      args: [
        '--bare', '--safe-mode', '--auth-type', 'openai', '-m', provider.model, '-o', 'stream-json',
        ...(ctx.sessionId ? ['--resume', ctx.sessionId] : []),
      ],
      stdin: prompt,
      env: {
        ...env,
        QWEN_HOME: qwenHome,
        QWEN_RUNTIME_DIR: qwenHome,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsPath,
        QWEN_USAGE_STATISTICS_ENABLED: 'false',
        OPENAI_BASE_URL: provider.baseURL,
        OPENAI_API_KEY: provider.apiKey,
        OPENAI_MODEL: provider.model,
      },
    };
  },
  read: readQwenEvent,
});

export default createQwenAdapter;
