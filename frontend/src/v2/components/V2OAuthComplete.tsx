import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import V2AuthBrand from './V2AuthBrand';
import { safeNextPath } from '../utils/safeNextPath';
import { useTranslation } from 'react-i18next';

// Landing pad for the OAuth redirect chain. The backend callback hands us a
// short-lived one-time code (never the JWT itself — it would end up in
// browser history and server logs); we swap it for a session here, hand it to
// AuthContext, and navigate in-app the way email sign-in does. A full-page
// navigation here used to re-download and re-boot the whole app on the path
// most new people take (OAuth is 93% of outside signups).
const V2OAuthComplete: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signInWithToken } = useAuth();
  const fired = useRef(false); // StrictMode double-mount guard — the code is single-use
  const { t } = useTranslation();

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const code = searchParams.get('code') || '';
    const next = safeNextPath(searchParams.get('next')) || '/v2';

    if (!code) {
      navigate('/v2/login?oauthError=exchange_failed', { replace: true });
      return;
    }

    axios.post('/api/auth/oauth/exchange', { code })
      .then((res) => {
        const token = (res.data as { token?: string })?.token;
        if (!token) throw new Error('no token');
        signInWithToken(token);
        navigate(next, { replace: true });
      })
      .catch(() => {
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
