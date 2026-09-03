import type { Api } from './api';
import type { Session } from './session';

/** The user shape the app relies on. Anything else the backend sends is passed through untyped. */
export interface User {
  _id: string;
  username: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  role?: string;
  verified?: boolean;
  [key: string]: unknown;
}

export interface LoginResult {
  token: string;
  user: User;
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  invitationToken?: string;
}

export interface OAuthProvider {
  id: string;
  name: string;
  enabled?: boolean;
}

/**
 * Auth, ported flow by flow from the old shell against the SAME endpoints
 * (`/api/auth/*`). Each function returns what the backend returns and stores
 * the token in the Session when one is issued. Nothing here renders.
 */
export class Auth {
  constructor(private readonly api: Api, private readonly session: Session) {}

  /** POST /api/auth/login — email + password. Stores the token on success. */
  async login(email: string, password: string): Promise<LoginResult> {
    const res = await this.api.post<{ token: string; user?: User } & Record<string, unknown>>(
      '/api/auth/login', { email, password }, { anonymous: true },
    );
    await this.session.setToken(res.token);
    const user = res.user ?? await this.me();
    return { token: res.token, user };
  }

  /**
   * POST /api/auth/register. The backend answers with a message and, when
   * email delivery is not configured, an auto-verified account; it does NOT
   * issue a token, so a successful registration is followed by login().
   */
  async register(input: RegisterInput): Promise<{ message: string; verificationRequired: boolean }> {
    const res = await this.api.post<{ message?: string; verified?: boolean } & Record<string, unknown>>(
      '/api/auth/register', input, { anonymous: true },
    );
    const message = String(res.message || 'Registered');
    return { message, verificationRequired: /check your email/i.test(message) };
  }

  /** GET /api/auth/user — the signed-in user, or throws ApiError(401). */
  me(): Promise<User> {
    return this.api.get<User>('/api/auth/user');
  }

  async signOut(): Promise<void> {
    await this.session.setToken(null);
  }

  /** GET /api/auth/oauth/providers — which OAuth buttons to show. */
  async oauthProviders(): Promise<OAuthProvider[]> {
    const res = await this.api.get<{ providers?: OAuthProvider[] } | OAuthProvider[]>('/api/auth/oauth/providers', { anonymous: true });
    return Array.isArray(res) ? res : (res.providers ?? []);
  }

  /** The URL a browser navigates to in order to start an OAuth sign-in. */
  oauthStartUrl(provider: string, redirectTo?: string): string {
    const q = redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : '';
    return `${this.session.baseUrl}/api/auth/oauth/${encodeURIComponent(provider)}/start${q}`;
  }

  /** POST /api/auth/oauth/exchange — turn the one-time code from the callback into a session. */
  async oauthExchange(code: string): Promise<LoginResult> {
    const res = await this.api.post<{ token: string; user?: User }>('/api/auth/oauth/exchange', { code }, { anonymous: true });
    await this.session.setToken(res.token);
    const user = res.user ?? await this.me();
    return { token: res.token, user };
  }

  forgotPassword(email: string): Promise<{ message?: string }> {
    return this.api.post('/api/auth/forgot-password', { email }, { anonymous: true });
  }

  resetPassword(token: string, password: string): Promise<{ message?: string }> {
    return this.api.post('/api/auth/reset-password', { token, password }, { anonymous: true });
  }

  resendVerification(email: string): Promise<{ message?: string }> {
    return this.api.post('/api/auth/resend-verification', { email }, { anonymous: true });
  }
}
