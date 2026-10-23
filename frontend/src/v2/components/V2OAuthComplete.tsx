import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import V2AuthBrand from './V2AuthBrand';
import { safeNextPath } from '../utils/safeNextPath';
import {
  forgetInvite, forgetInviteOAuthStart, hasInviteOAuthStart,
} from '../utils/pendingInvite';
import { useTranslation } from 'react-i18next';

// Landing pad for the OAuth redirect chain. The backend callback hands us a
// short-lived one-time code (never the JWT itself — it would end up in
// browser history and server logs); we swap it for a session here, hand it to
// AuthContext, and, for a /v2 destination, navigate in-app the way email
// sign-in does. A full-page navigation here used to re-download and re-boot
// the whole app on the path most new people take (OAuth is 93% of outside
// signups).
const V2OAuthComplete: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signInWithToken } = useAuth();
  // The code is single-use: this guard keeps it to one exchange however often
  // the effect runs (StrictMode's double mount, or signInWithToken's identity
  // changing once the token lands).
  const fired = useRef(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const code = searchParams.get('code') || '';
    const next = safeNextPath(searchParams.get('next')) || '/v2';
    // The backend marks only a newly-created invited account. The session
    // marker prevents a stale callback from consuming an invite in another tab.
    const inviteSignup = searchParams.get('inviteSignup') === '1' && hasInviteOAuthStart();

    if (!code) {
      forgetInviteOAuthStart();
      navigate('/v2/login?oauthError=exchange_failed', { replace: true });
      return;
    }

    axios.post('/api/auth/oauth/exchange', { code })
      .then((res) => {
        const token = (res.data as { token?: string })?.token;
        if (!token) throw new Error('no token');
        if (inviteSignup) forgetInvite();
        forgetInviteOAuthStart();
        signInWithToken(token);
        // In-app inside /v2, which stays mounted. Elsewhere (V1 routes, `/`)
        // keep the full load: V2App's unmount would strip the v2-canvas body
        // class that index.tsx only stamps at boot. `replace` (and
        // location.replace) keeps the spent code out of history, so Back
        // can't re-post it.
        if (/^\/v2(?:[/?#]|$)/.test(next)) navigate(next, { replace: true });
        else window.location.replace(next);
      })
      .catch(() => {
        // Keep the invite for a retry, but do not let a later ordinary login
        // mistake it for a successful invite-bearing signup.
        forgetInviteOAuthStart();
        navigate('/v2/login?oauthError=exchange_failed', { replace: true });
      });
  }, [searchParams, navigate, signInWithToken]);

  return (
    <div className="v2-login">
      <div className="v2-login__card">
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.oauthComplete.title')}</h1>
        <p className="v2-login__subtitle">{t('auth.oauthComplete.subtitle')}</p>
      </div>
    </div>
  );
};

export default V2OAuthComplete;
