import type { V2ApiClient } from '../hooks/useV2Api';

export type ByoStep = 'page-viewed' | 'seat-created' | 'mcp-command-copied' | 'cli-command-copied'
  | 'token-copied' | 'listen-confirmed' | 'listen-timeout' | 'hosted-offer-shown' | 'hosted-offer-clicked';

// Fixed event names only. Commands and credentials must never enter telemetry.
export const recordByoStep = (api: V2ApiClient, step: ByoStep): void => {
  void api.post('/api/stats/byo-step', { step }).catch(() => {});
};
