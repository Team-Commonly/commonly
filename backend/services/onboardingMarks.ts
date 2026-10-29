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
 * on Mac and Linux today, so this splits "left" by whether setup could have worked at
 * all. An unknown or missing value records the visit without an OS.
 *
 * Three surface marks come from the browser through POST /api/stats/byo-step,
 * as fixed step names (D139): inviteCardShownAt and inviteCardDismissedAt for
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
 */
export function markByoCommandCopied(userId: unknown, commandType: 'mcp' | 'cli'): void {
  const id = String(userId || '');
  if (!id || !['mcp', 'cli'].includes(commandType)) return;
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

/** Record the first time a person met one of the D139 surfaces. */
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
  byoConnectionAttemptMarked.clear();
  surfaceMarked.clear();
}
