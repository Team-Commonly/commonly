/**
 * Backend-local mirror of the NativeAgentDefinition contract.
 *
 * The source of truth lives in packages/commonly-apps/src/types.ts. This
 * file is duplicated here because backend/tsconfig.typescheck.json scopes
 * includes to backend/** — cross-package imports don't typecheck. Round 2
 * can consolidate via project references or a path alias; for Round 1 the
 * shapes are kept byte-identical so substitution is trivial.
 *
 * DO NOT drift from packages/commonly-apps/src/types.ts without updating
 * both files.
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
  agentName: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  model: string;
  triggers: NativeAgentTrigger[];
  heartbeatIntervalMinutes?: number;
  tools: CommonlyTool[];
  iconUrl?: string;
  categories?: string[];
  maxTurns?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
}
