import { connectionLabel } from '../utils/agentConnection';

const labels: Record<string, string> = {
  'agentConnection.revoked': 'Disconnected: key revoked',
  'agentConnection.connected': 'Connected',
  'agentConnection.available': 'Ready on Commonly',
  'agentConnection.never': 'Not connected yet',
};
const t = (key: string, options?: Record<string, unknown>) => labels[key] || `Not seen in ${options?.count} min`;

it('shows the revoked key reason', () => {
  expect(connectionLabel({ state: 'revoked', lastSeenAt: null }, t)).toBe('Disconnected: key revoked');
});

it('shows hosted native availability without a fabricated last-seen time', () => {
  expect(connectionLabel({ state: 'available', lastSeenAt: null }, t)).toBe('Ready on Commonly');
});

it('shows elapsed minutes from the last poll', () => {
  expect(connectionLabel({ state: 'stale', lastSeenAt: '2026-10-23T15:54:00Z' }, t,
    Date.parse('2026-10-23T16:00:00Z'))).toBe('Not seen in 6 min');
});
