/**
 * The LiteLLM model name that every driver default names (F103): the K8s
 * provisioner's community and dev-agent primaries, both LiteLLM key
 * allowlists, the gateway's model registry, and the global policy's community
 * and OpenClaw defaults (F105). The chart sets AGENT_DEFAULT_MODEL from `litellm.agentDefaultModel`
 * (base `deepseek-v4-flash`, dev `claude-haiku-5-5`), and the same value seeds
 * the static gateway config and cloud-codex's codex CLI, so a default always
 * names a route LiteLLM serves under its own name.
 *
 * Before F103 these defaults named other vendors' models (nemotron, gpt-5.4*,
 * openai-codex/*, codex-cli/gpt-5.4) that LiteLLM quietly served with DeepSeek.
 *
 * The fallback is for a run with no chart (a local backend); it matches base.
 * The docker-compose LiteLLM (external/litellm/config.yaml) has its own model
 * list, so a compose run sets AGENT_DEFAULT_MODEL to one of its names.
 */
export const AGENT_DEFAULT_MODEL_FALLBACK = 'deepseek-v4-flash';

export function agentDefaultModel(): string {
  return String(process.env.AGENT_DEFAULT_MODEL || '').trim() || AGENT_DEFAULT_MODEL_FALLBACK;
}

/**
 * The model a platform call asks LiteLLM for when nothing names one (F105): the
 * chart's LITELLM_CHAT_MODEL, else the agent default. llmService, the dev chat
 * route and the global policy's llmService default read it. Before F105 they
 * defaulted to `gemini-2.5-flash`, which LiteLLM served with DeepSeek under
 * `litellm.legacyAliases` wherever Gemini was off.
 */
export function defaultChatModel(): string {
  return String(process.env.LITELLM_CHAT_MODEL || '').trim() || agentDefaultModel();
}

/**
 * A call that goes straight to Google's own API (the Gemini SDK or REST, never
 * LiteLLM) needs a Gemini model name. This keeps the name it was given when that
 * is a Gemini name, and otherwise gives Google's default, so a LiteLLM name
 * such as `deepseek-v4-flash` is never sent to Google (F105).
 */
export const GEMINI_DIRECT_MODEL = 'gemini-2.5-flash';

export function geminiDirectModel(model?: unknown): string {
  const name = String(model || '').trim();
  return /^(models\/)?gemini-/i.test(name) ? name : GEMINI_DIRECT_MODEL;
}
