/** Credential failures shared by refresh, drift assessment and the broker. */
export type HostedMcpCredentialErrorCode =
  | 'connection_mismatch'
  | 'reconnect_required'
  | 'credential_missing'
  | 'refresh_unreachable'
  | 'connection_error'
  | 'credential_refreshing'
  // The instance's own OAuth client config is missing (F688): an admin fix,
  // not the connection owner's, so it is a failure and never a reconnect.
  | 'client_unavailable';

export class HostedMcpCredentialError extends Error {
  readonly code: HostedMcpCredentialErrorCode;

  /** Retryable means the next call may work without changing the Connection. */
  readonly retryable: boolean;

  constructor(code: HostedMcpCredentialErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'HostedMcpCredentialError';
    this.code = code;
    this.retryable = retryable;
  }
}
