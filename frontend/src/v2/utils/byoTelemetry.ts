import type { V2ApiClient } from '../hooks/useV2Api';

export type ByoStep = 'page-viewed' | 'seat-created' | 'mcp-command-copied' | 'cli-command-copied'
  | 'daemon-command-copied' | 'token-copied' | 'listen-confirmed' | 'listen-timeout'
  | 'hosted-offer-shown' | 'hosted-offer-clicked'
  | 'invite-card-shown' | 'invite-card-dismissed' | 'byo-offer-shown';

// Fixed event names only. Commands and credentials must never enter telemetry.
export const recordByoStep = (api: V2ApiClient, step: ByoStep): void => {
  void api.post('/api/stats/byo-step', { step }).catch(() => {});
};

// Surface steps fire on every mount; the server mark is write-once, so one
// ping per signed-in person per page load is enough. A step stays suppressed
// while its request is in flight and is forgotten if the request fails, so a
// later mount can retry.
const sentThisLoad = new Set<string>();
export const recordByoStepOnce = (api: V2ApiClient, step: ByoStep, viewerId: string): void => {
  const key = `${viewerId}:${step}`;
  if (sentThisLoad.has(key)) return;
  sentThisLoad.add(key);
  void api.post('/api/stats/byo-step', { step }).catch(() => { sentThisLoad.delete(key); });
};
/** Test seam: forget which steps this page load has sent. */
export const resetByoStepsForTest = (): void => { sentThisLoad.clear(); };
