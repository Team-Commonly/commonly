import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import V2AuthBrand from './V2AuthBrand';

// Landing pad for the OAuth redirect chain. The backend callback hands us a
// short-lived one-time code (never the JWT itself — it would end up in
// browser history and server logs); we swap it for a session here, then do
// a full-page navigation so AuthContext rehydrates from localStorage the
// same way every other login path does.
const V2OAuthComplete: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const fired = useRef(false); // StrictMode double-mount guard — the code is single-use

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const code = searchParams.get('code') || '';
    const nextParam = searchParams.get('next') || '/v2';
    const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/v2';

    if (!code) {
      navigate('/v2/login?oauthError=exchange_failed', { replace: true });
      return;
    }

    axios.post('/api/auth/oauth/exchange', { code })
      .then((res) => {
        const token = (res.data as { token?: string })?.token;
        if (!token) throw new Error('no token');
        localStorage.setItem('token', token);
        window.location.replace(next);
      })
      .catch(() => {
        navigate('/v2/login?oauthError=exchange_failed', { replace: true });
      });
  }, [searchParams, navigate]);

  return (
    <div className="v2-login">
      <div className="v2-login__card">
        <V2AuthBrand />
        <h1 className="v2-login__title">Signing you in…</h1>
        <p className="v2-login__subtitle">Completing sign-in with your provider.</p>
      </div>
    </div>
  );
};

export default V2OAuthComplete;
