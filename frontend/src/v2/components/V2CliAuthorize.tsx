import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import { ShellGlyph } from '../icons/glyphs';
import { localizeRelativeTime } from '../utils/localizeRelativeTime';
import V2AuthBrand from './V2AuthBrand';
import V2AuthNotice from './V2AuthNotice';
import './V2CliAuthorize.css';

interface AuthorizationRequest {
  hostname: string;
  clientName: string;
  clientVersion?: string | null;
  createdAt: string;
}

type Screen = 'code' | 'confirm' | 'done' | 'denied' | 'expired' | 'used' | 'error';

const normalizeCode = (value: string): string => {
  const compact = value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
};

const errorScreen = (error: unknown): Screen => {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === 410 ? 'expired' : 'error';
};

const currentInstance = () => {
  const baseUrl = String(axios.defaults.baseURL || window.location.origin);
  try { return new URL(baseUrl, window.location.origin).host; } catch { return baseUrl; }
};

const V2CliAuthorize: React.FC = () => {
  const { t } = useTranslation();
  const { isAuthenticated, loading, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryCode = useMemo(() => normalizeCode(new URLSearchParams(location.search).get('code') || ''), [location.search]);
  const [code, setCode] = useState(queryCode);
  const [screen, setScreen] = useState<Screen>('code');
  const [request, setRequest] = useState<AuthorizationRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setCode(queryCode), [queryCode]);

  // The page mounts outside V2App, so it claims the v2 page canvas itself
  // while mounted (index.tsx stamps it at boot for this path, too). Without
  // it App.css's legacy V1 input, button and form rules reach the card.
  useEffect(() => {
    document.body.classList.add('v2-canvas');
    return () => {
      document.body.classList.remove('v2-canvas');
    };
  }, []);

  const lookup = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (code.replace('-', '').length !== 8) return;
    setSubmitting(true);
    try {
      const response = await axios.post<{ status: string; request?: AuthorizationRequest }>('/api/auth/device/authorize', {
        userCode: code,
      });
      if (response.data.status === 'pending' && response.data.request) {
        setRequest(response.data.request);
        setScreen('confirm');
      } else {
        setScreen(
          response.data.status === 'denied'
            ? 'denied'
            : response.data.status === 'consumed' || response.data.status === 'authorized'
              ? 'used'
              : 'expired',
        );
      }
    } catch (error) {
      setScreen(errorScreen(error));
    } finally {
      setSubmitting(false);
    }
  };

  const decide = async (decision: 'authorize' | 'deny') => {
    setSubmitting(true);
    try {
      const response = await axios.post<{ status: string }>('/api/auth/device/authorize', {
        userCode: code,
        decision,
      });
      setScreen(response.data.status === 'authorized' ? 'done' : 'denied');
    } catch (error) {
      setScreen(errorScreen(error));
    } finally {
      setSubmitting(false);
    }
  };

  const next = `/cli/authorize${code ? `?code=${encodeURIComponent(code)}` : ''}`;

  // Layout: the d215 s-cli-authorize frames. The sign-in card family: brand
  // row, title, one prose line, the code as the field, one key per state.
  // The page mounts outside V2App, so it carries its own .v2-root.
  const card = (children: React.ReactNode) => (
    <main className="v2-root v2-cli-authorize">
      <div className="v2-login">
        <div className="v2-login__card v2-login__card--stack" aria-live="polite">
          <V2AuthBrand />
          {children}
        </div>
      </div>
    </main>
  );
  const outcome = (title: string, message: React.ReactNode, kind: 'alert' | 'status' = 'status') => card(
    <>
      <h1 className="v2-login__title">{title}</h1>
      <V2AuthNotice kind={kind}>{message}</V2AuthNotice>
    </>,
  );

  if (loading) {
    return card(<p className="v2-login__subtitle" role="status">{t('cliAuthorize.checkingSession')}</p>);
  }

  if (!isAuthenticated) {
    return card(
      <>
        <h1 className="v2-login__title">{t('cliAuthorize.title')}</h1>
        <p className="v2-login__subtitle">{t('cliAuthorize.signInLead')}</p>
        <label className="v2-login__field">
          <span className="v2-login__label">{t('cliAuthorize.deviceCode')}</span>
          <input className="v2-login__input v2-cli-authorize__code" value={code} disabled aria-label={t('cliAuthorize.deviceCode')} />
        </label>
        <button
          className="v2-login__submit"
          type="button"
          onClick={() => navigate(`/v2/login?next=${encodeURIComponent(next)}`)}
        >
          {t('cliAuthorize.signInContinue')}
        </button>
      </>,
    );
  }

  if (screen === 'code') {
    return card(
      <form onSubmit={lookup}>
        <h1 className="v2-login__title">{t('cliAuthorize.title')}</h1>
        <p className="v2-login__subtitle">{t('cliAuthorize.enterCode')}</p>
        <label className="v2-login__field">
          <span className="v2-login__label">{t('cliAuthorize.deviceCode')}</span>
          <input
            className="v2-login__input v2-cli-authorize__code"
            value={code}
            onChange={(event) => setCode(normalizeCode(event.target.value))}
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
            aria-label={t('cliAuthorize.deviceCode')}
            required
          />
        </label>
        <button className="v2-login__submit" type="submit" disabled={submitting || code.replace('-', '').length !== 8}>
          {t(submitting ? 'cliAuthorize.checking' : 'cliAuthorize.continue')}
        </button>
      </form>,
    );
  }

  if (screen === 'confirm' && request) {
    return card(
      <>
        <h1 className="v2-login__title">
          {/* Both names stay out of the string: Trans would parse them as markup and as a template. */}
          <Trans
            i18nKey="cliAuthorize.confirmTitle"
            components={{
              host: <span className="v2-cli-authorize__host">{request.hostname}</span>,
              user: <>{user?.username || t('cliAuthorize.fallbackUser')}</>,
            }}
          />
        </h1>
        <p className="v2-login__subtitle">{t('cliAuthorize.confirmLead')}</p>
        <dl className="v2-cli-authorize__facts">
          <div><dt>{t('cliAuthorize.client')}</dt><dd>{request.clientName}{request.clientVersion ? ` ${request.clientVersion}` : ''}</dd></div>
          <div><dt>{t('cliAuthorize.instance')}</dt><dd>{currentInstance()}</dd></div>
          <div><dt>{t('cliAuthorize.requested')}</dt><dd>{localizeRelativeTime(request.createdAt, t, { includeFuture: false, rounding: 'floor' })}</dd></div>
        </dl>
        <div className="v2-login__notice" role="note">
          <ShellGlyph name="info" />
          <span>{t('cliAuthorize.approveWarning')}</span>
        </div>
        <div className="v2-cli-authorize__keys">
          <button className="v2-login__submit v2-login__submit--ghost" type="button" onClick={() => decide('deny')} disabled={submitting}>
            {t('cliAuthorize.deny')}
          </button>
          <button className="v2-login__submit" type="button" onClick={() => decide('authorize')} disabled={submitting}>
            {t(submitting ? 'cliAuthorize.authorizing' : 'cliAuthorize.authorize')}
          </button>
        </div>
      </>,
    );
  }

  if (screen === 'done') return outcome(t('cliAuthorize.doneTitle'), t('cliAuthorize.doneBody'));
  if (screen === 'denied') return outcome(t('cliAuthorize.deniedTitle'), t('cliAuthorize.deniedBody'));
  if (screen === 'expired') {
    return outcome(t('cliAuthorize.expiredTitle'), <Trans i18nKey="cliAuthorize.expiredBody" components={{ code: <code /> }} />);
  }
  if (screen === 'used') {
    return outcome(t('cliAuthorize.usedTitle'), t('cliAuthorize.usedBody'));
  }
  if (screen === 'error') {
    return outcome(t('cliAuthorize.errorTitle'), t('cliAuthorize.errorBody'), 'alert');
  }
  return card(null);
};

export default V2CliAuthorize;
