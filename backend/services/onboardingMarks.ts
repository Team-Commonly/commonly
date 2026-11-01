/**
 * First-session milestones for people, so "signed up and never typed" can be
 * split by where they stopped.
 *
 * Each mark is a write-once timestamp on User.onboarding. It is set the first
 * time it happens, never overwritten, and never set for bots. The database
 * filter enforces write-once; the in-process set only saves a query per
 * request, the same way touchLastActive throttles lastActive. A restart costs
 * at most one extra no-op update per person.
 *
 * Phase 0 records one mark: podOpenedAt, the first time a person loads the
 * messages of a pod they created (their My Workspace is one). Measuring
 * starts at deploy; nothing is backfilled.
 *
 * The first-session starts add a second: firstStartId and firstStartAt, the
 * first time a person posts one of Scout's starts in a pod they created. A
 * click on a start sends its label as their message, so the server reads the
 * pick from the message itself and trusts nothing new from the client. The
 * welcome's "Run an agent here" sends no message: it records firstStartId
 * 'run-hosted' when the server resolves a click on the person's own welcome
 * (POST /api/hosted/welcome-start, TASK-290), so a person who started there,
 * and so never opened Bring your own, still shows which start they picked.
 *
 * byoOpenedAt is the first time a person opens the Bring your own agent page,
 * read from the page's own load request (GET /api/hosted/availability, which
 * nothing else calls). It tells "never looked at setup" apart from "looked and
 * left".
 *
 * byoOpenedOs is written with it, in the same write-once update: the OS the
 * page detected from the browser, one of BYO_OPENED_OS. The listener runs only
 * on Mac (listenerRunsOn in V2AgentBYO.tsx is os === 'mac'), so this splits
 * "left" by whether the listener path could have worked. An unknown or
 * missing value records the visit without an OS.
 *
 * Three surface marks come from the browser through POST /api/stats/byo-step,
 * as fixed step names: inviteCardShownAt and inviteCardDismissedAt for
 * the "invite a teammate" card, and byoOfferShownAt the first time the thread
 * shows a start that links to Bring your own. "Shown" is the card or start
 * mounting in the transcript, not proof it was scrolled into view.
 */
import User from '../models/User';
import { SCOUT_STARTS } from '../config/native-agents/scout';

const podOpenedMarked = new Set<string>();
const startPickedMarked = new Set<string>();
const byoOpenedMarked = new Set<string>();
const byoCommandCopiedMarked = new Set<string>();
const byoCommandKindMarked = new Set<string>();
const byoConnectionAttemptMarked = new Set<string>();
const surfaceMarked = new Map<SurfaceMark, Set<string>>();

export type SurfaceMark = 'inviteCardShownAt' | 'inviteCardDismissedAt' | 'byoOfferShownAt';
export const SURFACE_MARKS: readonly SurfaceMark[] = ['inviteCardShownAt', 'inviteCardDismissedAt', 'byoOfferShownAt'];

export function markPodOpened(userId: unknown, pod: { createdBy?: unknown } | null | undefined): void {
  const id = String(userId || '');
  if (!id || !pod || String(pod.createdBy || '') !== id) return;
  if (podOpenedMarked.has(id)) return;
  podOpenedMarked.add(id);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.podOpenedAt': { $exists: false } },
      { $set: { 'onboarding.podOpenedAt': new Date() } },
    ).catch(() => {
      podOpenedMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: it must never break a message read.
    podOpenedMarked.delete(id);
  }
}

export function markStartPicked(
  userId: unknown,
  pod: { createdBy?: unknown } | null | undefined,
  content: unknown,
): void {
  const id = String(userId || '');
  if (!id || !pod || String(pod.createdBy || '') !== id) return;
  const text = typeof content === 'string' ? content.trim() : '';
  const start = SCOUT_STARTS.find(({ label }) => label === text);
  if (!start) return;
  recordFirstStart(id, start.id);
}

/**
 * The welcome's hosted start, once the server has checked the click came from
 * the person's own welcome (services/welcomeHostedStart.ts).
 */
export function markWelcomeHostedStart(userId: unknown): void {
  const id = String(userId || '');
  if (!id) return;
  recordFirstStart(id, 'run-hosted');
}

function recordFirstStart(id: string, startId: string): void {
  if (startPickedMarked.has(id)) return;
  startPickedMarked.add(id);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.firstStartAt': { $exists: false } },
      { $set: { 'onboarding.firstStartId': startId, 'onboarding.firstStartAt': new Date() } },
    ).catch(() => {
      startPickedMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: it must never break the request that triggers it.
    startPickedMarked.delete(id);
  }
}

