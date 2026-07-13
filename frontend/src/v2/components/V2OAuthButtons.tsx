import React, { useEffect, useState } from 'react';
import axios from '../../utils/axiosConfig';
import getApiBaseUrl from '../../utils/apiBaseUrl';

// Social sign-in buttons shared by V2Login and V2Register. Renders nothing
// until /api/auth/oauth/providers confirms a provider is configured, so
// self-hosted instances without OAuth credentials see no dead buttons.
// The buttons are full-page navigations (not XHR) — the OAuth dance is a
// server-side redirect chain that ends back on /v2/oauth/complete.

interface OAuthProvider {
  id: string;
  label: string;
}

interface V2OAuthButtonsProps {
  // Invite code to carry through the redirect chain so OAuth signups can
  // satisfy the invite-only gate (register page passes it; login omits it).
  invite?: string;
  // App-relative path to land on after the session is established.
  next?: string;
}

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  github: (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ),
  google: (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  ),
};

// Last-known-good cache. The providers list is effectively static config
// (which OAuth apps the instance has), so a stale value is safe and far better
// than a blank login: a single failed /providers fetch used to set [] and
// hide the buttons with no retry, so any transient (a deploy blip, a spot
// reclaim, the user's own wifi) blanked SSO until a manual reload.
const OAUTH_CACHE_KEY = 'v2:oauth-providers';
const readProviderCache = (): OAuthProvider[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(OAUTH_CACHE_KEY) || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const V2OAuthButtons: React.FC<V2OAuthButtonsProps> = ({ invite, next }) => {
  // Seed from cache so repeat visitors see the buttons instantly; the fetch
  // below reconciles. A *successful* empty response (self-hosted w/o OAuth)
  // correctly clears; only network failures fall back to the cached value.
  const [providers, setProviders] = useState<OAuthProvider[]>(readProviderCache);

  useEffect(() => {
    let active = true;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (!active) return;
      axios.get('/api/auth/oauth/providers')
        .then((res) => {
          if (!active) return;
          const list = Array.isArray(res.data?.providers) ? res.data.providers : [];
          setProviders(list);
          try { localStorage.setItem(OAUTH_CACHE_KEY, JSON.stringify(list)); } catch { /* private mode */ }
        })
        .catch(() => {
          // Transient failure: keep last-known-good (already in state), retry a
          // few times with backoff. Never blank the buttons on a network blip.
          if (active && attempt < 3) { attempt += 1; retryTimer = setTimeout(load, 800 * attempt); }
        });
    };
    load();
    return () => { active = false; if (retryTimer) clearTimeout(retryTimer); };
  }, []);

  if (!providers.length) return null;

  const startUrl = (id: string) => {
    const params = new URLSearchParams();
    if (next) params.set('next', next);
    if (invite) params.set('invite', invite);
    const qs = params.toString();
    return `${getApiBaseUrl()}/api/auth/oauth/${id}/start${qs ? `?${qs}` : ''}`;
  };

  return (
    <>
      <div className="v2-login__or"><span>or</span></div>
      <div className="v2-login__oauth">
        {providers.map((p) => (
          <a key={p.id} className="v2-login__oauth-btn" href={startUrl(p.id)}>
            {PROVIDER_ICONS[p.id]}
            Continue with {p.label}
          </a>
        ))}
      </div>
    </>
  );
};

export default V2OAuthButtons;
