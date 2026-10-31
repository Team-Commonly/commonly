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

it('reads an hour-plus gap in hours, and a day-plus gap in days', () => {
  const now = Date.parse('2026-10-30T16:00:00Z');
  // 6390 minutes is 106 hours: four days, the case that read "6390 min" on the page.
  expect(connectionLabel({ state: 'stale', lastSeenAt: new Date(now - 6390 * 60000).toISOString() }, (k, o) => `${k}:${o?.count}`, now))
    .toBe('agentConnection.staleDays:4');
  expect(connectionLabel({ state: 'stale', lastSeenAt: new Date(now - 90 * 60000).toISOString() }, (k, o) => `${k}:${o?.count}`, now))
    .toBe('agentConnection.staleHours:1');
  expect(connectionLabel({ state: 'stale', lastSeenAt: new Date(now - 59 * 60000).toISOString() }, (k, o) => `${k}:${o?.count}`, now))
    .toBe('agentConnection.stale:59');
});
