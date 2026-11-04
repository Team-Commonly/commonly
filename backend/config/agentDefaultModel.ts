/**
 * The LiteLLM model name that every driver default names (F103): the K8s
 * provisioner's community and dev-agent primaries, both LiteLLM key
 * allowlists, the gateway's model registry, and the global policy's community
 * default. The chart sets AGENT_DEFAULT_MODEL from `litellm.agentDefaultModel`
 * (base `deepseek-v4-flash`, dev `claude-haiku-5-5`), and the same value seeds
 * the static gateway config and cloud-codex's codex CLI, so a default always
 * names a route LiteLLM serves under its own name.
 *
 * Before F103 these defaults named other vendors' models (nemotron, gpt-5.4*,
 * openai-codex/*, codex-cli/gpt-5.4) that LiteLLM quietly served with DeepSeek.
 *
 * The fallback is for a run with no chart (docker compose, a local backend);
 * it matches base.
 */
export const AGENT_DEFAULT_MODEL_FALLBACK = 'deepseek-v4-flash';

export function agentDefaultModel(): string {
  return String(process.env.AGENT_DEFAULT_MODEL || '').trim() || AGENT_DEFAULT_MODEL_FALLBACK;
}
