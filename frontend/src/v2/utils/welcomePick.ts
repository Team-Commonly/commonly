import type { V2Start } from '../hooks/useV2PodDetail';
import { WELCOME_HOSTED_ACTION } from '../hooks/useWelcomeHostedStart';

/** Scout's "Show me what you can do", the start that asks nothing of you. */
export const ASK_START_ID = 'ask-scout';
// Scout's "Connect an agent I already use", and the Bring your own link that
// appears under it once the person has sent it.
const BYO_START_IDS = new Set(['connect-agent', 'open-byo']);

/**
 * How the person chose to get their first agent, read from what they did in
 * this thread: started a hosted agent, or asked to connect their own (or made
 * one that is still waiting to connect). null until they pick. The checklist
 * and Scout's welcome both follow it, so the two never name different first
 * steps.
 */
export type WelcomePick = 'hosted' | 'byo' | null;

export const isHostedStart = (start: V2Start): boolean => start.action === WELCOME_HOSTED_ACTION;
export const isByoStart = (start: V2Start): boolean => BYO_START_IDS.has(start.id);

/**
 * The starts in one group that get the filled key.
 * - Picked hosted: the hosted start.
 * - Picked bring-your-own: the connect start (none in a group without one,
 *   so the hosted start under the welcome stops competing).
 * - No pick: the hosted and connect starts together, as equal choices.
 * - Where no hosted start is offered: the start that asks nothing of you.
 */
export const primaryStartIds = (starts: V2Start[], pick: WelcomePick): Set<string> => {
  const hosted = starts.find(isHostedStart);
  const byo = starts.find(isByoStart);
  if (pick === 'byo') return new Set(byo ? [byo.id] : []);
  if (hosted) return new Set(pick === null && byo ? [hosted.id, byo.id] : [hosted.id]);
  const ask = starts.find((start) => start.id === ASK_START_ID);
  return new Set(ask ? [ask.id] : []);
};

/** The group with its filled keys first, otherwise in the order sent. */
export const orderStarts = (starts: V2Start[], primary: Set<string>): V2Start[] => [
  ...starts.filter((start) => primary.has(start.id)),
  ...starts.filter((start) => !primary.has(start.id)),
];
