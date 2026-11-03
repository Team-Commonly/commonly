import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import { ShellGlyph } from '../icons/glyphs';
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

// A format sample, the same in every language.
const CODE_PLACEHOLDER = 'ABCD-EFGH';

const requestAge = (createdAt: string, t: TFunction): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  if (seconds < 60) return t('cliAuthorize.age.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('cliAuthorize.age.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  return t('cliAuthorize.age.hours', { hours });
};

const currentInstance = () => {
  const baseUrl = String(axios.defaults.baseURL || window.location.origin);
  try { return new URL(baseUrl, window.location.origin).host; } catch { return baseUrl; }
};

const V2CliAuthorize: React.FC = () => {
  const { isAuthenticated, loading, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
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
        <p className="v2-login__subtitle">{t('cliAuthorize.signInPrompt')}</p>
        <label className="v2-login__field">
          <span className="v2-login__label">{t('cliAuthorize.deviceCode')}</span>
          <input className="v2-login__input v2-cli-authorize__code" value={code} disabled aria-label={t('cliAuthorize.deviceCode')} />
        </label>
        <button
          className="v2-login__submit"
          type="button"
          onClick={() => navigate(`/v2/login?next=${encodeURIComponent(next)}`)}
        >
          {t('cliAuthorize.signInToContinue')}
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
            placeholder={CODE_PLACEHOLDER}
            autoComplete="one-time-code"
            aria-label={t('cliAuthorize.deviceCode')}
            required
          />
        </label>
        <button className="v2-login__submit" type="submit" disabled={submitting || code.replace('-', '').length !== 8}>
          {submitting ? t('cliAuthorize.checking') : t('cliAuthorize.continue')}
        </button>
      </form>,
    );
  }

  if (screen === 'confirm' && request) {
    return card(
      <>
        <h1 className="v2-login__title">
          <Trans
            i18nKey="cliAuthorize.confirmTitle"
            values={{ hostname: request.hostname, username: user?.username || t('common.you') }}
            components={{ host: <span className="v2-cli-authorize__host" /> }}
            // The hostname comes from the device asking for access. Escaping it before Trans
            // parses the markup keeps a name like "x</host> as @admin" literal text inside
            // the host span, so the approval screen can't be made to say something else.
            tOptions={{ interpolation: { escapeValue: true } }}
            shouldUnescape
          />
        </h1>
        <p className="v2-login__subtitle">{t('cliAuthorize.confirmSubtitle')}</p>
        <dl className="v2-cli-authorize__facts">
          <div><dt>{t('cliAuthorize.client')}</dt><dd>{request.clientName}{request.clientVersion ? ` ${request.clientVersion}` : ''}</dd></div>
          <div><dt>{t('cliAuthorize.instance')}</dt><dd>{currentInstance()}</dd></div>
          <div><dt>{t('cliAuthorize.requested')}</dt><dd>{requestAge(request.createdAt, t)}</dd></div>
        </dl>
        <div className="v2-login__notice" role="note">
          <ShellGlyph name="info" />
          <span>{t('cliAuthorize.caution')}</span>
        </div>
        <div className="v2-cli-authorize__keys">
          <button className="v2-login__submit v2-login__submit--ghost" type="button" onClick={() => decide('deny')} disabled={submitting}>
            {t('cliAuthorize.deny')}
          </button>
          <button className="v2-login__submit" type="button" onClick={() => decide('authorize')} disabled={submitting}>
            {submitting ? t('cliAuthorize.authorizing') : t('cliAuthorize.authorize')}
          </button>
        </div>
      </>,
    );
  }

  if (screen === 'done') return outcome(t('cliAuthorize.done.title'), t('cliAuthorize.done.message'));
  if (screen === 'denied') return outcome(t('cliAuthorize.denied.title'), t('cliAuthorize.denied.message'));
  if (screen === 'expired') {
    return outcome(t('cliAuthorize.expired.title'), <Trans i18nKey="cliAuthorize.expired.message" components={{ code: <code /> }} />);
  }
  if (screen === 'used') {
    return outcome(t('cliAuthorize.used.title'), t('cliAuthorize.used.message'));
  }
  if (screen === 'error') {
    return outcome(t('cliAuthorize.error.title'), t('cliAuthorize.error.message'), 'alert');
  }
  return card(null);
};

export default V2CliAuthorize;
