import type { TFunction } from 'i18next';

type AuthErrorPage = 'login' | 'register' | 'forgot' | 'reset';

interface AuthErrorBody {
  code?: string;
  reason?: string;
  scope?: string;
  retryAfterSeconds?: number;
  error?: string;
}

interface AuthErrorLike {
  response?: { status?: number; data?: unknown };
}

const FALLBACK: Record<AuthErrorPage, string> = {
  login: 'auth.login.errors.failed',
  register: 'auth.register.errors.failed',
  forgot: 'auth.forgot.errors.failed',
  reset: 'auth.reset.errors.failed',
};

/**
 * The one line a sign-in, sign-up, forgot-password or reset page shows when
 * its request fails. Every line is the page's own translated text, chosen from
 * the response's status and code. The server's `error` and `message` strings
 * are English and meant for logs and API callers, so they never reach the
 * page. A rate limit says what was counted and when to try again.
 */
export const authErrorText = (err: unknown, t: TFunction, page: AuthErrorPage): string => {
  const response = (err as AuthErrorLike | null)?.response;
  if (!response) return t('auth.errors.network');
  const status = response.status ?? 0;
  const body: AuthErrorBody = response.data && typeof response.data === 'object' ? response.data as AuthErrorBody : {};
  const { code } = body;

  if (status === 429 || code === 'rate_limited') {
    const account = body.scope === 'account';
    const seconds = Number(body.retryAfterSeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      return t(account ? 'auth.errors.rateLimitedAccountIn' : 'auth.errors.rateLimitedIn', { count: Math.ceil(seconds / 60) });
    }
    return t(account ? 'auth.errors.rateLimitedAccount' : 'auth.errors.rateLimited');
  }
  if (code === 'INSTANCE_ACCESS_RESTRICTED') {
    return body.reason === 'unverified' ? t('auth.login.errors.verifyFirst') : t('auth.login.oauthErrors.teamOnly');
  }
  if (page === 'register') {
    if (code === 'INVITATION_INVALID') return t('auth.register.errors.invitationInvalid');
    if (code === 'INVITATION_REQUIRED') return t('auth.register.errors.invitationRequired');
    if (code === 'INVITATION_CONFIG_MISSING') return t('auth.register.errors.signupsClosed');
    if (code === 'INSTANCE_VERIFICATION_UNAVAILABLE') return t('auth.register.errors.verificationUnavailable');
    if (code === 'agent_email_reserved' || code === 'agent_username_reserved') return t('auth.register.errors.emailReserved');
    // The server names this case only in prose; the page has matched it the same way.
    if (status === 400 && /^user already exists$/i.test(String(body.error || ''))) return t('auth.register.errors.emailTaken');
  }
  if (status >= 500) return t('auth.errors.server');
  if (page === 'login') {
    if (status === 400) return t('auth.login.errors.invalid');
    // Only the server's own refusal says suspended: an edge proxy's 403 (a
    // challenge page) carries no code and must not tell someone they're banned.
    // The prose match covers a backend from before the code.
    if (code === 'ACCOUNT_SUSPENDED' || body.error === 'This account has been suspended.') {
      return t('auth.login.errors.suspended');
    }
  }
  return t(FALLBACK[page]);
};
