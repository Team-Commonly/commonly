import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import axios from '../utils/axiosConfig';
import V2AuthBrand from '../v2/components/V2AuthBrand';
import V2AuthNotice from '../v2/components/V2AuthNotice';

// The link in the verification email lands here (/verify-email?token=…, sent
// on to /v2/verify-email). This was the last navy MUI card on the auth routes;
// it is now the d215 auth card: one "verifying" line, then the server's own
// answer in the notice row. A verified address goes on with the filled key; a
// failure's way out is a plain key, since signing in is not the next step.

interface Result {
  ok: boolean;
  message?: string;
}

const VerifyEmail: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [result, setResult] = useState<Result | null>(null);
  // A token is spent by its first use, so it is sent once: not again when the
  // language changes, and not twice under StrictMode's double effect.
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!token) {
      setResult({ ok: false });
      return;
    }
    if (sent.current === token) return;
    sent.current = token;
    axios
      .get<{ message?: string }>(`/api/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then((res) => setResult({ ok: true, message: res.data?.message }))
      .catch((err: unknown) => {
        const e = err as { response?: { data?: { error?: string } } };
        setResult({ ok: false, message: e.response?.data?.error });
      });
  }, [token]);

  return (
    <div className="v2-login">
      <div className="v2-login__card v2-login__card--stack">
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.verify.title')}</h1>
        {!result ? (
          <p className="v2-login__subtitle">{t('auth.verify.verifying')}</p>
        ) : (
          <>
            <V2AuthNotice kind={result.ok ? 'status' : 'alert'}>
              {result.message || (result.ok ? t('auth.verify.verified') : t('auth.verify.errors.failed'))}
            </V2AuthNotice>
            <button
              type="button"
              className={result.ok ? 'v2-login__submit' : 'v2-login__submit v2-login__submit--ghost'}
              onClick={() => navigate('/v2/login')}
            >
              {t('auth.verify.goToSignIn')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default VerifyEmail;