export const BYO_OPENED_OS = ['mac', 'linux', 'windows', 'other'] as const;
export type ByoOpenedOs = typeof BYO_OPENED_OS[number];

export const parseByoOpenedOs = (value: unknown): ByoOpenedOs | undefined => (
  typeof value === 'string' && (BYO_OPENED_OS as readonly string[]).includes(value)
    ? value as ByoOpenedOs
    : undefined
);

export function markByoOpened(userId: unknown, os?: unknown): void {
  const id = String(userId || '');
  if (!id) return;
  if (byoOpenedMarked.has(id)) return;
  byoOpenedMarked.add(id);
  const detectedOs = parseByoOpenedOs(os);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.byoOpenedAt': { $exists: false } },
      {
        $set: {
          'onboarding.byoOpenedAt': new Date(),
          ...(detectedOs ? { 'onboarding.byoOpenedOs': detectedOs } : {}),
        },
      },
    ).catch(() => {
      byoOpenedMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: it must never break the page's availability read.
    byoOpenedMarked.delete(id);
  }
}

/**
 * Record that a person copied one of the BYO setup commands.
 *
 * Only the fixed command kind is kept. The command itself contains a runtime
 * token, so it must never cross this boundary or be written to telemetry.
 *
 * Two shapes are written. `byoCommandCopiedAt` / `byoCommandType` keep the
 * FIRST copy of either kind, as before. `byoMcpCopiedAt` / `byoCliCopiedAt`
 * keep the first copy of EACH kind, so "copied the MCP snippet and never the
 * listener command" (TASK-721) is distinguishable from "MCP first, listener
 * second", which the first-copy pair cannot tell apart.
 */
export function markByoCommandCopied(userId: unknown, commandType: 'mcp' | 'cli'): void {
  const id = String(userId || '');
  if (!id || !['mcp', 'cli'].includes(commandType)) return;
  const kindField = commandType === 'mcp' ? 'onboarding.byoMcpCopiedAt' : 'onboarding.byoCliCopiedAt';
  if (!byoCommandKindMarked.has(`${id}:${commandType}`)) {
    byoCommandKindMarked.add(`${id}:${commandType}`);
    try {
      User.updateOne(
        { _id: id, isBot: { $ne: true }, [kindField]: { $exists: false } },
        { $set: { [kindField]: new Date() } },
      ).catch(() => {
        byoCommandKindMarked.delete(`${id}:${commandType}`);
      });
    } catch {
      // Telemetry fails open: it must never break the copy flow.
      byoCommandKindMarked.delete(`${id}:${commandType}`);
    }
  }
  if (byoCommandCopiedMarked.has(id)) return;
  byoCommandCopiedMarked.add(id);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.byoCommandCopiedAt': { $exists: false } },
      {
        $set: {
          'onboarding.byoCommandCopiedAt': new Date(),
          'onboarding.byoCommandType': commandType,
        },
      },
    ).catch(() => {
      byoCommandCopiedMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: it must never break the copy flow.
    byoCommandCopiedMarked.delete(id);
  }
}

/**
 * The first copy of each setup command, by its own type (TASK-714).
 *
 * `listen` is the listener command; `mcp-claude` and `mcp-cursor` are the two
 * MCP snippets; `daemon` and `token` are the daemon and token copies. Each
 * gets its own write-once field, so a later listen copy after an MCP copy
 * leaves a trace. The existing first-copy marks above are unchanged.
 */
export const BYO_COPY_TYPES = ['listen', 'mcp-claude', 'mcp-cursor', 'daemon', 'token'] as const;
export type ByoCopyType = typeof BYO_COPY_TYPES[number];
const BYO_COPY_FIELD: Record<ByoCopyType, string> = {
  listen: 'onboarding.byoListenCopiedAt',
  'mcp-claude': 'onboarding.byoMcpClaudeCopiedAt',
  'mcp-cursor': 'onboarding.byoMcpCursorCopiedAt',
  daemon: 'onboarding.byoDaemonCopiedAt',
  token: 'onboarding.byoTokenCopiedAt',
};
const byoCopyTypeMarked = new Set<string>();

export function markByoCopyType(userId: unknown, copyType: unknown): void {
  const id = String(userId || '');
  if (!id || !(BYO_COPY_TYPES as readonly unknown[]).includes(copyType)) return;
  const type = copyType as ByoCopyType;
  const key = `${id}:${type}`;
  if (byoCopyTypeMarked.has(key)) return;
  byoCopyTypeMarked.add(key);
  const field = BYO_COPY_FIELD[type];
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, [field]: { $exists: false } },
      { $set: { [field]: new Date() } },
    ).catch(() => {
      byoCopyTypeMarked.delete(key);
    });
  } catch {
    // Telemetry fails open: it must never break the copy flow.
    byoCopyTypeMarked.delete(key);
  }
}

