import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, type Integration, type Pod } from '@commonly/core';
import { useClient } from '../client';

const BOT_HANDLE = import.meta.env.VITE_TELEGRAM_BOT || 'CommonlyBot';

/**
 * Screen two: connect a channel. Telegram today. The code is minted by the
 * server; the user redeems it inside Telegram; this screen watches the
 * connector flip to connected and sends them to Home.
 */
export function Connect() {
  const { client, session } = useClient();
  const [pod, setPod] = useState<Pod | null>(null);
  const [connector, setConnector] = useState<Integration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const ws = await client.pods.workspace(session.user?._id);
        setPod(ws);
        if (!ws) return;
        const existing = (await client.connectors.list(ws._id)).find((c) => c.type === 'telegram' && c.isActive !== false);
        if (existing) setConnector(existing);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load your workspace.');
      }
    })();
    return () => abort.current?.abort();
  }, [client, session.user?._id]);

  useEffect(() => {
    if (!pod || !connector || connector.status !== 'pending') return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    client.connectors.waitForConnected(pod._id, connector._id, { signal: ctrl.signal }).then((latest) => {
      if (latest && !ctrl.signal.aborted) setConnector(latest);
    });
    return () => ctrl.abort();
  }, [client, pod, connector]);

  const start = async () => {
    if (!pod) return;
    setBusy(true); setError(null);
    try {
      setConnector(await client.connectors.createTelegram(pod._id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the connector.');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!connector) return;
    setBusy(true);
    try { setConnector(await client.connectors.refreshCode(connector._id)); } finally { setBusy(false); }
  };

  const code = connector?.config?.connectCode;
  const expired = connector?.config?.connectCodeExpiresAt ? new Date(connector.config.connectCodeExpiresAt).getTime() < Date.now() : false;
  const command = code ? `/commonly-enable ${code}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked: the code is visible to select */ }
  };

  if (connector?.status === 'connected') {
    return (
      <div className="content content--narrow stack stack--lg">
        <div className="stack">
          <span className="label">Telegram</span>
          <h1 className="title">Connected{connector.config?.chatTitle ? ` to ${connector.config.chatTitle}` : ''}.</h1>
          <p className="lede">Say anything in that chat. Your agent answers there, and everything it does shows up here.</p>
        </div>
        <Link to="/home" className="btn btn--primary btn--lg">See what your agent is doing</Link>
      </div>
    );
  }

  return (
    <div className="content content--narrow stack stack--lg">
      <div className="stack">
        <span className="label">Step 1 of 1</span>
        <h1 className="title">Connect Telegram</h1>
        <p className="lede">Your agent will live in a Telegram chat with you. Three steps, about a minute.</p>
      </div>

      {error && <div className="alert alert--danger" role="alert">{error}</div>}

      {!connector ? (
        <button type="button" className="btn btn--primary btn--lg" onClick={start} disabled={busy || !pod}>
          {busy ? 'One moment…' : 'Get my connect code'}
        </button>
      ) : (
        <ol className="steps" aria-label="Steps">
          <li className="step step--done">
            <span className="step__n">1</span>
            <div className="stack" style={{ gap: 4 }}>
              <p className="heading">Your code is ready</p>
              <div className="code">
                <span>{expired ? 'Code expired' : command}</span>
                {expired
                  ? <button type="button" className="btn btn--sm" onClick={refresh} disabled={busy}>New code</button>
                  : <button type="button" className="btn btn--sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
              </div>
            </div>
          </li>
          <li className="step">
            <span className="step__n">2</span>
            <div className="stack" style={{ gap: 4 }}>
              <p className="heading">Open the bot in Telegram</p>
              <p className="meta">
                <a href={`https://t.me/${BOT_HANDLE}`} target="_blank" rel="noreferrer">@{BOT_HANDLE}</a> — on your phone or desktop. Start a chat with it.
              </p>
            </div>
          </li>
          <li className="step">
            <span className="step__n">3</span>
            <div className="stack" style={{ gap: 4 }}>
              <p className="heading">Paste the command and send</p>
              <p className="meta">The bot replies “Connected” and this page moves on by itself.</p>
              <p className="meta" aria-live="polite">Waiting for Telegram…</p>
            </div>
          </li>
        </ol>
      )}
    </div>
  );
}
