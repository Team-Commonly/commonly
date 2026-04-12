/**
 * A NativeAgentDefinition is a declarative config for a Commonly native agent.
 * The backend loads these at startup, upserts each into AgentRegistry, and
 * the native runtime executes them on events (mention, heartbeat, task, etc).
 */
export type NativeAgentTrigger =
  | 'mention'
  | 'heartbeat'
  | 'task.assigned'
  | 'chat.message'
  | 'pod.join';

export type CommonlyTool =
  | 'commonly_read_context'
  | 'commonly_read_memory'
  | 'commonly_write_memory'
  | 'commonly_post_message'
  | 'commonly_create_task';

export interface NativeAgentDefinition {
  /** Canonical agent name. Kebab-case. Used as AgentRegistry.agentName. */
  agentName: string;

  /** Human-readable display name shown in the Agent Hub. */
  displayName: string;

  /** Short description shown on the agent card. */
  description: string;

  /** System prompt fed to the LLM on every turn. */
  systemPrompt: string;

  /**
   * LiteLLM model string. Examples:
   * - 'openai-codex/gpt-5.4-mini' (recommended default)
   * - 'openai-codex/gpt-5.4-nano' (cheapest)
   * - 'gemini-2.5-flash'
   * Must be a model registered in the cluster's LiteLLM config.
   */
  model: string;

  /** Trigger events that wake the agent up. */
  triggers: NativeAgentTrigger[];

  /** Cadence in minutes (only meaningful for `heartbeat` trigger). */
  heartbeatIntervalMinutes?: number;

  /** Whitelist of CAP tools this agent can call. */
  tools: CommonlyTool[];

  /** Hub icon URL. Empty string → default Commonly bot icon. */
  iconUrl?: string;

  /** Category tag(s) for discovery. */
  categories?: string[];

  /**
   * Hard cap overrides. Use sparingly — defaults in nativeRuntimeService
   * are 10 turns / 50k tokens / 60s wall.
   */
  maxTurns?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
}