/**
 * The OS the result page set up for and whether its listener could run there,
 * written once per person (TASK-714). Booleans and the fixed OS enum only: no
 * command, token, or pod is stored. A missing or malformed value writes nothing.
 */
const byoSetupMarked = new Set<string>();

type ByoSetupInput = { setupOs?: unknown; listenerAvailable?: unknown } | null | undefined;
export function markByoSetup(userId: unknown, setup: ByoSetupInput): void {
  const id = String(userId || '');
  const setupOs = parseByoOpenedOs(setup?.setupOs);
  const listenerEligible = setup?.listenerAvailable;
  if (!id || !setupOs || typeof listenerEligible !== 'boolean' || byoSetupMarked.has(id)) return;
  byoSetupMarked.add(id);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.byoListenerEligible': { $exists: false } },
      { $set: { 'onboarding.byoSetupOs': setupOs, 'onboarding.byoListenerEligible': listenerEligible } },
    ).catch(() => {
      byoSetupMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: it must never break the copy flow.
    byoSetupMarked.delete(id);
  }
}

/**
 * Record the first authenticated request from a BYO/local runtime.
 *
 * The caller supplies the installation so hosted/native seats do not look
 * like BYO activation. The installer is the human signup whose funnel this
 * mark describes; the agent User row is deliberately not used here.
 */
export function markByoConnectionAttempt(
  userId: unknown,
  installation?: { config?: unknown },
): void {
  const config = installation?.config;
  const runtime = config && typeof config === 'object' && 'get' in config
    && typeof (config as { get?: unknown }).get === 'function'
    ? (config as { get: (key: string) => unknown }).get('runtime') as {
      runtimeType?: string;
      host?: string;
      webhookUrl?: string;
    } || {}
    : (config as { runtime?: { runtimeType?: string; host?: string; webhookUrl?: string } } | undefined)?.runtime || {};
  const runtimeType = String(runtime.runtimeType || '').trim().toLowerCase();
  const isByo = runtime.host === 'byo'
    || runtimeType === 'wrapper'
    || runtimeType === 'local-cli'
    || (runtimeType === 'webhook' && !runtime.host && !runtime.webhookUrl);
  const id = String(userId || '');
  if (!id || !isByo || byoConnectionAttemptMarked.has(id)) return;
  byoConnectionAttemptMarked.add(id);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.byoFirstConnectionAttemptAt': { $exists: false } },
      { $set: { 'onboarding.byoFirstConnectionAttemptAt': new Date() } },
    ).catch(() => {
      byoConnectionAttemptMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: auth must not fail because the mark cannot write.
    byoConnectionAttemptMarked.delete(id);
  }
}

/**
 * The first `commonly daemon register` for a person (TASK-661). Written from
 * the machine route, after registration succeeds, so a failed register writes
 * nothing. The byo_telemetry row is keyed per person by the caller, so the
 * row and this mark each land once however many machines are registered.
 */
const daemonRegisteredMarked = new Set<string>();

export function markByoDaemonRegistered(userId: unknown): void {
  const id = String(userId || '');
  if (!id || daemonRegisteredMarked.has(id)) return;
  daemonRegisteredMarked.add(id);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.byoDaemonRegisteredAt': { $exists: false } },
      { $set: { 'onboarding.byoDaemonRegisteredAt': new Date() } },
    ).catch(() => {
      daemonRegisteredMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: a registration must never fail on its mark.
    daemonRegisteredMarked.delete(id);
  }
}

/** Record the first time a person met one of the onboarding surfaces. */
export function markSurface(userId: unknown, mark: SurfaceMark): void {
  const id = String(userId || '');
  if (!id || !SURFACE_MARKS.includes(mark)) return;
  const marked = surfaceMarked.get(mark) || new Set<string>();
  surfaceMarked.set(mark, marked);
  if (marked.has(id)) return;
  marked.add(id);
  const field = `onboarding.${mark}`;
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, [field]: { $exists: false } },
      { $set: { [field]: new Date() } },
    ).catch(() => {
      marked.delete(id);
    });
  } catch {
    // Telemetry fails open: it must never break the ping that carries it.
    marked.delete(id);
  }
}

/** Test seam: forget which people this process has marked. */
export function resetOnboardingMarksForTest(): void {
  podOpenedMarked.clear();
  startPickedMarked.clear();
  byoOpenedMarked.clear();
  byoCommandCopiedMarked.clear();
  byoCommandKindMarked.clear();
  byoCopyTypeMarked.clear();
  byoSetupMarked.clear();
  byoConnectionAttemptMarked.clear();
  daemonRegisteredMarked.clear();
  surfaceMarked.clear();
}
