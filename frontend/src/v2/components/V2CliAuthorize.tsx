import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';
import './V2CliAuthorize.css';

interface AuthorizationRequest {
  hostname: string;
  clientName: string;
  clientVersion?: string | null;
  createdAt: string;
}

type Screen = 'code' | 'confirm' | 'done' | 'denied' | 'expired' | 'error';

const normalizeCode = (value: string): string => {
  const compact = value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
};

const errorScreen = (error: unknown): Screen => {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === 410 ? 'expired' : 'error';
};

const V2CliAuthorize: React.FC = () => {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
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
        setScreen(response.data.status === 'denied' ? 'denied' : 'expired');
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

  return (
    <main className="v2-cli-authorize">
      <section className="v2-cli-authorize__card" aria-live="polite">
        <div className="v2-cli-authorize__mark" aria-hidden="true">C</div>
        {loading && <p>Checking your session…</p>}
        {!loading && !isAuthenticated && (
          <>
            <h1>Authorize Commonly CLI</h1>
            <p>Sign in to approve this device. The code stays tied to this browser tab.</p>
            <label className="v2-cli-authorize__field">
              <span>Device code</span>
              <input value={code} disabled aria-label="Device code" />
            </label>
            <Link className="v2-cli-authorize__primary" to={`/v2/login?next=${encodeURIComponent(next)}`}>Sign in to continue</Link>
          </>
        )}
        {!loading && isAuthenticated && screen === 'code' && (
          <form onSubmit={lookup}>
            <h1>Authorize Commonly CLI</h1>
            <p>Enter the code shown in your terminal.</p>
            <label className="v2-cli-authorize__field">
              <span>Device code</span>
              <input
                value={code}
                onChange={(event) => setCode(normalizeCode(event.target.value))}
                placeholder="ABCD-EFGH"
                autoComplete="one-time-code"
                aria-label="Device code"
                required
              />
            </label>
            <button className="v2-cli-authorize__primary" type="submit" disabled={submitting || code.replace('-', '').length !== 8}>
              {submitting ? 'Checking…' : 'Continue'}
            </button>
          </form>
        )}
        {!loading && isAuthenticated && screen === 'confirm' && request && (
          <>
            <h1>Allow this device?</h1>
            <p><strong>{request.hostname}</strong> is asking to use your Commonly account.</p>
            <dl className="v2-cli-authorize__facts">
              <div><dt>Client</dt><dd>{request.clientName}{request.clientVersion ? ` ${request.clientVersion}` : ''}</dd></div>
              <div><dt>Instance</dt><dd>api.commonly.me</dd></div>
              <div><dt>Requested</dt><dd>{new Date(request.createdAt).toLocaleString()}</dd></div>
            </dl>
            <p className="v2-cli-authorize__warning">Only approve a code you requested from your own terminal.</p>
            <div className="v2-cli-authorize__actions">
              <button className="v2-cli-authorize__secondary" type="button" onClick={() => decide('deny')} disabled={submitting}>Deny</button>
              <button className="v2-cli-authorize__primary" type="button" onClick={() => decide('authorize')} disabled={submitting}>
                {submitting ? 'Authorizing…' : 'Authorize'}
              </button>
            </div>
          </>
        )}
        {!loading && isAuthenticated && screen === 'done' && <><h1>Device authorized</h1><p>You can return to your terminal.</p></>}
        {!loading && isAuthenticated && screen === 'denied' && <><h1>Authorization denied</h1><p>No token was issued for this device.</p></>}
        {!loading && isAuthenticated && screen === 'expired' && <><h1>Code expired</h1><p>Return to your terminal and run <code>commonly login</code> again.</p></>}
        {!loading && isAuthenticated && screen === 'error' && <><h1>Couldn’t authorize this device</h1><p>Check the code and try again from your terminal.</p></>}
      </section>
    </main>
  );
};

export default V2CliAuthorize;
