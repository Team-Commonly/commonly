import type { TFunction } from 'i18next';

// Only reviewed, fixed copy reaches the UI. Callback URLs and start errors
// carry codes, never text from the provider.
const noticeKeyByCode: Record<string, string> = {
  unknown_entry: 'hostedMcpUnknownEntry',
  invalid_state: 'hostedMcpInvalidState',
  state_expired: 'hostedMcpInvalidState',
  state_consumed: 'hostedMcpInvalidState',
  browser_mismatch: 'hostedMcpInvalidState',
  issuer_mismatch: 'hostedMcpInvalidState',
  consent_denied: 'hostedMcpConsentDenied',
  vendor_error: 'hostedMcpVendorError',
  rate_limited: 'hostedMcpRateLimited',
  issuer_unreachable: 'hostedMcpIssuerUnavailable',
  issuer_metadata_incomplete: 'hostedMcpIssuerUnavailable',
  client_not_configured: 'hostedMcpClientSetup',
  client_registration_required: 'hostedMcpClientSetup',
  // The vendor offers no registration this instance supports, or refused the
  // one it asked for (TASK-248 named both before the first DCR entry ships).
  client_registration_unsupported: 'hostedMcpClientSetup',
  client_registration_refused: 'hostedMcpClientSetup',
  client_auth_unsupported: 'hostedMcpClientSetup',
  client_auth_refused: 'hostedMcpClientSetup',
  authorization_parameter_conflict: 'hostedMcpClientSetup',
  exchange_refused: 'hostedMcpExchangeRefused',
  exchange_unreachable: 'hostedMcpExchangeUnreachable',
  exchange_incomplete: 'hostedMcpExchangeIncomplete',
  exchange_invalid_scope: 'hostedMcpExchangeIncomplete',
  unrequested_scope: 'hostedMcpUnrequestedScope',
  authentication_required: 'hostedMcpAuthenticationRequired',
};

export const hostedMcpErrorNotice = (t: TFunction, code: string | null | undefined): string => (
  t(`connectors.${noticeKeyByCode[code || ''] || 'hostedMcpUnknownError'}`)
);
