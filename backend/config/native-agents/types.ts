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
  | 'commonly_create_task'
  | 'commonly_propose_action'
  | 'commonly_agent_status';

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
  // Phase 2 "it speaks first": the scripted opener a hire posts on
  // placement — deterministic and free, so the room is never empty and never
  // depends on a model call at first-impression time (Scout's pattern,
  // generalized). Absent = a neutral default intro.
  introMessage?: string;
  // Per-user apps (the Guide) publish a registry row but are NOT installed
  // into the demo pod by the seeder — installation happens per workspace at
  // signup (authController.createDefaultWorkspacePod).
  perUser?: boolean;
  // Hard ceiling on runs per installation per day, enforced by
  // nativeRuntimeService before any model call. Absent = uncapped.
  dailyRunCap?: number;
  // ADR-018 D8: opt the installation into wake-on-message at install time.
  wakeOnMessage?: boolean;
}
