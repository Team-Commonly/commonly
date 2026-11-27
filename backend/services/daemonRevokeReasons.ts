// F641: why an operator revoked a computer's daemon key, and what the person
// is told about it. One map, so the model's enum, the daemon's 401 and the
// app's code all agree. The text names no person, machine, id or internal
// label: it reaches whoever runs that daemon.
export const DAEMON_REVOKED_REASONS = ['cli_duplicate_daemons'] as const;

export type DaemonRevokedReason = typeof DAEMON_REVOKED_REASONS[number];

const REASON_TEXT: Record<DaemonRevokedReason, string> = {
  cli_duplicate_daemons: 'This computer was disconnected because of a bug in our CLI. '
    + 'Run the computer setup command again from Bring your own agent to get the fixed version.',
};

export const isDaemonRevokedReason = (value: unknown): value is DaemonRevokedReason => (
  typeof value === 'string' && (DAEMON_REVOKED_REASONS as readonly string[]).includes(value)
);

// The person-facing text for a stored reason, or null for none or an unknown one.
export const daemonRevokedReasonText = (value: unknown): string | null => (
  isDaemonRevokedReason(value) ? REASON_TEXT[value] : null
);
