import React, { useEffect, useMemo, useState } from 'react';
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

const requestAge = (createdAt: string): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
};

const currentInstance = () => {
  const baseUrl = String(axios.defaults.baseURL || window.location.origin);
  try { return new URL(baseUrl, window.location.origin).host; } catch { return baseUrl; }
};

const V2CliAuthorize: React.FC = () => {
  const { isAuthenticated, loading, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryCode = useMemo(() => normalizeCode(new URLSearchParams(location.search).get('code') || ''), [location.search]);
  const [code, setCode] = useState(queryCode);
  const [screen, setScreen] = useState<Screen>('code');
  const [request, setRequest] = useState<AuthorizationRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setCode(queryCode), [queryCode]);

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
    return card(<p className="v2-login__subtitle" role="status">Checking your session…</p>);
  }

  if (!isAuthenticated) {
    return card(
      <>
        <h1 className="v2-login__title">Authorize Commonly CLI</h1>
        <p className="v2-login__subtitle">Sign in to approve this device. The code stays tied to this browser tab.</p>
        <label className="v2-login__field">
          <span className="v2-login__label">Device code</span>
          <input className="v2-login__input v2-cli-authorize__code" value={code} disabled aria-label="Device code" />
        </label>
        <button
          className="v2-login__submit"
          type="button"
          onClick={() => navigate(`/v2/login?next=${encodeURIComponent(next)}`)}
        >
          Sign in to continue
        </button>
      </>,
    );
  }

  if (screen === 'code') {
    return card(
      <form onSubmit={lookup}>
        <h1 className="v2-login__title">Authorize Commonly CLI</h1>
        <p className="v2-login__subtitle">Enter the code shown in your terminal.</p>
        <label className="v2-login__field">
          <span className="v2-login__label">Device code</span>
          <input
            className="v2-login__input v2-cli-authorize__code"
            value={code}
            onChange={(event) => setCode(normalizeCode(event.target.value))}
            placeholder="ABCD-EFGH"
            autoComplete="one-time-code"
            aria-label="Device code"
            required
          />
        </label>
        <button className="v2-login__submit" type="submit" disabled={submitting || code.replace('-', '').length !== 8}>
          {submitting ? 'Checking…' : 'Continue'}
        </button>
      </form>,
    );
  }

  if (screen === 'confirm' && request) {
    return card(
      <>
        <h1 className="v2-login__title">
          Authorize <span className="v2-cli-authorize__host">{request.hostname}</span> as @{user?.username || 'you'}?
        </h1>
        <p className="v2-login__subtitle">This device is asking to use your Commonly account.</p>
        <dl className="v2-cli-authorize__facts">
          <div><dt>Client</dt><dd>{request.clientName}{request.clientVersion ? ` ${request.clientVersion}` : ''}</dd></div>
          <div><dt>Instance</dt><dd>{currentInstance()}</dd></div>
          <div><dt>Requested</dt><dd>{requestAge(request.createdAt)}</dd></div>
        </dl>
        <div className="v2-login__notice" role="note">
          <ShellGlyph name="info" />
          <span>Only approve a code you requested from your own terminal.</span>
        </div>
        <div className="v2-cli-authorize__keys">
          <button className="v2-login__submit v2-login__submit--ghost" type="button" onClick={() => decide('deny')} disabled={submitting}>
            Deny
          </button>
          <button className="v2-login__submit" type="button" onClick={() => decide('authorize')} disabled={submitting}>
            {submitting ? 'Authorizing…' : 'Authorize'}
          </button>
        </div>
      </>,
    );
  }

  if (screen === 'done') return outcome('Device authorized', 'You can return to your terminal.');
  if (screen === 'denied') return outcome('Authorization denied', 'No token was issued for this device.');
  if (screen === 'expired') {
    return outcome('Code expired', <>Return to your terminal and run <code>commonly login</code> again.</>);
  }
  if (screen === 'used') {
    return outcome('Code already used', 'This code was already approved or completed. Return to your terminal.');
  }
  if (screen === 'error') {
    return outcome('Couldn’t authorize this device', 'Check the code and try again from your terminal.', 'alert');
  }
  return card(null);
};

export default V2CliAuthorize;
