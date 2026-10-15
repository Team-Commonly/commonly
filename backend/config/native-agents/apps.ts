import type { NativeAgentDefinition } from './types';
import { podWelcomerApp } from './pod-welcomer';
import { taskClerkApp } from './task-clerk';
import { podSummarizerApp } from './pod-summarizer';
import { scoutApp } from './scout';
import { recorderApp } from './recorder';

export type { NativeAgentDefinition, NativeAgentTrigger, CommonlyTool } from './types';

/**
 * First-party native agent registry — loaded at backend startup by
 * `scripts/seed-native-agents.ts`, upserted into AgentRegistry, and
 * executed in-process by `services/nativeRuntimeService.ts`.
 *
 * Canonical source is here in backend/config/native-agents/ for the MVP.
 * The parallel `packages/commonly-apps/` package holds the same definitions
 * as "future state" — when we set up a proper monorepo build that bundles
 * cross-package code into the backend Docker context, the source of truth
 * moves to packages/ and this file becomes a thin re-export. For now,
 * editing either location is fine as long as they stay in sync.
 *
 * To add a new app: create a new file in this directory exporting a
 * NativeAgentDefinition, then import + add to FIRST_PARTY_APPS below.
 */
export const FIRST_PARTY_APPS: NativeAgentDefinition[] = [
  podWelcomerApp,
  taskClerkApp,
  podSummarizerApp,
  scoutApp,
  // Phase 1 persona (roster 2026-08-21). Seeds unverified — the catalog gate
  // keeps it unhireable until Phase 2's where-step opens hosted seats.
  recorderApp,
  // Planner is admitted to the roster but has NO manifest yet, on purpose:
  // its residency rides board wakes, and taskEventService.notifyPodAgents
  // currently gates those on wakeOnMessageEnabled — which would also wake it
  // on every chat line in a shared pod, exactly what D6 bans. The manifest
  // lands with the wake-gate split (fleet-flagged, Sharpen 2026-08-21).
];

/**
 * The agents signup installs into every new workspace in the person's name
 * (`perUser: true`; today only Scout, via authController's onboarding tail).
 * The person did not set these up, so `/api/users/me/agent-connection` never
 * counts them as "an agent you attached". Counting Scout hid the first-run
 * card from every signup. authController.guideIdentity.test.js holds every
 * install signup writes to this set: an app installed at signup that is not
 * perUser would hide the card again, and that test turns red first.
 */
export const SIGNUP_INSTALLED_AGENT_NAMES: ReadonlySet<string> = new Set(
  FIRST_PARTY_APPS.filter((app) => app.perUser).map((app) => app.agentName.toLowerCase()),
);
