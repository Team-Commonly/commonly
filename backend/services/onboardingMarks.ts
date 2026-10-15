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
 * pick from the message itself and trusts nothing new from the client.
 */
import User from '../models/User';
import { SCOUT_STARTS } from '../config/native-agents/scout';

const podOpenedMarked = new Set<string>();
const startPickedMarked = new Set<string>();

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
  if (startPickedMarked.has(id)) return;
  startPickedMarked.add(id);
  try {
    User.updateOne(
      { _id: id, isBot: { $ne: true }, 'onboarding.firstStartAt': { $exists: false } },
      { $set: { 'onboarding.firstStartId': start.id, 'onboarding.firstStartAt': new Date() } },
    ).catch(() => {
      startPickedMarked.delete(id);
    });
  } catch {
    // Telemetry fails open: it must never break sending a message.
    startPickedMarked.delete(id);
  }
}

/** Test seam: forget which people this process has marked. */
export function resetOnboardingMarksForTest(): void {
  podOpenedMarked.clear();
  startPickedMarked.clear();
}
