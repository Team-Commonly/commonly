/**
 * Backend-local mirror of the NativeAgentDefinition contract.
 *
 * This file is duplicated from packages/commonly-apps/src/types.ts because
 * backend/tsconfig.typescheck.json scopes includes to backend/** — cross-package
 * imports don't typecheck. Round 2 can consolidate via project references or a
 * path alias.
 *
 * The previous version of this comment named packages/commonly-apps as "the
 * source of truth", said the shapes were "kept byte-identical so substitution is
 * trivial", and instructed readers not to drift from it. All three were false at
 * the time of this change, and had been for a while:
 *
 *   - The shapes had ALREADY drifted. That file's `CommonlyTool` lists six
 *     names; this one listed seven. The missing one is `commonly_agent_status`,
 *     which scout declares, so substituting the "source of truth" would have
 *     failed to type a shipped agent.
 *   - Nothing imports the package. There are no non-comment imports of
 *     commonly-apps anywhere in the repo, and it is not a workspace member, so
 *     no compiler and no test has ever read it.
 *   - A "DO NOT drift" instruction was therefore the only guard on that pairing,
 *     which is to say there was none — it is addressed to a human who must
 *     already know the other file exists.
 *
 * `CommonlyTool` below is now DERIVED from the runtime's own declarations
 * rather than restated, so it cannot drift from the surface it describes.
 * The remaining shapes here are still hand-mirrored; treat packages/commonly-apps
 * as historical until someone deletes it or wires it up.
 */
export type NativeAgentTrigger =
  | 'mention'
  | 'heartbeat'
  | 'task.assigned'
  | 'chat.message'
  | 'pod.join';

/**
 * DERIVED from the runtime's own tool declarations — never hand-maintained.
 *
 * This was a written-out union of the same seven names as `TOOLS` in
 * services/nativeRuntimeService.ts, with no derivation between them. Two silent
 * drift modes: add to TOOLS and forget the union, and no definition can declare
 * the new tool, so `toolsForConfig` filters it out of every install (the tool
 * exists and is unreachable); rename in TOOLS and not the union, and definitions
 * still typecheck while `declared.includes(...)` drops the tool with nothing red
 * (the agent silently loses a capability).
 *
 * Deriving retires the second copy: a rename in TOOLS now fails the build at
 * every definition that declares the old name.
 */
export type CommonlyTool =
  (typeof import('../../services/nativeRuntimeService').TOOLS)[number]['function']['name'];

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
