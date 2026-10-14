/** Credential failures shared by refresh, drift assessment and the broker. */
export type HostedMcpCredentialErrorCode =
  | 'connection_mismatch'
  | 'reconnect_required'
  | 'credential_missing'
  | 'refresh_unreachable'
  | 'connection_error'
  | 'credential_refreshing';

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
