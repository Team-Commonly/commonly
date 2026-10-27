import type { V2ApiClient } from '../hooks/useV2Api';

export type ByoStep = 'page-viewed' | 'seat-created' | 'mcp-command-copied' | 'cli-command-copied'
  | 'token-copied' | 'listen-confirmed' | 'listen-timeout' | 'hosted-offer-shown' | 'hosted-offer-clicked'
  | 'invite-card-shown' | 'invite-card-dismissed' | 'byo-offer-shown';

// Fixed event names only. Commands and credentials must never enter telemetry.
export const recordByoStep = (api: V2ApiClient, step: ByoStep): void => {
  void api.post('/api/stats/byo-step', { step }).catch(() => {});
};

// Surface steps fire on every mount; the server mark is write-once, so one
// ping per page load is enough.
const sentThisLoad = new Set<ByoStep>();
export const recordByoStepOnce = (api: V2ApiClient, step: ByoStep): void => {
  if (sentThisLoad.has(step)) return;
  sentThisLoad.add(step);
  recordByoStep(api, step);
};
/** Test seam: forget which steps this page load has sent. */
export const resetByoStepsForTest = (): void => { sentThisLoad.clear(); };
